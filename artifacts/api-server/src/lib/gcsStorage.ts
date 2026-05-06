import { Storage } from "@google-cloud/storage";
import type { Response } from "express";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

const gcsClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: "json",
        subject_token_field_name: "access_token",
      },
    },
    universe_domain: "googleapis.com",
  } as Parameters<typeof Storage>[0]["credentials"],
  projectId: "",
});

function getBucketId(): string {
  const id = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  if (!id) throw new Error("DEFAULT_OBJECT_STORAGE_BUCKET_ID not set");
  return id;
}

export function makeGcsPath(objectName: string): string {
  return `gcs://${getBucketId()}/${objectName}`;
}

export function isGcsPath(filepath: string): boolean {
  return filepath.startsWith("gcs://");
}

function parseGcsPath(gcsPath: string): { bucketId: string; objectName: string } {
  const withoutProtocol = gcsPath.slice("gcs://".length);
  const slashIdx = withoutProtocol.indexOf("/");
  const bucketId = withoutProtocol.slice(0, slashIdx);
  const objectName = withoutProtocol.slice(slashIdx + 1);
  return { bucketId, objectName };
}

export async function uploadToGcs(
  buffer: Buffer,
  objectName: string,
  contentType: string
): Promise<string> {
  const bucketId = getBucketId();
  const bucket = gcsClient.bucket(bucketId);
  const file = bucket.file(objectName);
  await file.save(buffer, { contentType, resumable: false });
  return makeGcsPath(objectName);
}

export async function downloadFromGcs(gcsPath: string): Promise<Buffer> {
  const { bucketId, objectName } = parseGcsPath(gcsPath);
  const bucket = gcsClient.bucket(bucketId);
  const file = bucket.file(objectName);
  const [contents] = await file.download();
  return contents;
}

export async function streamFromGcs(
  gcsPath: string,
  res: Response,
  contentType: string
): Promise<void> {
  const { bucketId, objectName } = parseGcsPath(gcsPath);
  const bucket = gcsClient.bucket(bucketId);
  const file = bucket.file(objectName);
  res.set("Content-Type", contentType);
  res.set("Cache-Control", "private, max-age=300");
  return new Promise((resolve, reject) => {
    const stream = file.createReadStream();
    stream.on("error", reject);
    stream.on("end", resolve);
    stream.pipe(res);
  });
}
