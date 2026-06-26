import { Storage } from "@google-cloud/storage";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import pg from "pg";

const { Pool } = pg;

const SIDECAR = "http://127.0.0.1:1106";

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

const endpoint = process.env.DO_SPACES_ENDPOINT;
const key = process.env.DO_SPACES_KEY;
const secret = process.env.DO_SPACES_SECRET;
const doBucket = process.env.DO_SPACES_BUCKET;

if (!endpoint || !key || !secret || !doBucket) {
  throw new Error("DO_SPACES_ENDPOINT, DO_SPACES_KEY, DO_SPACES_SECRET, DO_SPACES_BUCKET must all be set");
}

// DO Spaces endpoint may include https:// already; ensure it does and strip trailing slashes
const endpointUrl = endpoint.startsWith("http") ? endpoint.replace(/\/$/, "") : `https://${endpoint}`;

const s3 = new S3Client({
  endpoint: endpointUrl,
  region: "us-east-1",
  credentials: { accessKeyId: key, secretAccessKey: secret },
  forcePathStyle: false,
});

async function downloadFromGcs(gcsPath: string): Promise<Buffer> {
  const rest = gcsPath.slice("gcs://".length);
  const slash = rest.indexOf("/");
  const bucketId = rest.slice(0, slash);
  const objectName = rest.slice(slash + 1);
  const [buf] = await gcs.bucket(bucketId).file(objectName).download();
  return buf as Buffer;
}

async function uploadToDo(buf: Buffer, doKey: string): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: doBucket,
    Key: doKey,
    Body: buf,
    ContentType: "application/pdf",
    ACL: "private",
  }));
}

function gcsPathToDoPath(gcsPath: string): string {
  const rest = gcsPath.slice("gcs://".length);
  const slash = rest.indexOf("/");
  return rest.slice(slash + 1);
}

function doPath(objectKey: string): string {
  return `do-spaces://${doBucket}/${objectKey}`;
}

// -- Source DB (Replit Postgres, has existing documents)
const srcPool = new Pool({ connectionString: process.env.DATABASE_URL });

// -- Destination DB (DigitalOcean Postgres)
const rawDo = (process.env.DO_DATABASE_URL ?? "").replace(/([?&])sslmode=[^&]*/g, "$1").replace(/[?&]$/, "");
const dstPool = new Pool({ connectionString: rawDo, ssl: { rejectUnauthorized: false } });

const docs = await srcPool.query<{ id: string; filepath: string; sealed_pdf_path: string | null }>(
  "SELECT id, filepath, sealed_pdf_path FROM documents WHERE filepath IS NOT NULL"
);
console.log(`Found ${docs.rows.length} document(s) to migrate.`);

for (const doc of docs.rows) {
  console.log(`\n── Document ${doc.id}`);

  // Migrate main file
  const mainKey = gcsPathToDoPath(doc.filepath);
  console.log(`  Downloading main file from GCS: ${doc.filepath}`);
  const mainBuf = await downloadFromGcs(doc.filepath);
  console.log(`  Uploading ${mainBuf.byteLength} bytes to DO Spaces: ${mainKey}`);
  await uploadToDo(mainBuf, mainKey);
  const newFilepath = doPath(mainKey);

  // Migrate sealed PDF if present
  let newSealedPath: string | null = null;
  if (doc.sealed_pdf_path?.startsWith("gcs://")) {
    const sealedKey = gcsPathToDoPath(doc.sealed_pdf_path);
    console.log(`  Downloading sealed PDF from GCS: ${doc.sealed_pdf_path}`);
    const sealedBuf = await downloadFromGcs(doc.sealed_pdf_path);
    console.log(`  Uploading ${sealedBuf.byteLength} bytes to DO Spaces: ${sealedKey}`);
    await uploadToDo(sealedBuf, sealedKey);
    newSealedPath = doPath(sealedKey);
  }

  // Update the destination DB with new paths
  await dstPool.query(
    "UPDATE documents SET filepath = $1, sealed_pdf_path = $2 WHERE id = $3",
    [newFilepath, newSealedPath, doc.id]
  );
  console.log(`  ✓ Updated DO DB: filepath=${newFilepath}`);
  if (newSealedPath) console.log(`  ✓ Updated DO DB: sealed_pdf_path=${newSealedPath}`);
}

// Copy all other tables from source to destination
console.log("\n── Copying users, documents metadata, recipients, fields, events...");

const tables = [
  "users",
  "documents",
  "recipients",
  "signature_fields",
  "document_events",
  "password_reset_tokens",
];

for (const table of tables) {
  const rows = await srcPool.query(`SELECT * FROM "${table}"`);
  if (rows.rows.length === 0) { console.log(`  ${table}: empty, skipping`); continue; }

  // Build INSERT with ON CONFLICT DO NOTHING
  const cols = Object.keys(rows.rows[0]).map(c => `"${c}"`).join(", ");
  const placeholders = Object.keys(rows.rows[0]).map((_, i) => `$${i + 1}`).join(", ");
  const values = rows.rows.map(r => Object.values(r));

  let inserted = 0;
  for (const row of values) {
    await dstPool.query(
      `INSERT INTO "${table}" (${cols}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
      row
    ).catch((e: unknown) => console.warn(`  WARN ${table}: ${(e as Error).message}`));
    inserted++;
  }
  console.log(`  ${table}: ${inserted} rows inserted`);
}

// Fix file paths in documents table (replace gcs:// with do-spaces://)
console.log("\n── Fixing remaining gcs:// paths in documents table on DO DB...");
const toFix = await dstPool.query<{ id: string; filepath: string; sealed_pdf_path: string | null }>(
  "SELECT id, filepath, sealed_pdf_path FROM documents WHERE filepath LIKE 'gcs://%' OR sealed_pdf_path LIKE 'gcs://%'"
);
for (const row of toFix.rows) {
  const fp = row.filepath?.startsWith("gcs://") ? doPath(gcsPathToDoPath(row.filepath)) : row.filepath;
  const sp = row.sealed_pdf_path?.startsWith("gcs://") ? doPath(gcsPathToDoPath(row.sealed_pdf_path)) : row.sealed_pdf_path;
  await dstPool.query("UPDATE documents SET filepath=$1, sealed_pdf_path=$2 WHERE id=$3", [fp, sp, row.id]);
  console.log(`  Fixed paths for document ${row.id}`);
}

await srcPool.end();
await dstPool.end();
console.log("\n✅ Migration complete.");
