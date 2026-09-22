import { expect, it, vi } from "vitest";
import { repairArtifactDigest } from "../../github/src/repairs/engine.js";
import { artifactDigest, mapRepairArtifact, repairReviewResponse } from "./repair-review";
import { demoRepairDigest, getDemoRepair, isRepairReviewData } from "./repair-review-types";

const env = {
  DASHBOARD_MODE: "live",
  DASHBOARD_INSTALLATION_ID: "42",
  DASHBOARD_ACCESS_TOKEN: "secret",
  DATABASE_URL: "postgresql://local/db",
};
const request = (token = "secret") =>
  new Request("http://localhost/api/repairs/a", { headers: { Authorization: `Bearer ${token}` } });
const sample = () => ({
  ...getDemoRepair(demoRepairDigest),
  version: 1,
  id: "e".repeat(64),
  installationId: "42",
  baseline: { evidence: [{ outcome: "failed", stdout: "PRIVATE STREAM" }] },
  verification: { evidence: [{ outcome: "passed", stderr: "PRIVATE ERROR" }] },
});
it("projects only bounded artifact fields and outcome counts", () => {
  const p = sample();
  const dto = mapRepairArtifact(p, artifactDigest(p), 42n);
  expect(dto?.baseline.failed).toBe(1);
  expect(dto?.verification.passed).toBe(1);
  expect(JSON.stringify(dto)).not.toContain("PRIVATE");
  expect(isRepairReviewData(dto)).toBe(true);
});
it("rejects tampering, mismatched tenant and oversized pages", () => {
  const p = sample();
  const digest = artifactDigest(p);
  expect(mapRepairArtifact({ ...p, summary: "tampered" }, digest, 42n)).toBeNull();
  expect(mapRepairArtifact(p, digest, 43n)).toBeNull();
  const large = { ...p, files: [{ path: "docs.md", before: "é".repeat(110000), after: "ok" }] };
  expect(mapRepairArtifact(large, artifactDigest(large), 42n)).toBeNull();
});
it("canonical digest ignores object key order but preserves array order", () => {
  expect(artifactDigest({ a: 1, b: [2, 3] })).toBe(artifactDigest({ b: [2, 3], a: 1 }));
  expect(artifactDigest([2, 3])).not.toBe(artifactDigest([3, 2]));
});
it("authenticates before reading and fails closed on invalid configuration", async () => {
  const read = vi.fn();
  expect((await repairReviewResponse(request("wrong"), demoRepairDigest, env, read)).status).toBe(
    401,
  );
  expect(
    (
      await repairReviewResponse(
        request(),
        demoRepairDigest,
        { ...env, DASHBOARD_INSTALLATION_ID: "0" },
        read,
      )
    ).status,
  ).toBe(503);
  expect(read).not.toHaveBeenCalled();
});
it("does not reveal cross tenant artifact existence or fall back to samples", async () => {
  const p = { ...sample(), installationId: "43" };
  expect(
    (await repairReviewResponse(request(), artifactDigest(p), env, async () => p)).status,
  ).toBe(404);
  const result = await repairReviewResponse(request(), demoRepairDigest, env, async () => {
    throw new Error("PRIVATE PATH");
  });
  expect(result.status).toBe(404);
  expect(await result.text()).not.toContain("PRIVATE");
});
it("serves a single explicit demo fixture with no database or file reads", async () => {
  const read = vi.fn();
  const result = await repairReviewResponse(request(), demoRepairDigest, {}, read);
  expect(result.status).toBe(200);
  expect(result.headers.get("Cache-Control")).toBe("no-store");
  expect((await repairReviewResponse(request(), "a".repeat(64), {}, read)).status).toBe(404);
  expect((await repairReviewResponse(request(), "../private", env, read)).status).toBe(404);
  expect(read).not.toHaveBeenCalled();
});
it("rejects malformed response structures before browser rendering", () => {
  expect(isRepairReviewData({ ...getDemoRepair(demoRepairDigest), files: [null] })).toBe(false);
  expect(
    isRepairReviewData({ ...getDemoRepair(demoRepairDigest), verification: { passed: -1 } }),
  ).toBe(false);
});

it("matches the CLI artifact digest contract across nested evidence and Unicode keys", () => {
  const artifact = {
    ...sample(),
    metadata: { é: "Unicode", Z: null, a: [3, { z: true, a: "quoted\\text" }] },
  };
  expect(artifactDigest(artifact)).toBe(
    repairArtifactDigest(artifact as unknown as Parameters<typeof repairArtifactDigest>[0]),
  );
});
