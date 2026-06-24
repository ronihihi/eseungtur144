import { Storage } from "@google-cloud/storage";
import type { Response } from "express";

let _gcsClient: Storage | null = null;

function getGcsClient(): Storage {
  if (_gcsClient) return _gcsClient;
  const b64 = process.env.GCP_SA_KEY_B64;
  if (!b64) throw new Error("GCP_SA_KEY_B64 is not set — file storage is unavailable.");
  const creds = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
    project_id: string;
  };
  _gcsClient = new Storage({ projectId: creds.project_id, credentials: creds });
  return _gcsClient;
}

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
  const bucket = getGcsClient().bucket(bucketId);
  const file = bucket.file(objectName);
  await file.save(buffer, { contentType, resumable: false });
  return makeGcsPath(objectName);
}

export async function downloadFromGcs(gcsPath: string): Promise<Buffer> {
  const { bucketId, objectName } = parseGcsPath(gcsPath);
  const bucket = getGcsClient().bucket(bucketId);
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
  const bucket = getGcsClient().bucket(bucketId);
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
