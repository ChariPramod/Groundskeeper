import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { readAnalysisSummary, readVerificationSummary } from "./report-summaries.js";

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
// Test-only oracle follows the previous JS report projection; production derives only in SQL.
function legacyAnalysis(value: unknown) {
  const health = object(object(value).health);
  return {
    version: 1,
    affectedClaims: count(health.affected_claims),
    totalClaims: count(health.total_claims),
  };
}
function legacyVerification(value: unknown) {
  const evidence = object(value).evidence;
  const all = Array.isArray(evidence) ? evidence : [];
  return {
    version: 1,
    evidenceCount: all.length,
    outcomes: all.slice(0, 100).map((item) => {
      const outcome = object(item).outcome;
      return typeof outcome === "string" &&
        ["passed", "failed", "skipped", "error"].includes(outcome)
        ? outcome
        : "error";
    }),
    allPassed: all.length > 0 && all.every((item) => object(item).outcome === "passed"),
    hasFailed: all.some((item) => object(item).outcome === "failed"),
  };
}
describe("summary boundary validation", () => {
  it("rejects unsafe counts, versions and false passing verdicts", () => {
    for (const value of [
      null,
      [],
      {},
      { version: 2, totalClaims: 0, affectedClaims: 0 },
      { version: 1, totalClaims: Number.MAX_SAFE_INTEGER + 1, affectedClaims: 0 },
      { version: 1, totalClaims: 1.5, affectedClaims: 0 },
    ])
      expect(readAnalysisSummary(value)).toBeNull();
    const valid = legacyVerification({ evidence: [{ outcome: "passed" }] });
    for (const value of [
      null,
      {},
      { ...valid, version: 2 },
      { ...valid, evidenceCount: 0 },
      { ...valid, outcomes: ["failed"] },
      { ...valid, outcomes: [["passed"]] },
      { ...valid, outcomes: ["other"] },
      { ...valid, hasFailed: true },
    ])
      expect(readVerificationSummary(value)).toBeNull();
    expect(readVerificationSummary(valid)).toEqual(valid);
  });
});

it.skipIf(!process.env.DATABASE_TEST_URL)(
  "Postgres generated summaries backfill legacy JSON, preserve full-array verdicts and reduce transferred bytes",
  async () => {
    const db = new PrismaClient({ datasourceUrl: process.env.DATABASE_TEST_URL });
    const schema = `summary_${randomUUID().replaceAll("-", "")}`;
    // The functions were installed by migrations in the test connection's configured schema.
    const namespace =
      new URL(process.env.DATABASE_TEST_URL as string).searchParams.get("schema") ?? "public";
    const quotedNamespace = `"${namespace.replaceAll('"', '""')}"`;
    const analysisCases: unknown[] = [
      null,
      [],
      {},
      { health: null },
      { health: [] },
      { health: { total_claims: "3", affected_claims: -1 } },
      { health: { total_claims: 1.5, affected_claims: null } },
      { health: { total_claims: Number.MAX_SAFE_INTEGER, affected_claims: 2 } },
      { health: { total_claims: Number.MAX_SAFE_INTEGER + 1, affected_claims: 1e100 } },
      {
        health: { total_claims: 200, affected_claims: 7 },
        claims: Array.from({ length: 200 }, () => ({ text: "private".repeat(350) })),
      },
    ];
    const passed = Array.from({ length: 100 }, () => ({ outcome: "passed" }));
    const verificationCases: unknown[] = [
      null,
      [],
      {},
      { evidence: {} },
      { evidence: [] },
      { evidence: [null, {}, { outcome: ["passed"] }, { outcome: 1 }, { outcome: "other" }] },
      ...["passed", "failed", "skipped", "error"].map((outcome) => ({
        evidence: [...passed, { outcome }],
      })),
      {
        evidence: Array.from({ length: 150 }, () => ({
          outcome: "passed",
          stdout: "private".repeat(350),
        })),
      },
    ];
    try {
      await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      for (const [table, cases, fn, oracle] of [
        ["Analysis", analysisCases, "gk_analysis_summary_v1", legacyAnalysis],
        ["Verification", verificationCases, "gk_verification_summary_v1", legacyVerification],
      ] as const) {
        await db.$executeRawUnsafe(
          `CREATE TABLE "${schema}"."${table}" (id INTEGER PRIMARY KEY, report JSONB NOT NULL)`,
        );
        for (const [id, report] of cases.entries())
          await db.$executeRawUnsafe(
            `INSERT INTO "${schema}"."${table}" (id, report) VALUES ($1, $2::jsonb)`,
            id,
            JSON.stringify(report),
          );
        // The migration's generated-column mechanism backfills rows that predate the column.
        await db.$executeRawUnsafe(
          `ALTER TABLE "${schema}"."${table}" ADD COLUMN summary JSONB GENERATED ALWAYS AS (${quotedNamespace}.${fn}(report)) STORED NOT NULL`,
        );
        const rows = await db.$queryRawUnsafe<{ id: number; report: unknown; summary: unknown }[]>(
          `SELECT id, report, summary FROM "${schema}"."${table}" ORDER BY id`,
        );
        expect(rows).toHaveLength(cases.length);
        for (const row of rows) {
          expect(row.report).toEqual(cases[row.id]);
          expect(row.summary).toEqual(oracle(row.report));
          expect(
            table === "Analysis"
              ? readAnalysisSummary(row.summary)
              : readVerificationSummary(row.summary),
          ).toEqual(row.summary);
        }
        // Every new writer gets the same summary; no app callback, queue or manual refresh.
        await db.$executeRawUnsafe(
          `INSERT INTO "${schema}"."${table}" (id, report) VALUES ($1, $2::jsonb)`,
          cases.length,
          JSON.stringify(cases.at(-1)),
        );
        const inserted = await db.$queryRawUnsafe<{ summary: unknown }[]>(
          `SELECT summary FROM "${schema}"."${table}" WHERE id = $1`,
          cases.length,
        );
        expect(inserted[0]?.summary).toEqual(oracle(cases.at(-1)));
        await expect(
          db.$executeRawUnsafe(
            `UPDATE "${schema}"."${table}" SET summary = '{}'::jsonb WHERE id = 0`,
          ),
        ).rejects.toThrow();
        const sizes = await db.$queryRawUnsafe<{ reportBytes: number; summaryBytes: number }[]>(
          `SELECT octet_length(report::text) AS "reportBytes", octet_length(summary::text) AS "summaryBytes" FROM "${schema}"."${table}" WHERE id = $1`,
          cases.length,
        );
        const size = sizes[0];
        expect(size).toBeDefined();
        if (!size) throw new Error("No transfer measurement");
        expect(size.summaryBytes).toBeLessThan(size.reportBytes / 100);
        console.log(
          `Compact ${table.toLowerCase()} JSON: ${size.reportBytes} report bytes → ${size.summaryBytes} summary bytes (${(100 * (1 - size.summaryBytes / size.reportBytes)).toFixed(2)}% fewer), measured in PostgreSQL.`,
        );
      }
      // Extremely large legacy JSON numbers must not abort migration backfill.
      const extreme = await db.$queryRawUnsafe<{ summary: unknown }[]>(
        `SELECT ${quotedNamespace}.gk_analysis_summary_v1('{"health":{"total_claims":1e1000,"affected_claims":2}}'::jsonb) AS summary`,
      );
      expect(extreme[0]?.summary).toEqual({ version: 1, totalClaims: 0, affectedClaims: 2 });
    } finally {
      await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await db.$disconnect();
    }
  },
  30_000,
);
