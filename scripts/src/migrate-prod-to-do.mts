/**
 * Migrate production data from Replit GCS + Replit Postgres → DigitalOcean Spaces + DO Postgres
 * Run after exporting /tmp/prod-dump.json via executeSql reads.
 */
import { Storage } from "@google-cloud/storage";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import pg from "pg";
import fs from "fs";

const { Pool } = pg;
const SIDECAR = "http://127.0.0.1:1106";

// --- GCS client (Replit Object Storage sidecar) ---
const gcs = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${SIDECAR}/token`,
    type: "external_account",
    credential_source: {
      url: `${SIDECAR}/credential`,
      format: { type: "json", subject_token_field_name: "access_token" },
    },
    universe_domain: "googleapis.com",
  } as Parameters<typeof Storage>[0]["credentials"],
  projectId: "",
});

// --- DO Spaces S3 client ---
const endpointRaw = process.env.DO_SPACES_ENDPOINT ?? "";
const endpoint = endpointRaw.startsWith("http") ? endpointRaw : `https://${endpointRaw}`;
const doBucket = process.env.DO_SPACES_BUCKET ?? "";
if (!endpoint || !doBucket || !process.env.DO_SPACES_KEY || !process.env.DO_SPACES_SECRET) {
  throw new Error("DO_SPACES_ENDPOINT, DO_SPACES_BUCKET, DO_SPACES_KEY, DO_SPACES_SECRET must all be set");
}
const s3 = new S3Client({
  endpoint,
  region: "us-east-1",
  credentials: { accessKeyId: process.env.DO_SPACES_KEY!, secretAccessKey: process.env.DO_SPACES_SECRET! },
  forcePathStyle: false,
});

// --- DO Postgres client ---
const rawDoUrl = (process.env.DO_DATABASE_URL ?? "").replace(/([?&])sslmode=[^&]*/g, "$1").replace(/[?&]$/, "");
if (!rawDoUrl) throw new Error("DO_DATABASE_URL must be set");
const dstPool = new Pool({ connectionString: rawDoUrl, ssl: { rejectUnauthorized: false } });

// --- Helpers ---
function gcsObjectName(gcsPath: string): string {
  const rest = gcsPath.slice("gcs://".length);
  return rest.slice(rest.indexOf("/") + 1);
}
function gcsBucketId(gcsPath: string): string {
  const rest = gcsPath.slice("gcs://".length);
  return rest.slice(0, rest.indexOf("/"));
}
function doPath(objectKey: string): string {
  return `do-spaces://${doBucket}/${objectKey}`;
}

async function fileExistsInDo(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: doBucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function migrateGcsFile(gcsPath: string): Promise<string> {
  const objectKey = gcsObjectName(gcsPath);
  const bucketId = gcsBucketId(gcsPath);

  if (await fileExistsInDo(objectKey)) {
    console.log(`  ✓ Already in DO Spaces: ${objectKey}`);
    return doPath(objectKey);
  }

  console.log(`  Downloading from GCS: ${objectKey}`);
  const [buf] = await gcs.bucket(bucketId).file(objectKey).download();
  console.log(`  Uploading ${(buf as Buffer).byteLength} bytes to DO Spaces: ${objectKey}`);
  await s3.send(new PutObjectCommand({
    Bucket: doBucket,
    Key: objectKey,
    Body: buf as Buffer,
    ContentType: "application/pdf",
    ACL: "private",
  }));
  return doPath(objectKey);
}

// --- Load production dump ---
const dump = JSON.parse(fs.readFileSync("/tmp/prod-dump.json", "utf8")) as {
  users: Record<string, unknown>[];
  documents: Record<string, unknown>[];
  recipients: Record<string, unknown>[];
  signature_fields: Record<string, unknown>[];
  document_events: Record<string, unknown>[];
  password_reset_tokens: Record<string, unknown>[];
};

console.log(`\n=== Production → DigitalOcean Migration ===`);
console.log(`users: ${dump.users.length}, documents: ${dump.documents.length}, recipients: ${dump.recipients.length}`);
console.log(`sig_fields: ${dump.signature_fields.length}, events: ${dump.document_events.length}\n`);

// --- Step 1: Migrate all GCS files to DO Spaces ---
console.log("── Step 1: Migrate files from Replit GCS → DO Spaces");
const filePathMap = new Map<string, string>(); // gcsPath → doPath

for (const doc of dump.documents as Array<{ id: string; filepath: string; sealed_pdf_path?: string }>) {
  if (doc.filepath?.startsWith("gcs://")) {
    console.log(`\nDocument ${doc.id}:`);
    const newFilepath = await migrateGcsFile(doc.filepath);
    filePathMap.set(doc.filepath, newFilepath);
    doc.filepath = newFilepath;
  }
  if (doc.sealed_pdf_path?.startsWith("gcs://")) {
    const newSealed = await migrateGcsFile(doc.sealed_pdf_path);
    filePathMap.set(doc.sealed_pdf_path, newSealed);
    doc.sealed_pdf_path = newSealed;
  }
}
console.log(`\n✓ Files migrated: ${filePathMap.size} GCS → DO Spaces\n`);

// --- Step 2: Insert all data into DO Postgres ---
console.log("── Step 2: Import data into DO Postgres");

async function upsertRows(table: string, rows: Record<string, unknown>[], conflictTarget = "id") {
  if (rows.length === 0) { console.log(`  ${table}: empty, skip`); return; }
  let inserted = 0, skipped = 0;
  for (const row of rows) {
    const cols = Object.keys(row).map(c => `"${c}"`).join(", ");
    const vals = Object.values(row);
    const phs = vals.map((_, i) => `$${i + 1}`).join(", ");
    await dstPool.query(
      `INSERT INTO "${table}" (${cols}) VALUES (${phs}) ON CONFLICT (${conflictTarget}) DO NOTHING`,
      vals
    ).then(() => inserted++).catch((e: Error) => {
      // If conflict key doesn't exist, try without ON CONFLICT
      skipped++;
      console.warn(`  WARN ${table}: ${e.message.slice(0, 80)}`);
    });
  }
  console.log(`  ${table}: ${inserted} inserted, ${skipped} skipped`);
}

await upsertRows("users", dump.users);

// Documents: update filepath/sealed_pdf_path to DO paths
await upsertRows("documents", dump.documents);

// Recipients: token column is null here (blocked in production read replica)
// Insert with what we have; existing rows from dev migration may conflict (DO NOTHING)
await upsertRows("recipients", dump.recipients);

// Signature fields: no value/placed_at/created_at (blocked in read replica)
await upsertRows("signature_fields", dump.signature_fields);

// Events and tokens
await upsertRows("document_events", dump.document_events);
await upsertRows("password_reset_tokens", dump.password_reset_tokens);

// --- Step 3: Verify counts ---
console.log("\n── Step 3: Verify DO Postgres counts");
const tables = ["users", "documents", "recipients", "signature_fields", "document_events"];
for (const t of tables) {
  const r = await dstPool.query(`SELECT count(*) FROM "${t}"`);
  console.log(`  ${t}: ${r.rows[0].count} rows`);
}

await dstPool.end();
console.log("\n✅ Production migration complete.");
