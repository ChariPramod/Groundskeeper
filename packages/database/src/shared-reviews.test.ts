import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  readSharedReview,
  SharedReviewAccessError,
  SharedReviewConflictError,
  SharedReviewInputError,
  SharedReviewNotFoundError,
  updateSharedReview,
} from "./shared-reviews.js";

const identity = { analysisRunId: "run", installationId: 1n, actorGithubUserId: 7n };
const change = {
  ...identity,
  actorLogin: "alice",
  expectedVersion: 0,
  owner: "SDK team",
  note: "Investigating",
  dismissed: false,
};
function fake() {
  const tx = {
    $executeRaw: vi.fn(),
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce([{ workspaceId: "one" }])
      .mockResolvedValueOnce([{ id: "run" }]),
    sharedReview: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    sharedReviewEvent: { create: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
  };
  return { tx, db: { $transaction: vi.fn((fn) => fn(tx)) } as unknown as PrismaClient };
}
describe("shared review boundaries", () => {
  it.each([
    { expectedVersion: -1 },
    { expectedVersion: 1.5 },
    { expectedVersion: 2147483647 },
    { owner: "a".repeat(101) },
    { note: "a".repeat(2001) },
    { note: "bad\0note" },
    { actorLogin: "" },
    { actorLogin: "a".repeat(40) },
    { dismissed: "false" },
    { installationId: 0n },
    { actorGithubUserId: 0n },
    { analysisRunId: "" },
  ])("rejects invalid fields before database access #%#", async (invalid) => {
    const { db } = fake();
    await expect(
      updateSharedReview(db, { ...change, ...invalid } as typeof change),
    ).rejects.toBeInstanceOf(SharedReviewInputError);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it("returns explicit empty state with version zero", async () => {
    const { db } = fake();
    expect(await readSharedReview(db, identity)).toEqual({
      runId: "run",
      version: 0,
      owner: "",
      note: "",
      dismissed: false,
      updatedAt: null,
      events: [],
    });
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 3000,
      timeout: 5000,
    });
  });
  it("denies revoked membership before reading run data", async () => {
    const { db, tx } = fake();
    tx.$queryRaw.mockReset().mockResolvedValue([]);
    await expect(readSharedReview(db, identity)).rejects.toBeInstanceOf(SharedReviewAccessError);
    expect(tx.sharedReview.findUnique).not.toHaveBeenCalled();
  });
  it("denies foreign or missing run without reading state", async () => {
    const { db, tx } = fake();
    tx.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([{ workspaceId: "one" }])
      .mockResolvedValueOnce([]);
    await expect(updateSharedReview(db, change)).rejects.toBeInstanceOf(SharedReviewNotFoundError);
    expect(tx.sharedReview.create).not.toHaveBeenCalled();
  });
  it("rejects stale version before writing state or audit", async () => {
    const { db, tx } = fake();
    tx.sharedReview.findUnique.mockResolvedValue({ version: 2 });
    await expect(updateSharedReview(db, change)).rejects.toBeInstanceOf(SharedReviewConflictError);
    expect(tx.sharedReviewEvent.create).not.toHaveBeenCalled();
    expect(tx.sharedReview.updateMany).not.toHaveBeenCalled();
  });
  it("limits history and serializes bigint/date fields", async () => {
    const { db, tx } = fake();
    tx.sharedReviewEvent.findMany.mockResolvedValue([
      {
        version: 1,
        actorGithubUserId: 7n,
        actorLogin: "alice",
        owner: "",
        note: "",
        dismissed: true,
        createdAt: new Date(0),
      },
    ]);
    expect((await readSharedReview(db, identity)).events[0]).toMatchObject({
      actorGithubUserId: "7",
      createdAt: "1970-01-01T00:00:00.000Z",
    });
    expect(tx.sharedReviewEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20, orderBy: { version: "desc" } }),
    );
  });
});

