import { randomUUID } from "node:crypto";
import { PrismaClient } from "@groundskeeper/database/client";
import { expect, it } from "vitest";
import { readLiveDashboard } from "./dashboard-data";
import { parseInboxQuery, readReviewInbox } from "./review-inbox-data";
import { readRunList } from "./run-list-query";

it.skipIf(!process.env.DATABASE_TEST_URL)(
  "Postgres run pages bound verification history and preserve tenant, exact filters and UTC keysets",
  async () => {
    const admin = new PrismaClient({ datasourceUrl: process.env.DATABASE_TEST_URL });
    const schema = `run_list_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(process.env.DATABASE_TEST_URL as string);
    url.searchParams.set("schema", schema);
    url.searchParams.set("options", "-c timezone=Asia/Tokyo");
    const db = new PrismaClient({
      datasourceUrl: url.toString(),
      log: [{ emit: "event", level: "query" }],
    });
    const queries: { query: string; params: string }[] = [];
    db.$on("query", (event) => queries.push({ query: event.query, params: event.params }));
    const at = new Date("2026-10-03T10:00:00.000Z");
    const runs = Array.from({ length: 26 }, (_, index) => ({
      id: `run-${String(index).padStart(2, "0")}`,
      repositoryId: "own-repo",
      deliveryId: `delivery-${index}`,
      inputDigest: "digest",
      beforeCommit: "a",
      afterCommit: "b",
      createdAt: at,
      report: {
        health: { affected_claims: 0, total_claims: 1 },
        private: "RAW_ANALYSIS_SHOULD_NOT_TRANSFER",
      },
    }));
    const firstRun = runs[0];
    if (!firstRun) throw new Error("Missing fixture run");
    const reviews = runs
      .filter((_, index) => index % 5 !== 0)
      .map((run, index) => ({
        analysisRunId: run.id,
        owner: index % 3 === 0 ? "a_%" : index % 3 === 1 ? "Alice" : "",
        note: `${"🙂".repeat(160)}PRIVATE_NOTE_TAIL`,
        dismissed: index % 2 === 0,
        version: 1,
        updatedAt: at,
      }));
    const query = (params = "") => parseInboxQuery(`https://example.test/api/reviews${params}`);
    try {
      await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      for (const table of [
        "Workspace",
        "Repository",
        "AnalysisRun",
        "VerificationRun",
        "SharedReview",
        "WebhookDelivery",
      ])
        await admin.$executeRawUnsafe(
          `CREATE TABLE "${schema}"."${table}" (LIKE "${table}" INCLUDING ALL)`,
        );
      await db.workspace.createMany({
        data: [
          { id: "own", installationId: 42n, account: "own" },
          { id: "foreign", installationId: 99n, account: "foreign" },
        ],
      });
      await db.repository.createMany({
        data: [
          {
            id: "own-repo",
            workspaceId: "own",
            githubId: 1n,
            fullName: "org/sdk",
            defaultBranch: "main",
          },
          {
            id: "foreign-repo",
            workspaceId: "foreign",
            githubId: 2n,
            fullName: "org/sdk",
            defaultBranch: "main",
          },
        ],
      });
      await db.analysisRun.createMany({
        data: [
          ...runs,
          { ...firstRun, id: "foreign-run", deliveryId: "foreign", repositoryId: "foreign-repo" },
        ],
      });
      await db.sharedReview.createMany({ data: reviews });
      await db.verificationRun.createMany({
        data: runs.flatMap((run) =>
          Array.from({ length: 80 }, (_, index) => ({
            id: `${run.id}-verification-${String(index).padStart(3, "0")}`,
            analysisRunId: run.id,
            sourceDigest: "digest",
            inputDigest: "digest",
            // Same timestamp exercises the deterministic ID tiebreaker.
            createdAt: at,
            report: {
              evidence: [{ outcome: index === 79 ? "passed" : "failed", stdout: "RAW_EXECUTION" }],
            },
          })),
        ),
      });
      // A newer inconclusive result must not fall back to older passing evidence.
      await db.verificationRun.create({
        data: {
          id: "latest-inconclusive",
          analysisRunId: "run-25",
          sourceDigest: "digest",
          inputDigest: "digest",
          createdAt: new Date(at.getTime() + 1),
          report: { evidence: [] },
        },
      });
      for (const table of ["AnalysisRun", "VerificationRun", "Repository", "SharedReview"])
        await db.$executeRawUnsafe(`ANALYZE "${table}"`);

      queries.length = 0;
      const projected = await readRunList(db, 42n, 21, query("?status=all"));
      expect(projected).toHaveLength(21);
      expect(queries).toHaveLength(1);
      const statement = queries[0];
      if (!statement) throw new Error("Missing captured statement");
      expect(statement.query).not.toContain('"report"');
      expect(JSON.stringify(projected)).not.toMatch(/RAW_ANALYSIS|RAW_EXECUTION|PRIVATE_NOTE_TAIL/);
      expect(projected.every((run) => run.verificationRuns.length === 1)).toBe(true);
      const plan = await db.$queryRawUnsafe<
        { "QUERY PLAN": { Plan: Record<string, unknown> }[] }[]
      >(`EXPLAIN (ANALYZE, FORMAT JSON) ${statement.query}`, ...JSON.parse(statement.params));
      const nodes: Record<string, unknown>[] = [];
      const visit = (node: Record<string, unknown>) => {
        nodes.push(node);
        for (const child of (node.Plans ?? []) as Record<string, unknown>[]) visit(child);
      };
      const rootPlan = plan[0]?.["QUERY PLAN"][0]?.Plan;
      if (!rootPlan) throw new Error("Missing query plan");
      visit(rootPlan);
      const verificationScan = nodes.find((node) => node["Relation Name"] === "VerificationRun");
      expect(verificationScan).toMatchObject({
        "Node Type": "Index Scan",
        "Scan Direction": "Backward",
        "Actual Rows": 1,
        "Actual Loops": 21,
      });
      // 2,081 historical verification rows exist; only one indexed row per page run is read.
      expect(await db.verificationRun.count()).toBe(2081);

      const first = await readReviewInbox(42n, url.toString(), query("?status=all"));
      expect(first.rows.map((row) => row.id)).toEqual(
        runs
          .toReversed()
          .slice(0, 20)
          .map((run) => run.id),
      );
      expect(first.rows[0]?.status).toBe("unknown");
      expect(first.rows[1]?.status).toBe("verified");
      expect(first.rows.every((row) => row.review.noteSnippet.length <= 160)).toBe(true);
      expect(first.rows.some((row) => row.review.noteSnippet === "🙂".repeat(80))).toBe(true);
      // A new result above the page must not shift a keyset traversal.
      await db.analysisRun.create({
        data: {
          ...firstRun,
          id: "newer-run",
          deliveryId: "newer",
          createdAt: new Date(at.getTime() + 1),
        },
      });
      const next = await readReviewInbox(
        42n,
        url.toString(),
        query(`?status=all&cursor=${first.nextCursor}`),
      );
      expect(next.rows.map((row) => row.id)).toEqual(
        runs
          .toReversed()
          .slice(20)
          .map((run) => run.id),
      );
      expect(next.nextCursor).toBeNull();
      const older = {
        ...firstRun,
        id: "older-run",
        deliveryId: "older",
        createdAt: new Date(at.getTime() - 1),
      };
      await db.analysisRun.create({ data: older });
      const afterOldCursor = await readReviewInbox(
        42n,
        url.toString(),
        query(`?status=all&cursor=${first.nextCursor}`),
      );
      expect(afterOldCursor.rows.at(-1)?.id).toBe("older-run");

      const candidates = [...runs, { ...firstRun, id: "newer-run" }, older];
      for (const [params, include] of [
        [
          "?status=dismissed&repository=ORG/SDK",
          (review: (typeof reviews)[number] | undefined) => !!review?.dismissed,
        ],
        [
          "?status=all&owner=ALICE",
          (review: (typeof reviews)[number] | undefined) => review?.owner === "Alice",
        ],
        [
          "?status=all&owner=a_%25",
          (review: (typeof reviews)[number] | undefined) => review?.owner === "a_%",
        ],
        [
          "?unassigned=true",
          (review: (typeof reviews)[number] | undefined) =>
            !review || (!review.dismissed && review.owner === ""),
        ],
      ] as const) {
        const result = await readReviewInbox(42n, url.toString(), query(params));
        expect(result.rows.map((row) => row.id).sort()).toEqual(
          candidates
            .filter((run) => include(reviews.find((review) => review.analysisRunId === run.id)))
            .map((run) => run.id)
            .sort(),
        );
      }
      const literalInjection = await readReviewInbox(
        42n,
        url.toString(),
        query("?status=all&owner='OR%201=1--"),
      );
      expect(literalInjection.rows).toEqual([]);
      expect(
        (await readReviewInbox(42n, url.toString(), query("?repository=foreign/repo"))).rows,
      ).toEqual([]);
      expect((await readReviewInbox(777n, url.toString(), query("?status=all"))).rows).toEqual([]);
      const dashboard = await readLiveDashboard(42n, url.toString());
      expect(dashboard.runs).toHaveLength(28);
      expect(dashboard.runs.some((run) => run.id === "foreign-run")).toBe(false);
      expect(dashboard.runs.find((run) => run.id === "newer-run")?.status).toBe("unknown");
      expect(JSON.stringify(dashboard)).not.toMatch(/RAW_ANALYSIS|RAW_EXECUTION|PRIVATE_NOTE_TAIL/);
    } finally {
      await db.$disconnect();
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.$disconnect();
    }
  },
  30_000,
);
