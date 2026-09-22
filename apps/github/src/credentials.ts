import { createPrivateKey } from "node:crypto";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export function normalizePrivateKey(value: string): string {
  try {
    let pem = value.trim().replace(/\\n/g, "\n");
    if (!pem.startsWith("-----BEGIN ")) pem = Buffer.from(pem, "base64").toString("utf8");
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== "rsa") throw new Error("Invalid key type");
    return key.export({ type: "pkcs8", format: "pem" }).toString();
  } catch {
    throw new Error(
      "GitHub App private key must be valid RSA PEM text, base64 PEM, or a readable PEM file",
    );
  }
}

export async function loadPrivateKey(env: NodeJS.ProcessEnv, root: string): Promise<string> {
  if (env.PRIVATE_KEY) return normalizePrivateKey(env.PRIVATE_KEY);
  if (!env.PRIVATE_KEY_PATH)
    throw new Error("Set PRIVATE_KEY or PRIVATE_KEY_PATH for the GitHub App");
  const path = isAbsolute(env.PRIVATE_KEY_PATH)
    ? env.PRIVATE_KEY_PATH
    : resolve(root, env.PRIVATE_KEY_PATH);
  let value: string;
  try {
    const file = await open(path, "r");
    try {
      if (!(await file.stat()).isFile()) throw new Error("Not a regular file");
      const buffer = Buffer.alloc(65_537);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 65_536) throw new Error("Oversized key");
      value = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await file.close();
    }
  } catch {
    throw new Error("PRIVATE_KEY_PATH must point to a readable RSA PEM file under 64 KiB");
  }
  return normalizePrivateKey(value);
}
