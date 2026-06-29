import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import type { Response } from "express";

const DO_PREFIX = "do-spaces://";

function getClient(): S3Client {
  const endpointRaw = process.env.DO_SPACES_ENDPOINT;
  const key = process.env.DO_SPACES_KEY;
  const secret = process.env.DO_SPACES_SECRET;
  if (!endpointRaw || !key || !secret) {
    throw new Error("DO_SPACES_ENDPOINT, DO_SPACES_KEY, and DO_SPACES_SECRET must be set");
  }
  // Ensure endpoint is a full URL (add https:// if missing)
  const endpoint = endpointRaw.startsWith("http") ? endpointRaw : `https://${endpointRaw}`;
  return new S3Client({
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: key, secretAccessKey: secret },
    forcePathStyle: false,
  });
}

function getBucket(): string {
  const b = process.env.DO_SPACES_BUCKET;
  if (!b) throw new Error("DO_SPACES_BUCKET must be set");
  return b;
}

export function makeGcsPath(objectName: string): string {
  return `${DO_PREFIX}${getBucket()}/${objectName}`;
}

export function isGcsPath(filepath: string): boolean {
  return filepath.startsWith(DO_PREFIX) || filepath.startsWith("gcs://");
}

function parsePath(storagePath: string): { bucket: string; key: string } {
  if (storagePath.startsWith(DO_PREFIX)) {
    const rest = storagePath.slice(DO_PREFIX.length);
    const slash = rest.indexOf("/");
    return { bucket: rest.slice(0, slash), key: rest.slice(slash + 1) };
  }
  if (storagePath.startsWith("gcs://")) {
    const rest = storagePath.slice("gcs://".length);
    const slash = rest.indexOf("/");
    return { bucket: getBucket(), key: rest.slice(slash + 1) };
  }
  throw new Error(`Unknown storage path format: ${storagePath}`);
}

export async function uploadToGcs(
  buffer: Buffer,
  objectName: string,
  contentType: string
): Promise<string> {
  const bucket = getBucket();
  await getClient().send(new PutObjectCommand({
    Bucket: bucket,
    Key: objectName,
    Body: buffer,
    ContentType: contentType,
    ACL: "private",
  }));
  return makeGcsPath(objectName);
}

export class StorageFileNotFoundError extends Error {
  constructor(storagePath: string) {
    super(`File not found in storage: ${storagePath}`);
    this.name = "StorageFileNotFoundError";
  }
}

async function getBuffer(storagePath: string): Promise<Buffer> {
  const { bucket, key } = parsePath(storagePath);
  try {
    const res = await getClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const chunks: Uint8Array[] = [];
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (err: unknown) {
    const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
    const name = e.name ?? e.Code ?? "";
    const httpStatus = e.$metadata?.httpStatusCode;
    if (name === "NoSuchKey" || name === "NotFound" || name === "404" || httpStatus === 404 || httpStatus === 403) {
      throw new StorageFileNotFoundError(storagePath);
    }
    throw err;
  }
}

export async function downloadFromGcs(storagePath: string): Promise<Buffer> {
  return getBuffer(storagePath);
}

export async function streamFromGcs(
  storagePath: string,
  res: Response,
  contentType: string
): Promise<void> {
  const buf = await getBuffer(storagePath);
  res.set("Content-Type", contentType);
  res.set("Content-Length", String(buf.byteLength));
  res.set("Cache-Control", "private, max-age=300");
  res.send(buf);
}

export async function deleteFromGcs(storagePath: string): Promise<void> {
  try {
    const { bucket, key } = parsePath(storagePath);
    await getClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch {
  }
}