it.skipIf(!process.env.DATABASE_TEST_URL)(
  "Postgres enforces concurrent first-write CAS, atomic audit, isolation and revocation",
  async () => {
    const admin = new PrismaClient({ datasourceUrl: process.env.DATABASE_TEST_URL });
    const schema = `review_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(process.env.DATABASE_TEST_URL as string);
    url.searchParams.set("schema", schema);
    const db = new PrismaClient({ datasourceUrl: url.toString() });
    const second = new PrismaClient({ datasourceUrl: url.toString() });
    try {
      await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      for (const table of [
        "Workspace",
        "Repository",
        "AnalysisRun",
        "TeamMember",
        "SharedReview",
        "SharedReviewEvent",
      ])
        await admin.$executeRawUnsafe(
          `CREATE TABLE "${schema}"."${table}" (LIKE "${table}" INCLUDING ALL)`,
        );
      await db.workspace.createMany({
        data: [
          { id: "one", installationId: 1n, account: "one" },
          { id: "two", installationId: 2n, account: "two" },
        ],
      });
      await db.repository.createMany({
        data: [
          {
            id: "repo",
            workspaceId: "one",
            githubId: 1n,
            fullName: "one/repo",
            defaultBranch: "main",
          },
          {
            id: "other",
            workspaceId: "two",
            githubId: 2n,
            fullName: "two/repo",
            defaultBranch: "main",
          },
        ],
      });
      await db.analysisRun.createMany({
        data: [
          {
            id: "run",
            repositoryId: "repo",
            deliveryId: "d1",
            beforeCommit: "a".repeat(40),
            afterCommit: "b".repeat(40),
            inputDigest: "1",
            report: {},
          },
          {
            id: "foreign",
            repositoryId: "other",
            deliveryId: "d2",
            beforeCommit: "a".repeat(40),
            afterCommit: "b".repeat(40),
            inputDigest: "2",
            report: {},
          },
        ],
      });
      await db.teamMember.createMany({
        data: [
          { workspaceId: "one", githubUserId: 7n },
          { workspaceId: "one", githubUserId: 8n },
          { workspaceId: "two", githubUserId: 9n },
        ],
      });
      expect((await readSharedReview(db, identity)).version).toBe(0);
      await expect(
        readSharedReview(db, { ...identity, analysisRunId: "foreign" }),
      ).rejects.toBeInstanceOf(SharedReviewNotFoundError);
      await expect(
        updateSharedReview(db, { ...change, installationId: 2n }),
      ).rejects.toBeInstanceOf(SharedReviewAccessError);
      const result = await Promise.allSettled([
        updateSharedReview(db, change),
        updateSharedReview(second, {
          ...change,
          actorGithubUserId: 8n,
          actorLogin: "bob",
          note: "Concurrent",
        }),
      ]);
      expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const failed = result.find((r) => r.status === "rejected");
      expect(failed?.status === "rejected" && failed.reason).toBeInstanceOf(
        SharedReviewConflictError,
      );
      expect(await db.sharedReviewEvent.count()).toBe(1);
      const first = await readSharedReview(db, identity);
      expect(first.version).toBe(1);
      expect(first.events[0]?.note).toBe(first.note);
      const updated = await updateSharedReview(db, {
        ...change,
        expectedVersion: 1,
        actorGithubUserId: 7n,
        actorLogin: "alice",
        dismissed: true,
      });
      expect(updated.version).toBe(2);
      expect(updated.events.map((event) => event.version)).toEqual([2, 1]);
      expect(updated.events[0]).toMatchObject({
        actorGithubUserId: "7",
        actorLogin: "alice",
        dismissed: true,
      });
      expect(updated.events[1]).toEqual(first.events[0]);
      // A failed event insert must roll back the preceding current-state update.
      await db.sharedReviewEvent.create({
        data: {
          analysisRunId: "run",
          version: 3,
          actorGithubUserId: 7n,
          actorLogin: "alice",
          owner: "",
          note: "sentinel",
          dismissed: false,
        },
      });
      await expect(updateSharedReview(db, { ...change, expectedVersion: 2 })).rejects.toThrow();
      expect(
        (await db.sharedReview.findUniqueOrThrow({ where: { analysisRunId: "run" } })).version,
      ).toBe(2);
      await db.sharedReviewEvent.deleteMany({ where: { version: 3 } });
      await db.teamMember.delete({
        where: { workspaceId_githubUserId: { workspaceId: "one", githubUserId: 7n } },
      });
      await expect(readSharedReview(db, identity)).rejects.toBeInstanceOf(SharedReviewAccessError);
      await expect(
        updateSharedReview(db, { ...change, expectedVersion: 2 }),
      ).rejects.toBeInstanceOf(SharedReviewAccessError);
      const retained = (await readSharedReview(second, { ...identity, actorGithubUserId: 8n }))
        .events;
      expect(retained).toHaveLength(2);
      expect(retained[0]).toMatchObject({ actorGithubUserId: "7", actorLogin: "alice" });
    } finally {
      await db.$disconnect();
      await second.$disconnect();
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.$disconnect();
    }
  },
  30_000,
);
