import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  canReview,
  createTeamSession,
  isTeamRole,
  readTeamSession,
  revokeTeamSession,
  sessionHash,
  setTeamMembership,
} from "./team-access.js";

function database() {
  const tx = {
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn().mockResolvedValue([{ id: "workspace", teamVersion: 0 }]),
    teamAccessEvent: { create: vi.fn() },
    teamMember: {
      findFirst: vi.fn(),
      findUnique: vi.fn().mockResolvedValue(null),
      count: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    teamSession: { create: vi.fn(), findFirst: vi.fn(), deleteMany: vi.fn() },
    workspace: { update: vi.fn() },
  };
  return { ...tx, $transaction: vi.fn((fn) => fn(tx)) };
}
describe("team sessions and explicit membership", () => {
  it("allows only known roles and never treats an unknown role as a reviewer", () => {
    expect(["viewer", "reviewer", "admin"].every(isTeamRole)).toBe(true);
    expect(canReview("viewer")).toBe(false);
    expect(canReview("reviewer")).toBe(true);
    expect(canReview("admin")).toBe(true);
    for (const value of [undefined, null, "owner", "ADMIN", {}, true]) {
      expect(isTeamRole(value)).toBe(false);
      expect(canReview(value)).toBe(false);
    }
  });
  it("uses reviewer by default and persists explicit role changes", async () => {
    const db = database();
    await setTeamMembership(db as unknown as PrismaClient, 42n, 7n, true);
    expect(db.teamMember.upsert).toHaveBeenLastCalledWith({
      where: { workspaceId_githubUserId: { workspaceId: "workspace", githubUserId: 7n } },
      create: { workspaceId: "workspace", githubUserId: 7n, role: "reviewer" },
      update: { role: "reviewer" },
    });
    await setTeamMembership(db as unknown as PrismaClient, 42n, 7n, true, "viewer");
    expect(db.teamMember.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: { role: "viewer" },
      }),
    );
    await expect(
      setTeamMembership(db as unknown as PrismaClient, 42n, 7n, true, "owner" as "admin"),
    ).rejects.toThrow("Invalid team role");
    expect(db.teamMember.upsert).toHaveBeenCalledTimes(2);
  });
  it("does not provision unapproved identities", async () => {
    const db = database();
    db.teamMember.findFirst.mockResolvedValue(null);
    expect(await createTeamSession(db as unknown as PrismaClient, 42n, 7n, "alice")).toBeNull();
    expect(db.teamSession.create).not.toHaveBeenCalled();
  });
  it("stores only a hash and scopes membership to the installation", async () => {
    const db = database();
    db.teamMember.findFirst.mockResolvedValue({ workspaceId: "workspace" });
    const token = await createTeamSession(db as unknown as PrismaClient, 42n, 7n, "alice");
    expect(token).toHaveLength(43);
    expect(db.teamMember.findFirst).toHaveBeenCalledWith({
      where: { githubUserId: 7n, workspace: { installationId: 42n } },
    });
    expect(db.teamSession.create.mock.calls[0]?.[0].data.tokenHash).toBe(
      sessionHash(token as string),
    );
    expect(
      JSON.stringify(db.teamSession.create.mock.calls, (_, v) =>
        typeof v === "bigint" ? String(v) : v,
      ),
    ).not.toContain(token);
  });
  it("rejects malformed cookies and checks expiry and current scoped membership on every read", async () => {
    const db = database();
    expect(await readTeamSession(db as unknown as PrismaClient, 42n, "bad")).toBeNull();
    expect(db.teamSession.findFirst).not.toHaveBeenCalled();
    await readTeamSession(db as unknown as PrismaClient, 42n, "a".repeat(43));
    expect(db.teamSession.findFirst.mock.calls[0]?.[0].where).toMatchObject({
      tokenHash: sessionHash("a".repeat(43)),
      member: { workspace: { installationId: 42n } },
      expiresAt: { gt: expect.any(Date) },
    });
  });
  it("revokes the hashed session and deletes membership using its cascading key", async () => {
    const db = database();
    await revokeTeamSession(db as unknown as PrismaClient, "a".repeat(43));
    expect(db.teamSession.deleteMany).toHaveBeenCalledWith({
      where: { tokenHash: sessionHash("a".repeat(43)) },
    });
    db.teamMember.findUnique.mockResolvedValue({ role: "reviewer" });
    await setTeamMembership(db as unknown as PrismaClient, 42n, 7n, false);
    expect(db.teamMember.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: "workspace", githubUserId: 7n },
    });
  });
});

