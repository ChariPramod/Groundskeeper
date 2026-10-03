import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { maintainStorage, maintenanceDatabaseUrl, parseMaintenanceArgs } from "./maintenance.js";

describe("storage maintenance boundaries", () => {
  it("defaults to dry-run and bounds explicit cleanup", () => {
    expect(parseMaintenanceArgs(["--installation-id", "42"])).toEqual({
      installationId: 42n,
      limit: 100,
      apply: false,
      diagnostics: "exact",
    });
    expect(parseMaintenanceArgs(["--installation-id", "42", "--limit", "1000", "--apply"])).toEqual(
      { installationId: 42n, limit: 1000, apply: true, diagnostics: "exact" },
    );
    for (const args of [
      [],
      ["--installation-id", "0"],
      ["--installation-id", "9223372036854775808"],
      ["--installation-id", "42", "--limit", "1001"],
      ["--installation-id", "42", "--limit", "0"],
      ["--installation-id", "42", "--limit", "1.5"],
      ["--installation-id", "42", "--delete-all"],
      ["--installation-id", "42", "--apply=false"],
      ["--installation-id", "42", "--diagnostics", "false"],
      ["--installation-id", "42", "--diagnostics", "summary", "--diagnostics", "exact"],
      ["--installation-id", "42", "--installation-id", "99"],
      ["--installation-id", "42", "--apply", "--apply"],
    ])
      expect(() => parseMaintenanceArgs(args)).toThrow();
  });
  it("supports bounded summary diagnostics for dry runs and apply", () => {
    for (const apply of [false, true])
      expect(
        parseMaintenanceArgs([
          "--installation-id",
          "42",
          "--diagnostics",
          "summary",
          ...(apply ? ["--apply"] : []),
        ]),
      ).toEqual({
        installationId: 42n,
        limit: 100,
        apply,
        diagnostics: "summary",
      });
  });
  it("uses bounded connections and never exposes invalid connection strings", () => {
    const url = new URL(
      maintenanceDatabaseUrl(
        "postgresql://user:password@localhost/db?schema=test&connection_limit=100",
      ),
    );
    expect(url.searchParams.get("connect_timeout")).toBe("5");
    expect(url.searchParams.get("pool_timeout")).toBe("5");
    expect(url.searchParams.get("connection_limit")).toBe("1");
    expect(url.searchParams.get("schema")).toBe("test");
    expect(() => maintenanceDatabaseUrl("https://SECRET.example")).toThrow(
      "A valid PostgreSQL DATABASE_URL is required.",
    );
  });
  it("rejects invalid helper options before opening a transaction", async () => {
    const db = { $transaction: vi.fn() };
    await expect(
      maintainStorage(db as unknown as PrismaClient, {
        installationId: -1n,
        limit: 1,
        apply: true,
      }),
    ).rejects.toThrow();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it("fails closed for an unknown installation before cleanup queries", async () => {
    const tx = {
      $executeRaw: vi.fn(),
      workspace: { findUnique: vi.fn().mockResolvedValue(null) },
      $queryRaw: vi.fn(),
    };
    const db = { $transaction: vi.fn((fn, _options: unknown) => fn(tx)) };
    await expect(
      maintainStorage(db as unknown as PrismaClient, {
        installationId: 42n,
        limit: 1,
        apply: true,
      }),
    ).rejects.toThrow("Installation workspace not found");
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(db.$transaction.mock.calls[0]?.[1]).toEqual({ maxWait: 5000, timeout: 15000 });
  });
});
it.skipIf(!process.env.DATABASE_TEST_URL)(
  "cleans only bounded expired tenant sessions, preserves durable rows and skips concurrent locks",
  async () => {
    const admin = new PrismaClient({ datasourceUrl: process.env.DATABASE_TEST_URL });
    const schema = `maintenance_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(process.env.DATABASE_TEST_URL as string);
    url.searchParams.set("schema", schema);
    url.searchParams.set("connection_limit", "1");
    const db = new PrismaClient({ datasourceUrl: url.toString() });
    const second = new PrismaClient({ datasourceUrl: url.toString() });
    try {
      await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      for (const table of [
        "Workspace",
        "Repository",
        "AnalysisRun",
        "VerificationRun",
        "SharedReviewEvent",
        "TeamAccessEvent",
        "WebhookDelivery",
        "TeamSession",
      ])
        await admin.$executeRawUnsafe(
          `CREATE TABLE "${schema}"."${table}" (LIKE "${table}" INCLUDING ALL)`,
        );
      await db.$executeRawUnsafe("SET TIME ZONE 'Asia/Tokyo'");
      await second.$executeRawUnsafe("SET TIME ZONE 'America/Los_Angeles'");
      await db.workspace.createMany({
        data: [
          { id: "own", installationId: 42n, account: "own" },
          { id: "foreign", installationId: 99n, account: "foreign" },
        ],
      });
      await db.teamSession.createMany({
        data: [
          ...["expired-1", "expired-2", "expired-3"].map((tokenHash) => ({
            tokenHash,
            workspaceId: "own",
            githubUserId: 7n,
            login: "alice",
            expiresAt: new Date(Date.now() - 60_000),
          })),
          {
            tokenHash: "active",
            workspaceId: "own",
            githubUserId: 7n,
            login: "alice",
            expiresAt: new Date(Date.now() + 60_000),
          },
          {
            tokenHash: "foreign-expired",
            workspaceId: "foreign",
            githubUserId: 8n,
            login: "bob",
            expiresAt: new Date(Date.now() - 60_000),
          },
        ],
      });
      await db.repository.create({
        data: {
          id: "repo",
          workspaceId: "own",
          githubId: 1n,
          fullName: "org/repo",
          defaultBranch: "main",
        },
      });
      await db.analysisRun.create({
        data: {
          id: "run",
          repositoryId: "repo",
          deliveryId: "delivery",
          inputDigest: "analysis-input",
          beforeCommit: "a",
          afterCommit: "b",
          report: {},
        },
      });
      await db.verificationRun.create({
        data: {
          id: "verify",
          analysisRunId: "run",
          sourceDigest: "source",
          inputDigest: "input",
          report: {},
        },
      });
      await db.sharedReviewEvent.create({
        data: {
          id: "audit",
          analysisRunId: "run",
          version: 1,
          actorGithubUserId: 7n,
          actorLogin: "alice",
          owner: "",
          note: "keep",
          dismissed: false,
        },
      });
      await db.$executeRaw`
        INSERT INTO "TeamAccessEvent" (id, "workspaceId", version, "actorSource", "targetGithubUserId", "newRole")
        VALUES ('access-audit', 'own', 1, 'operator', 7, 'admin')`;
      await db.webhookDelivery.create({
        data: {
          id: "delivery",
          event: "push",
          installationId: 42n,
          payload: { secret: "not-printed" },
          processedAt: new Date(),
        },
      });
      const options = { installationId: 42n, limit: 1, apply: false };
      const dry = await maintainStorage(db, options);
      expect(dry.deletedSessions).toBe(0);
      expect(dry.expiredSessionBatch).toBe(1);
      expect(dry.scopedCountsBeforeCleanup).toEqual({
        sessions: "4",
        expiredSessions: "3",
        analysisRuns: "1",
        verificationRuns: "1",
        reviewEvents: "1",
        teamAccessEvents: "1",
        webhookDeliveries: "1",
      });
      expect(JSON.stringify(dry)).not.toContain("not-printed");
      expect(dry.schemaVersion).toBe(2);
      expect(dry.diagnostics).toBe("exact");
      expect(dry.expiredSessionsRemain).toBe(true);
      expect(dry.relationBytes?.scope).toContain("database-wide");
      expect(dry.relationBytes?.values.map((value) => value.relation)).toContain("TeamAccessEvent");
      for (const value of dry.relationBytes?.values ?? []) {
        expect(BigInt(value.bytes)).toBe(BigInt(value.tableBytes) + BigInt(value.indexBytes));
      }
      expect(await db.teamSession.count()).toBe(5);
      const [first, next] = await Promise.all([
        maintainStorage(db, { ...options, apply: true }),
        maintainStorage(second, { ...options, apply: true, diagnostics: "summary" }),
      ]);
      expect(first.deletedSessions + next.deletedSessions).toBe(2);
      expect(
        await db.teamSession.count({
          where: { workspaceId: "own", expiresAt: { lt: new Date() } },
        }),
      ).toBe(1);
      let locked!: () => void;
      const acquired = new Promise<void>((resolve) => {
        locked = resolve;
      });
      let unlock!: () => void;
      const release = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const holding = second.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "tokenHash" FROM "TeamSession" WHERE "workspaceId" = 'own' AND "expiresAt" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') FOR UPDATE`;
          locked();
          await release;
        },
        { timeout: 10000 },
      );
      await acquired;
      try {
        const skipped = await maintainStorage(db, {
          ...options,
          apply: true,
          diagnostics: "summary",
        });
        expect(skipped.deletedSessions).toBe(0);
        expect(skipped.expiredSessionsRemain).toBe(true);
        expect(skipped.scopedCountsBeforeCleanup).toBeNull();
        expect(skipped.relationBytes).toBeNull();
      } finally {
        unlock();
        await holding;
      }
      const last = await maintainStorage(db, { ...options, apply: true, diagnostics: "summary" });
      expect(last.deletedSessions).toBe(1);
      expect(last.expiredSessionsRemain).toBe(false);
      expect(
        await db.teamSession.findMany({
          select: { tokenHash: true },
          orderBy: { tokenHash: "asc" },
        }),
      ).toEqual([{ tokenHash: "active" }, { tokenHash: "foreign-expired" }]);
      expect(await db.analysisRun.count()).toBe(1);
      expect(await db.verificationRun.count()).toBe(1);
      expect(await db.sharedReviewEvent.count()).toBe(1);
      expect(await db.teamAccessEvent.count()).toBe(1);
      expect(await db.webhookDelivery.count()).toBe(1);
    } finally {
      await db.$disconnect();
      await second.$disconnect();
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.$disconnect();
    }
  },
  30000,
);

