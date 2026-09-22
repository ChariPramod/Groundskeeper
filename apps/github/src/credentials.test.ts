import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadPrivateKey, normalizePrivateKey } from "./credentials.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

it("normalizes PEM, escaped newlines and base64 into the same signing key", () => {
  for (const value of [
    privateKey,
    privateKey.replace(/\n/g, "\\n"),
    Buffer.from(privateKey).toString("base64"),
  ]) {
    expect(normalizePrivateKey(value)).toBe(privateKey);
  }
});

it("loads a root-relative PEM file and gives inline credentials precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "groundskeeper-key-"));
  try {
    await writeFile(join(root, "app.pem"), privateKey);
    expect(await loadPrivateKey({ PRIVATE_KEY_PATH: "app.pem" }, root)).toBe(privateKey);
    expect(
      await loadPrivateKey({ PRIVATE_KEY: privateKey, PRIVATE_KEY_PATH: "missing.pem" }, root),
    ).toBe(privateKey);
    await writeFile(join(root, "large.pem"), "x".repeat(65_537));
    await expect(loadPrivateKey({ PRIVATE_KEY_PATH: "large.pem" }, root)).rejects.toThrow(
      "under 64 KiB",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects malformed and non-RSA credentials without exposing their contents", async () => {
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  expect(() =>
    normalizePrivateKey(ec.privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
  ).toThrow("RSA PEM");
  expect(() => normalizePrivateKey("secret-value")).toThrow(
    "GitHub App private key must be valid RSA PEM",
  );
  await expect(loadPrivateKey({}, "/workspace")).rejects.toThrow(
    "Set PRIVATE_KEY or PRIVATE_KEY_PATH",
  );
});
