import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  createTeamSession,
  readTeamSession,
  revokeTeamSession,
  sessionHash,
  setTeamMembership,
} from "./team-access.js";

function database() {
  return {
    teamMember: { findFirst: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    teamSession: { create: vi.fn(), findFirst: vi.fn(), deleteMany: vi.fn() },
    workspace: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "workspace" }) },
  };
}
describe("team sessions and explicit membership", () => {
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
      for (const table of ["Workspace", "TeamMember", "TeamSession"])
        await admin.$executeRawUnsafe(
          `CREATE TABLE "${schema}"."${table}" (LIKE "${table}" INCLUDING ALL)`,
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
      expect(await readTeamSession(db, 1n, token)).toEqual({ githubUserId: 7n, login: "alice" });
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
