import { randomInt, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, it, vi } from "vitest";
import {
  changeTeamMembership,
  createTeamSession,
  readTeamDirectory,
  readTeamSession,
  setTeamMembership,
  TeamConflictError,
  TeamInputError,
  TeamLastAdminError,
  TeamPermissionError,
} from "./team-access.js";

it("validates mutation identities, actor and version before opening a transaction", async () => {
  const db = { $transaction: vi.fn() } as unknown as PrismaClient;
  const input = {
    installationId: 1n,
    targetGithubUserId: 2n,
    role: "reviewer" as const,
    expectedVersion: 0,
    actor: { source: "member" as const, githubUserId: 1n, login: "alice" },
  };
  for (const patch of [
    { installationId: 0n },
    { targetGithubUserId: 9223372036854775808n },
    { expectedVersion: -1 },
    { expectedVersion: 2147483648 },
    { expectedVersion: undefined },
    { role: "owner" },
    { actor: { source: "member", githubUserId: 1n, login: "" } },
  ])
    await expect(
      changeTeamMembership(db, { ...input, ...patch } as typeof input),
    ).rejects.toBeInstanceOf(TeamInputError);
  expect(db.$transaction).not.toHaveBeenCalled();
});

it.skipIf(!process.env.DATABASE_TEST_URL)(
  "audits concurrent admin changes, protects the last admin, scopes reads and revokes sessions atomically",
  async () => {
    const db = new PrismaClient({ datasourceUrl: process.env.DATABASE_TEST_URL });
    const second = new PrismaClient({ datasourceUrl: process.env.DATABASE_TEST_URL });
    const installationId = BigInt(randomInt(1, 2 ** 47));
    const foreignInstallation = installationId + BigInt(2 ** 47);
    const actor = (id: bigint) => ({
      source: "member" as const,
      githubUserId: id,
      login: `user-${id}`,
    });
    let workspaceId = "";
    const createdWorkspaceIds: string[] = [];
    try {
      const workspace = await db.workspace.create({
        data: { installationId, account: "team-test" },
      });
      workspaceId = workspace.id;
      createdWorkspaceIds.push(workspace.id);
      await expect(
        db.teamAccessEvent.create({
          data: {
            workspaceId,
            version: 1,
            actorSource: "member",
            actorGithubUserId: null,
            actorLogin: "missing-identity",
            targetGithubUserId: 1n,
            newRole: "admin",
          },
        }),
      ).rejects.toThrow();
      const foreignWorkspace = await db.workspace.create({
        data: { installationId: foreignInstallation, account: "foreign" },
      });
      createdWorkspaceIds.push(foreignWorkspace.id);
      expect(await setTeamMembership(db, installationId, 1n, true, "admin")).toEqual({
        version: 1,
        changed: true,
      });
      await setTeamMembership(db, installationId, 2n, true);
      const session = await createTeamSession(db, installationId, 2n, "reviewer");
      if (!session) throw new Error("Missing session");
      const directory = await readTeamDirectory(db, { installationId, actor: actor(1n) });
      expect(directory.version).toBe(2);
      expect(directory.members[1]).toMatchObject({
        githubUserId: "2",
        role: "reviewer",
        lastKnownLogin: "reviewer",
      });
      expect(directory.events[0]?.actor).toEqual({
        source: "operator",
        githubUserId: null,
        login: null,
      });
      expect(JSON.stringify(directory)).not.toContain(session);
      await expect(
        readTeamDirectory(db, { installationId, actor: actor(2n) }),
      ).rejects.toBeInstanceOf(TeamPermissionError);
      await expect(
        readTeamDirectory(db, { installationId: foreignInstallation, actor: actor(1n) }),
      ).rejects.toBeInstanceOf(TeamPermissionError);
      const base = {
        installationId,
        actor: actor(1n),
        expectedVersion: 2,
        role: "viewer" as const,
      };
      const racing = await Promise.allSettled([
        changeTeamMembership(db, { ...base, targetGithubUserId: 3n }),
        changeTeamMembership(second, { ...base, targetGithubUserId: 4n }),
      ]);
      expect(racing.filter((value) => value.status === "fulfilled")).toHaveLength(1);
      const rejected = racing.find((value) => value.status === "rejected");
      expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(TeamConflictError);
      expect(
        await changeTeamMembership(db, {
          ...base,
          expectedVersion: 3,
          targetGithubUserId: 2n,
          role: "reviewer",
        }),
      ).toEqual({ version: 3, changed: false });
      await expect(
        changeTeamMembership(db, { ...base, targetGithubUserId: 2n, role: "reviewer" }),
      ).rejects.toBeInstanceOf(TeamConflictError);
      await expect(
        changeTeamMembership(db, { ...base, expectedVersion: 3, targetGithubUserId: 1n }),
      ).rejects.toBeInstanceOf(TeamLastAdminError);
      await expect(setTeamMembership(db, installationId, 1n, false)).rejects.toBeInstanceOf(
        TeamLastAdminError,
      );
      await setTeamMembership(db, installationId, 5n, true, "admin");
      const removals = await Promise.allSettled(
        [1n, 5n].map((id) =>
          changeTeamMembership(db, {
            installationId,
            actor: actor(id),
            expectedVersion: 4,
            targetGithubUserId: id,
            role: "reviewer",
          }),
        ),
      );
      expect(removals.filter((value) => value.status === "fulfilled")).toHaveLength(1);
      const admins = await db.teamMember.findMany({ where: { workspaceId, role: "admin" } });
      expect(admins).toHaveLength(1);
      const survivingId = admins[0]?.githubUserId;
      if (!survivingId) throw new Error("No surviving admin");
      const demotedId = survivingId === 1n ? 5n : 1n;
      await expect(
        changeTeamMembership(db, {
          installationId,
          actor: actor(demotedId),
          expectedVersion: 5,
          targetGithubUserId: 2n,
          role: "admin",
        }),
      ).rejects.toBeInstanceOf(TeamPermissionError);
      await changeTeamMembership(db, {
        installationId,
        actor: actor(survivingId),
        expectedVersion: 5,
        targetGithubUserId: 2n,
        role: null,
      });
      expect(await readTeamSession(db, installationId, session)).toBeNull();
      await setTeamMembership(db, installationId, 2n, true, "reviewer");
      expect(await readTeamSession(db, installationId, session)).toBeNull();
      await expect(
        changeTeamMembership(db, {
          installationId,
          actor: actor(survivingId),
          expectedVersion: 5,
          targetGithubUserId: 2n,
          role: "admin",
        }),
      ).rejects.toBeInstanceOf(TeamConflictError);
      // Force the final audit insert to fail; preceding membership and version changes must roll back.
      const sentinel = randomUUID();
      await db.teamAccessEvent.create({
        data: {
          id: sentinel,
          workspaceId,
          version: 8,
          actorSource: "operator",
          targetGithubUserId: 99n,
          newRole: "viewer",
        },
      });
      await expect(setTeamMembership(db, installationId, 99n, true, "viewer")).rejects.toThrow();
      expect(await db.teamMember.count({ where: { workspaceId, githubUserId: 99n } })).toBe(0);
      expect(
        (await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } })).teamVersion,
      ).toBe(7);
      await db.teamAccessEvent.delete({ where: { id: sentinel } });
      const final = await readTeamDirectory(db, { installationId, actor: actor(survivingId) });
      expect(final.events).toHaveLength(7);
      expect(
        final.events.some((event) => event.githubUserId === "2" && event.newRole === null),
      ).toBe(true);
      // More than one page, with numeric (not lexical) ordering and bounded session/audit projections.
      for (let id = 10n; id < 62n; id++)
        await setTeamMembership(db, installationId, id, true, "viewer");
      const page1 = await readTeamDirectory(db, { installationId, actor: actor(survivingId) });
      expect(page1.members).toHaveLength(50);
      expect(page1.events).toHaveLength(20);
      expect(page1.nextCursor).not.toBeNull();
      const page2 = await readTeamDirectory(db, {
        installationId,
        actor: actor(survivingId),
        cursor: BigInt(page1.nextCursor as string),
      });
      expect(page2.nextCursor).toBeNull();
      expect(
        new Set([...page1.members, ...page2.members].map((member) => member.githubUserId)).size,
      ).toBe(await db.teamMember.count({ where: { workspaceId } }));
    } finally {
      await db.workspace.deleteMany({
        where: { id: { in: createdWorkspaceIds } },
      });
      await db.$disconnect();
      await second.$disconnect();
    }
  },
  30_000,
);