it.skipIf(!process.env.DATABASE_TEST_URL)(
  "enforces tenant isolation, session expiry and membership cascade in Postgres",
  async () => {
    const admin = new PrismaClient({ datasourceUrl: process.env.DATABASE_TEST_URL });
    const schema = `team_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(process.env.DATABASE_TEST_URL as string);
    url.searchParams.set("schema", schema);
    const db = new PrismaClient({ datasourceUrl: url.toString() });
    try {
      await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      for (const table of ["Workspace", "TeamMember", "TeamSession", "TeamAccessEvent"])
        await admin.$executeRawUnsafe(
          `CREATE TABLE "${schema}"."${table}" (LIKE "${table}" INCLUDING ALL)`,
        );
      // LIKE preserves the source enum type; Prisma addresses enums in the selected schema.
      await admin.$executeRawUnsafe(
        `CREATE TYPE "${schema}"."TeamRole" AS ENUM ('viewer', 'reviewer', 'admin')`,
      );
      await admin.$executeRawUnsafe(
        `ALTER TABLE "${schema}"."TeamMember" ALTER COLUMN "role" DROP DEFAULT`,
      );
      await admin.$executeRawUnsafe(
        `ALTER TABLE "${schema}"."TeamMember" ALTER COLUMN "role" TYPE "${schema}"."TeamRole" USING "role"::text::"${schema}"."TeamRole"`,
      );
      await admin.$executeRawUnsafe(
        `ALTER TABLE "${schema}"."TeamMember" ALTER COLUMN "role" SET DEFAULT 'reviewer'::"${schema}"."TeamRole"`,
      );
      for (const column of ["previousRole", "newRole"])
        await admin.$executeRawUnsafe(
          `ALTER TABLE "${schema}"."TeamAccessEvent" ALTER COLUMN "${column}" TYPE "${schema}"."TeamRole" USING "${column}"::text::"${schema}"."TeamRole"`,
        );
      await admin.$executeRawUnsafe(
        `ALTER TABLE "${schema}"."TeamMember" ADD FOREIGN KEY ("workspaceId") REFERENCES "${schema}"."Workspace"("id") ON DELETE CASCADE`,
      );
      await admin.$executeRawUnsafe(
        `ALTER TABLE "${schema}"."TeamSession" ADD FOREIGN KEY ("workspaceId", "githubUserId") REFERENCES "${schema}"."TeamMember"("workspaceId", "githubUserId") ON DELETE CASCADE`,
      );
      await db.workspace.createMany({
        data: [
          { id: "one", installationId: 1n, account: "one" },
          { id: "two", installationId: 2n, account: "two" },
        ],
      });
      await setTeamMembership(db, 1n, 7n, true);
      expect(await createTeamSession(db, 2n, 7n, "alice")).toBeNull();
      const token = await createTeamSession(db, 1n, 7n, "alice");
      if (!token) throw new Error("No session");
      expect(await readTeamSession(db, 1n, token)).toEqual({
        githubUserId: 7n,
        login: "alice",
        role: "reviewer",
      });
      expect(await readTeamSession(db, 2n, token)).toBeNull();
      await setTeamMembership(db, 1n, 8n, true, "admin");
      await setTeamMembership(db, 1n, 7n, true, "admin");
      expect(await readTeamSession(db, 1n, token)).toMatchObject({ role: "admin" });
      await setTeamMembership(db, 1n, 7n, true, "viewer");
      expect(await readTeamSession(db, 1n, token)).toMatchObject({ role: "viewer" });
      expect(await db.teamSession.count()).toBe(1);
      // A grant in another installation must not affect the original session's privileges.
      await setTeamMembership(db, 2n, 7n, true, "admin");
      expect(await readTeamSession(db, 1n, token)).toMatchObject({ role: "viewer" });
      expect(await readTeamSession(db, 2n, token)).toBeNull();
      await db.teamSession.update({
        where: { tokenHash: sessionHash(token) },
        data: { expiresAt: new Date(0) },
      });
      expect(await readTeamSession(db, 1n, token)).toBeNull();
      const second = await createTeamSession(db, 1n, 7n, "renamed-alice");
      if (!second) throw new Error("No second session");
      await setTeamMembership(db, 1n, 7n, false);
      expect(await db.teamSession.count()).toBe(0);
      expect(await readTeamSession(db, 1n, second)).toBeNull();
      await setTeamMembership(db, 1n, 7n, true);
      expect(await readTeamSession(db, 1n, second)).toBeNull();
    } finally {
      await db.$disconnect();
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.$disconnect();
    }
  },
  20_000,
);
