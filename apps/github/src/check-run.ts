import type { AnalysisReport } from "@groundskeeper/contracts";
import type { GitHubReader } from "./snapshots.js";

const NAME = "Groundskeeper documentation";
export interface AnalysisCheckInput {
  fullName: string;
  repositoryId: number;
  appId: number;
  analysisRunId: string;
  afterCommit: string;
  report: AnalysisReport;
}
interface CheckRun {
  id: number;
  name: string;
  head_sha: string;
  external_id: string;
  html_url: string;
  status: string;
  conclusion: string;
  app: { id: number };
}
class CheckError extends Error {}
function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CheckError(message);
}
function positive(value: number) {
  return Number.isSafeInteger(value) && value > 0;
}

/** Informational analysis only. This check never asserts execution or documentation correctness. */
export async function publishAnalysisCheck(
  client: GitHubReader,
  input: AnalysisCheckInput,
): Promise<{ id: number; url: string; reused: boolean }> {
  try {
    ensure(
      /^[\w.-]+\/[\w.-]+$/.test(input.fullName) &&
        positive(input.repositoryId) &&
        positive(input.appId) &&
        /^[a-f0-9]{40}$/.test(input.afterCommit) &&
        /^[\w-]{1,100}$/.test(input.analysisRunId),
      "Invalid analysis check identity",
    );
    const { claims, impacts, warnings } = input.report;
    ensure(
      Array.isArray(claims) &&
        Array.isArray(impacts) &&
        Array.isArray(warnings) &&
        claims.length <= 100_000 &&
        impacts.length <= 100_000,
      "Invalid analysis report",
    );
    const byId = new Map(claims.map((claim) => [claim.id, claim]));
    ensure(
      byId.size === claims.length && impacts.every((impact) => byId.has(impact.claim_id)),
      "Analysis contains ambiguous or missing claims",
    );
    const affected = [...new Set(impacts.map((impact) => impact.claim_id))];
    const annotations = affected
      .flatMap((id) => {
        const claim = byId.get(id);
        if (!claim) return [];
        const { page, position } = claim;
        const validPath =
          typeof page === "string" &&
          page.length <= 1024 &&
          !page.startsWith("/") &&
          !page.includes("\\") &&
          [...page].every((char) => char.charCodeAt(0) >= 32) &&
          page.split("/").every((part) => part && part !== "." && part !== ".." && part !== ".git");
        if (
          !validPath ||
          !position ||
          !positive(position.start_line) ||
          !positive(position.end_line) ||
          position.end_line < position.start_line ||
          position.end_line > 2_147_483_647
        )
          return [];
        return [
          {
            path: page,
            start_line: position.start_line,
            end_line: position.end_line,
            annotation_level: "notice",
            title: "Documentation may need review",
            message:
              "This claim references code affected by the analyzed change. This is a candidate finding; execution and correctness have not been established by this check.",
          },
        ];
      })
      .slice(0, 50);
    const [owner, repo] = input.fullName.split("/");
    const deadline = Date.now() + 120_000;
    async function request<T>(route: string, params: Record<string, unknown> = {}): Promise<T> {
      const remaining = deadline - Date.now();
      ensure(remaining > 0, "Check publication timed out; retry the same analysis run");
      return (
        await client.request(route, {
          owner,
          repo,
          ...params,
          request: { timeout: Math.min(15_000, remaining), signal: AbortSignal.timeout(remaining) },
        })
      ).data as T;
    }
    const repository = await request<{ id: number; full_name: string }>(
      "GET /repos/{owner}/{repo}",
    );
    ensure(
      repository.id === input.repositoryId &&
        repository.full_name.toLowerCase() === input.fullName.toLowerCase(),
      "Check repository identity changed",
    );
    const commit = await request<{ sha: string }>(
      "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
      { commit_sha: input.afterCommit },
    );
    ensure(commit.sha === input.afterCommit, "Check commit does not match analysis");
    const existing: CheckRun[] = [];
    let total: number | undefined;
    for (let page = 1; ; page++) {
      ensure(page <= 10, "Check history exceeds the bounded lookup; no check was created");
      const response = await request<{ total_count: number; check_runs: CheckRun[] }>(
        "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
        {
          ref: input.afterCommit,
          check_name: NAME,
          app_id: input.appId,
          filter: "all",
          per_page: 100,
          page,
        },
      );
      ensure(
        Number.isSafeInteger(response.total_count) &&
          response.total_count >= 0 &&
          response.total_count <= 1000 &&
          Array.isArray(response.check_runs) &&
          response.check_runs.length <= 100 &&
          (total === undefined || response.total_count === total),
        "Check history is incomplete or changed; retry publication",
      );
      total = response.total_count;
      existing.push(...response.check_runs);
      ensure(
        existing.length <= total &&
          new Set(existing.map((check) => check.id)).size === existing.length,
        "Check history contains inconsistent results",
      );
      if (existing.length === total) break;
      ensure(
        response.check_runs.length === 100,
        "Check history is incomplete; no check was created",
      );
    }
    // Refuse foreign-app responses even if a provider ignored the filter.
    ensure(
      existing.every(
        (check) =>
          check.app?.id === input.appId &&
          check.name === NAME &&
          check.head_sha === input.afterCommit,
      ),
      "Check history does not match this app and commit",
    );
    const matches = existing.filter((check) => check.external_id === input.analysisRunId);
    ensure(
      matches.length <= 1,
      "Multiple checks already reference this analysis; review them manually",
    );
    function result(check: CheckRun, reused: boolean) {
      ensure(
        positive(check.id) &&
          check.name === NAME &&
          check.head_sha === input.afterCommit &&
          check.external_id === input.analysisRunId &&
          check.app?.id === input.appId &&
          check.status === "completed" &&
          check.conclusion === "neutral",
        "Existing or created check does not match informational analysis",
      );
      const url = new URL(check.html_url);
      ensure(
        url.origin === "https://github.com" &&
          !url.username &&
          !url.password &&
          url.pathname.startsWith(`/${repository.full_name}/`) &&
          !url.search &&
          !url.hash,
        "Invalid check URL",
      );
      return { id: check.id, url: url.href, reused };
    }
    if (matches[0]) return result(matches[0], true);
    const created = await request<CheckRun>("POST /repos/{owner}/{repo}/check-runs", {
      name: NAME,
      head_sha: input.afterCommit,
      external_id: input.analysisRunId,
      status: "completed",
      conclusion: "neutral",
      output: {
        title: affected.length
          ? `${affected.length} documentation claims need review`
          : "No candidate documentation drift found",
        summary: `${claims.length} claims analyzed; ${affected.length} candidate impacts; ${warnings.length} analysis warnings.\n\nThis informational check does not verify examples or prove documentation correctness. ${annotations.length} of ${affected.length} candidate findings are annotated (maximum 50; invalid source ranges omitted).\n\nAnalysis run: ${input.analysisRunId}\nCommit: ${input.afterCommit}`,
        annotations,
      },
    });
    return result(created, false);
  } catch (error) {
    if (error instanceof CheckError) throw error;
    throw new CheckError(
      "GitHub check publication failed; check app permissions and connectivity, then retry the same analysis run. Stored analysis remains available.",
    );
  }
}
