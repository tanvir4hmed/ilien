import { readFileSync } from "node:fs";
import { SignatureV4 } from "@smithy/signature-v4";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { Sha256 } from "@aws-crypto/sha256-js";
const [method = "GET", path = "/v1/cases", file] = process.argv.slice(2);
if (!["GET", "POST"].includes(method) || !/^\/v1\/(?:cases|channels|ai)(?:\/|$)/.test(path))
  throw new Error("Use GET/POST /v1/cases, /v1/channels or /v1/ai routes");
const base = new URL(process.env.ILIEN_API_URL);
const url = new URL(path, base);
if (
  url.protocol !== "https:" ||
  url.origin !== base.origin ||
  url.search ||
  url.hash
)
  throw new Error("Same-origin HTTPS API path required");
const body = file ? readFileSync(file, "utf8") : undefined;
const signer = new SignatureV4({
  service: "execute-api",
  region: process.env.AWS_REGION ?? "us-east-1",
  credentials: fromNodeProviderChain(),
  sha256: Sha256,
});
const signed = await signer.sign({
  method,
  protocol: url.protocol,
  hostname: url.hostname,
  path: url.pathname,
  headers: { host: url.host, "content-type": "application/json" },
  body,
});
const response = await fetch(url, { method, headers: signed.headers, body });
console.log(response.status, await response.text());
if (!response.ok) process.exitCode = 1;
