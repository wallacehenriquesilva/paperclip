import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveDefaultSecretsKeyFilePath } from "../home-paths.js";
import { badRequest } from "../errors.js";

interface Envelope {
  scheme: "mcp_oauth_v1";
  iv: string;
  tag: string;
  ciphertext: string;
}

function decodeMasterKey(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^[A-Fa-f0-9]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  try {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 32) return decoded;
  } catch {
    // ignored
  }
  if (Buffer.byteLength(trimmed, "utf8") === 32) return Buffer.from(trimmed, "utf8");
  return null;
}

function resolveMasterKeyFilePath(): string {
  const fromEnv = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv.trim());
  return resolveDefaultSecretsKeyFilePath();
}

let cachedMasterKey: Buffer | null = null;

function loadMasterKey(): Buffer {
  if (cachedMasterKey) return cachedMasterKey;

  const envRaw = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  if (envRaw && envRaw.trim().length > 0) {
    const decoded = decodeMasterKey(envRaw);
    if (!decoded) {
      throw badRequest(
        "Invalid PAPERCLIP_SECRETS_MASTER_KEY (expected 32-byte base64, 64-char hex, or raw 32-char string)",
      );
    }
    cachedMasterKey = decoded;
    return decoded;
  }

  const keyPath = resolveMasterKeyFilePath();
  if (existsSync(keyPath)) {
    try {
      const mode = statSync(keyPath).mode & 0o777;
      if ((mode & 0o077) !== 0) chmodSync(keyPath, 0o600);
    } catch {
      // best effort
    }
    const raw = readFileSync(keyPath, "utf8");
    const decoded = decodeMasterKey(raw);
    if (!decoded) throw badRequest(`Invalid secrets master key at ${keyPath}`);
    cachedMasterKey = decoded;
    return decoded;
  }

  // Match local-encrypted-provider's generate-on-first-use behavior so OAuth
  // tokens encrypt under the same key as secrets even when env is unset.
  mkdirSync(path.dirname(keyPath), { recursive: true });
  const generated = randomBytes(32);
  writeFileSync(keyPath, generated.toString("base64"), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // best effort
  }
  cachedMasterKey = generated;
  return generated;
}

export function encryptToken(plaintext: string): string {
  const key = loadMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope: Envelope = {
    scheme: "mcp_oauth_v1",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ct.toString("base64"),
  };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

export function decryptToken(ciphertext: string): string {
  const key = loadMasterKey();
  let envelope: Envelope;
  try {
    envelope = JSON.parse(Buffer.from(ciphertext, "base64").toString("utf8")) as Envelope;
  } catch {
    throw badRequest("Invalid MCP OAuth token envelope");
  }
  if (envelope.scheme !== "mcp_oauth_v1") {
    throw badRequest(`Unsupported MCP OAuth token scheme: ${envelope.scheme}`);
  }
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const ct = Buffer.from(envelope.ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plain.toString("utf8");
}

/** Test seam: reset the cached key (used by unit tests that mock env vars). */
export function __resetCachedKeyForTests() {
  cachedMasterKey = null;
}
