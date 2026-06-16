import { createHmac, createHash, randomUUID } from "node:crypto";
import { AppStoreError } from "./db";
import type { AssetKind } from "./interview-store";

export type S3Config = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export function getS3Config(): S3Config {
  const endpoint = process.env.S3_ENDPOINT;
  const region = process.env.S3_REGION || "auto";
  const bucket = process.env.S3_BUCKET;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new AppStoreError("S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be configured.");
  }

  return {
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
  };
}

export function createS3ObjectKey(input: { interviewId: string; kind: AssetKind; fileName: string }) {
  const safeName = input.fileName
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160) || "asset";

  return `interviews/${input.interviewId}/${input.kind}/${randomUUID()}-${safeName}`;
}

export function createPresignedS3Url(input: {
  method: "PUT" | "GET";
  key: string;
  contentType?: string;
  expiresSeconds?: number;
  config?: S3Config;
}) {
  const config = input.config ?? getS3Config();
  const endpoint = new URL(config.endpoint.replace(/\/+$/, ""));
  const now = new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const canonicalUri = encodePath(`${config.bucket}/${input.key}`);
  const host = endpoint.host;
  const signedHeaderNames = ["host", ...(input.contentType ? ["content-type"] : [])];
  const canonicalHeaders = [
    `host:${host}`,
    ...(input.contentType ? [`content-type:${input.contentType}`] : []),
  ].join("\n") + "\n";
  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${config.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(input.expiresSeconds ?? 3600),
    "X-Amz-SignedHeaders": signedHeaderNames.join(";"),
  };
  const canonicalQuery = canonicalizeQuery(query);
  const canonicalRequest = [
    input.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaderNames.join(";"),
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = hmacHex(getSigningKey(config.secretAccessKey, dateStamp, config.region), stringToSign);

  return `${endpoint.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

function getSigningKey(secret: string, dateStamp: string, region: string) {
  const dateKey = hmacBuffer(`AWS4${secret}`, dateStamp);
  const dateRegionKey = hmacBuffer(dateKey, region);
  const dateRegionServiceKey = hmacBuffer(dateRegionKey, "s3");

  return hmacBuffer(dateRegionServiceKey, "aws4_request");
}

function hmacBuffer(key: string | Buffer, value: string) {
  return createHmac("sha256", key).update(value).digest();
}

function hmacHex(key: string | Buffer, value: string) {
  return createHmac("sha256", key).update(value).digest("hex");
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function toAmzDate(date: Date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function encodePath(path: string) {
  return `/${path.split("/").map((part) => encodeURIComponent(part)).join("/")}`;
}

function canonicalizeQuery(query: Record<string, string>) {
  return Object.entries(query)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${rfc3986(key)}=${rfc3986(value)}`)
    .join("&");
}

function rfc3986(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}