it.skipIf(!process.env.DATABASE_TEST_URL)(
  "reads one indexed latest login per member page instead of complete session histories",
  async () => {
    const db = new PrismaClient({
      datasourceUrl: process.env.DATABASE_TEST_URL,
      log: [{ emit: "event", level: "query" }],
    });
    const queries: { query: string; params: string }[] = [];
    db.$on("query", ({ query, params }) => queries.push({ query, params }));
    const installationId = BigInt(randomInt(1, 2 ** 47));
    const created: string[] = [];
    try {
      const own = await db.workspace.create({ data: { installationId, account: "paged-team" } });
      created.push(own.id);
      const foreign = await db.workspace.create({
        data: { installationId: installationId + BigInt(2 ** 47), account: "foreign-team" },
      });
      created.push(foreign.id);
      await db.teamMember.createMany({
        data: [
          ...Array.from({ length: 52 }, (_, i) => ({
            workspaceId: own.id,
            githubUserId: BigInt(i + 1),
            role: i === 0 ? ("admin" as const) : ("viewer" as const),
          })),
          { workspaceId: foreign.id, githubUserId: 1n, role: "admin" },
        ],
      });
      // Long histories and a timestamp tie exercise index stop and deterministic tie-breaking.
      await db.teamSession.createMany({
        data: [
          ...Array.from({ length: 52 }, (_, i) => i + 1)
            .filter((id) => id !== 2)
            .flatMap((id) =>
              Array.from({ length: 64 }, (_, index) => ({
                tokenHash: `private-session-${own.id}-${id}-${String(index).padStart(3, "0")}`,
                workspaceId: own.id,
                githubUserId: BigInt(id),
                login: index === 63 ? `latest-${id}` : `old-${id}`,
                createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, Math.min(index, 62))),
                expiresAt: new Date("2099-01-01"),
              })),
            ),
          {
            tokenHash: `private-session-${foreign.id}`,
            workspaceId: foreign.id,
            githubUserId: 1n,
            login: "foreign-newest",
            createdAt: new Date("2098-01-01"),
            expiresAt: new Date("2099-01-01"),
          },
        ],
      });
      queries.length = 0;
      const actor = { source: "member" as const, githubUserId: 1n, login: "latest-1" };
      const first = await readTeamDirectory(db, { installationId, actor });
      expect(first.members).toHaveLength(50);
      expect(first.nextCursor).toBe("50");
      expect(first.members[0]?.lastKnownLogin).toBe("latest-1");
      expect(first.members[1]?.lastKnownLogin).toBeNull();
      expect(first.members[49]?.lastKnownLogin).toBe("latest-50");
      expect(JSON.stringify(first)).not.toContain("private-session-");
      expect(JSON.stringify(first)).not.toContain("foreign-newest");
      const sessionReads = queries.filter(({ query }) => query.includes('FROM "TeamSession"'));
      expect(sessionReads).toHaveLength(1);
      const trace = sessionReads[0];
      if (!trace) throw new Error("Missing latest-session query trace");
      expect(trace.query).toContain("LEFT JOIN LATERAL");
      expect(trace.query).toMatch(/SELECT s\.login FROM "TeamSession"/);
      // EXPLAIN the exact emitted query with its bound identities, not a hand-written approximation.
      const params = JSON.parse(trace.params) as [string, string, string];
      type Plan = {
        "Node Type": string;
        "Actual Rows": number;
        "Actual Loops": number;
        "Index Name"?: string;
        Output?: string[];
        Plans?: Plan[];
      };
      const explained = await db.$queryRawUnsafe<{ "QUERY PLAN": { Plan: Plan }[] }[]>(
        `EXPLAIN (ANALYZE, VERBOSE, FORMAT JSON) ${trace.query}`,
        params[0],
        BigInt(params[1]),
        params[2],
      );
      const plan = explained[0]?.["QUERY PLAN"][0]?.Plan;
      if (!plan) throw new Error("Missing directory query plan");
      const flatten = (node: Plan): Plan[] => [node, ...(node.Plans ?? []).flatMap(flatten)];
      const nodes = flatten(plan);
      expect(plan["Actual Rows"]).toBe(51);
      expect(plan.Output?.join(" ")).not.toContain("tokenHash");
      const sessionLookup = nodes.find(
        (node) => node["Index Name"] === "TeamSession_member_latest_idx",
      );
      expect(sessionLookup).toBeDefined();
      expect(sessionLookup?.["Actual Loops"]).toBe(51);
      expect(sessionLookup?.["Actual Rows"]).toBeLessThanOrEqual(1);
      expect(
        nodes.some((node) => node["Node Type"] === "Limit" && node["Actual Loops"] === 51),
      ).toBe(true);
      const second = await readTeamDirectory(db, { installationId, actor, cursor: 50n });
      expect(second.members.map((member) => [member.githubUserId, member.lastKnownLogin])).toEqual([
        ["51", "latest-51"],
        ["52", "latest-52"],
      ]);
      expect(second.nextCursor).toBeNull();
    } finally {
      await db.workspace.deleteMany({ where: { id: { in: created } } });
      await db.$disconnect();
    }
  },
  30_000,
);