it.skipIf(!process.env.DATABASE_TEST_URL)(
  "summary cleanup depends only on indexed sessions, omits diagnostics, and remains bounded and tenant scoped",
  async () => {
    const admin = new PrismaClient({ datasourceUrl: process.env.DATABASE_TEST_URL });
    const schema = `maintenance_summary_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(process.env.DATABASE_TEST_URL as string);
    url.searchParams.set("schema", schema);
    url.searchParams.set("connection_limit", "1");
    const db = new PrismaClient({ datasourceUrl: url.toString() });
    try {
      await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      // Deliberately omit all durable-history tables: summary must not touch them.
      for (const table of ["Workspace", "TeamSession"])
        await admin.$executeRawUnsafe(
          `CREATE TABLE "${schema}"."${table}" (LIKE "${table}" INCLUDING ALL)`,
        );
      await db.workspace.createMany({
        data: [
          { id: "own", installationId: 42n, account: "own" },
          { id: "foreign", installationId: 99n, account: "foreign" },
        ],
      });
      await db.teamSession.createMany({
        data: [
          ...Array.from({ length: 5 }, (_, index) => ({
            tokenHash: `expired-${index}`,
            workspaceId: "own",
            githubUserId: 7n,
            login: "do-not-print-login",
            expiresAt: new Date(0),
          })),
          {
            tokenHash: "active",
            workspaceId: "own",
            githubUserId: 7n,
            login: "alice",
            expiresAt: new Date("2099-01-01"),
          },
          {
            tokenHash: "foreign",
            workspaceId: "foreign",
            githubUserId: 8n,
            login: "bob",
            expiresAt: new Date(0),
          },
        ],
      });
      const options = {
        installationId: 42n,
        limit: 2,
        apply: false,
        diagnostics: "summary" as const,
      };
      const dry = await maintainStorage(db, options);
      expect(dry).toMatchObject({
        schemaVersion: 2,
        diagnostics: "summary",
        mode: "dry-run",
        scopedCountsBeforeCleanup: null,
        relationBytes: null,
        expiredSessionBatch: 2,
        deletedSessions: 0,
        expiredSessionsRemain: true,
      });
      expect(JSON.stringify(dry)).not.toContain("do-not-print-login");
      expect(await db.teamSession.count()).toBe(7);
      // Exact diagnostics fail closed when unavailable; no sessions are removed.
      await expect(
        maintainStorage(db, { ...options, diagnostics: "exact", apply: true }),
      ).rejects.toThrow();
      expect(await db.teamSession.count()).toBe(7);
      for (const deleted of [2, 2, 1, 0]) {
        const result = await maintainStorage(db, { ...options, apply: true });
        expect(result.deletedSessions).toBe(deleted);
        expect(result.expiredSessionsRemain).toBe(deleted === 2);
      }
      expect(
        await db.teamSession.findMany({
          select: { tokenHash: true },
          orderBy: { tokenHash: "asc" },
        }),
      ).toEqual([{ tokenHash: "active" }, { tokenHash: "foreign" }]);
    } finally {
      await db.$disconnect();
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.$disconnect();
    }
  },
  30000,
);
