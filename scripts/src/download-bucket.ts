import { Storage } from "@google-cloud/storage";
import { createWriteStream, mkdirSync } from "fs";
import { dirname } from "path";

const SIDECAR = "http://127.0.0.1:1106";

const storage = new Storage({
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
  } as never,
  projectId: "",
});

const BUCKET = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
if (!BUCKET) throw new Error("DEFAULT_OBJECT_STORAGE_BUCKET_ID not set");

const bucket = storage.bucket(BUCKET);

const [files] = await bucket.getFiles();
console.log(`found ${files.length} objects`);

let bytes = 0;
for (const file of files) {
  const dest = `./bucket-export/${file.name}`;
  mkdirSync(dirname(dest), { recursive: true });
  await new Promise<void>((res, rej) =>
    file
      .createReadStream()
      .on("error", rej)
      .pipe(createWriteStream(dest).on("finish", res).on("error", rej))
  );
  const size = Number(file.metadata.size ?? 0);
  bytes += size;
  console.log(`  ✓ ${file.name} (${size} bytes)`);
}
console.log(`\ndownloaded ${files.length} objects — ${bytes} bytes total`);
