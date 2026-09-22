import type { AnalysisReport } from "@groundskeeper/contracts";
import { describe, expect, it } from "vitest";
import { type AnalysisCheckInput, publishAnalysisCheck } from "./check-run.js";

const sha = "a".repeat(40);
function input(count = 1): AnalysisCheckInput {
  const claims: AnalysisReport["claims"] = Array.from({ length: count }, (_, n) => ({
    id: `claim${n}`,
    page: "README.md",
    anchor: "example",
    kind: "code",
    text: "SECRET_SOURCE",
    position: { start_line: n + 1, end_line: n + 1, start_column: 1, end_column: 20 },
  }));
  return {
    fullName: "acme/sdk",
    repositoryId: 1,
    appId: 5,
    analysisRunId: "analysis-1",
    afterCommit: sha,
    report: {
      claims,
      symbols: [],
      links: [],
      changed_symbol_ids: [],
      impacts: claims.map((claim) => ({
        claim_id: claim.id,
        symbol_ids: [],
        reason: "SECRET_REASON",
      })),
      warnings: ["SECRET_WARNING"],
      health: {
        total_claims: -5,
        affected_claims: -2,
        linked_claims: 0,
        link_coverage: 0,
        verified_share: 1,
        statuses: { verified: -1 },
      },
    },
  };
}
function fake() {
  const check = {
    id: 9,
    name: "Groundskeeper documentation",
    head_sha: sha,
    external_id: "analysis-1",
    html_url: "https://github.com/acme/sdk/runs/9",
    status: "completed",
    conclusion: "neutral",
    app: { id: 5 },
  };
  const state = {
    existing: false,
    wrongRepo: false,
    foreignApp: false,
    green: false,
    incomplete: false,
    deny: false,
    loseResponse: false,
    twoPages: false,
  };
  const calls: { route: string; params: Record<string, unknown> }[] = [];
  return {
    state,
    calls,
    async request(route: string, params: Record<string, unknown>): Promise<{ data: unknown }> {
      calls.push({ route, params });
      if (state.deny) throw new Error("SECRET_TOKEN");
      if (route === "GET /repos/{owner}/{repo}")
        return { data: { id: state.wrongRepo ? 2 : 1, full_name: "acme/sdk" } };
      if (route.includes("/git/commits/")) return { data: { sha } };
      if (route.startsWith("GET") && route.endsWith("/check-runs")) {
        if (state.twoPages) {
          const checks =
            params.page === 1
              ? Array.from({ length: 100 }, (_, i) => ({
                  ...check,
                  id: i + 100,
                  external_id: `other-${i}`,
                }))
              : [check];
          return { data: { total_count: 101, check_runs: checks } };
        }
        return {
          data: {
            total_count: state.incomplete ? 101 : state.existing ? 1 : 0,
            check_runs: state.existing
              ? [
                  {
                    ...check,
                    app: { id: state.foreignApp ? 6 : 5 },
                    conclusion: state.green ? "success" : "neutral",
                  },
                ]
              : [],
          },
        };
      }
      if (route === "POST /repos/{owner}/{repo}/check-runs") {
        state.existing = true;
        if (state.loseResponse) {
          state.loseResponse = false;
          throw new Error("lost response");
        }
        return { data: check };
      }
      throw new Error("Unexpected route");
    },
  };
}
describe("informational analysis checks", () => {
  it("publishes truthful neutral metadata without raw source, warning, or reason", async () => {
    const client = fake();
    expect(await publishAnalysisCheck(client, input())).toEqual({
      id: 9,
      url: "https://github.com/acme/sdk/runs/9",
      reused: false,
    });
    const posted = client.calls.find((c) => c.route.startsWith("POST"))?.params;
    expect(posted).toMatchObject({
      status: "completed",
      conclusion: "neutral",
      external_id: "analysis-1",
      head_sha: sha,
    });
    expect(JSON.stringify(posted)).not.toContain("SECRET");
    expect(JSON.stringify(posted)).not.toContain("-5");
    expect(posted).not.toHaveProperty("details_url");
  });
  it("never turns an empty candidate report into a green execution check", async () => {
    const client = fake();
    await publishAnalysisCheck(client, input(0));
    expect(client.calls.at(-1)?.params).toMatchObject({
      conclusion: "neutral",
      output: { title: "No candidate documentation drift found" },
    });
  });
  it("caps annotations at 50 and omits invalid paths and ranges", async () => {
    const client = fake(),
      value = input(60);
    const [first, second, third] = value.report.claims;
    if (!first || !second || !third) throw new Error("Missing fixture claims");
    first.page = "../secret.md";
    second.position.start_line = 0;
    third.position.end_line = 1;
    await publishAnalysisCheck(client, value);
    const output = client.calls.at(-1)?.params.output as {
      annotations: { path: string; start_line: number; end_line: number }[];
    };
    expect(output.annotations).toHaveLength(50);
    expect(output.annotations[0]?.start_line).toBe(4);
    expect(
      output.annotations.every(
        (a) => a.start_line > 0 && a.end_line >= a.start_line && !a.path.startsWith(".."),
      ),
    ).toBe(true);
  });
  it("reuses matching checks including those found on a second page", async () => {
    for (const key of ["existing", "twoPages"] as const) {
      const client = fake();
      client.state[key] = true;
      expect((await publishAnalysisCheck(client, input())).reused).toBe(true);
      expect(client.calls.some((c) => c.route.startsWith("POST"))).toBe(false);
    }
  });
  it("recovers a lost creation response without duplicating the check", async () => {
    const client = fake();
    client.state.loseResponse = true;
    await expect(publishAnalysisCheck(client, input())).rejects.toThrow("retry the same");
    expect((await publishAnalysisCheck(client, input())).reused).toBe(true);
    expect(client.calls.filter((c) => c.route.startsWith("POST"))).toHaveLength(1);
  });
  it.each(["wrongRepo", "foreignApp", "green", "incomplete"] as const)(
    "fails closed for %s without writing",
    async (flag) => {
      const client = fake();
      client.state.existing = true;
      client.state[flag] = true;
      await expect(publishAnalysisCheck(client, input())).rejects.toThrow();
      expect(client.calls.some((c) => c.route.startsWith("POST"))).toBe(false);
    },
  );
  it("validates immutable identity before requests and sanitizes remote failures", async () => {
    const client = fake();
    await expect(publishAnalysisCheck(client, { ...input(), afterCommit: "main" })).rejects.toThrow(
      "identity",
    );
    expect(client.calls).toHaveLength(0);
    client.state.deny = true;
    await expect(publishAnalysisCheck(client, input())).rejects.toThrow(
      "Stored analysis remains available",
    );
    await expect(publishAnalysisCheck(client, input())).rejects.not.toThrow("SECRET_TOKEN");
  });
});
