import type { DashboardData } from "./dashboard-types";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 4096;
const date = (value: unknown): value is string =>
  text(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const list = (value: unknown, maximum: number, validate: (item: unknown) => boolean): boolean =>
  Array.isArray(value) && value.length <= maximum && value.every(validate);
const member = (value: unknown, values: string[]) =>
  typeof value === "string" && values.includes(value);

/** Validate all displayed fields before replacing the last known good response. */
export function isDashboardData(value: unknown): value is DashboardData {
  if (!record(value)) return false;
  return (
    member(value.mode, ["demo", "live"]) &&
    date(value.generatedAt) &&
    list(
      value.repositories,
      50,
      (repo) =>
        record(repo) &&
        text(repo.id) &&
        text(repo.name) &&
        text(repo.fullName) &&
        text(repo.defaultBranch),
    ) &&
    list(
      value.runs,
      50,
      (run) =>
        record(run) &&
        text(run.id) &&
        record(run.repository) &&
        text(run.repository.name) &&
        text(run.repository.fullName) &&
        text(run.beforeCommit) &&
        text(run.afterCommit) &&
        date(run.createdAt) &&
        count(run.affectedClaims) &&
        count(run.totalClaims) &&
        run.affectedClaims <= run.totalClaims &&
        member(run.status, ["needs-review", "verified", "unknown"]) &&
        list(
          run.evidence,
          100,
          (evidence) =>
            record(evidence) &&
            text(evidence.id) &&
            text(evidence.label) &&
            member(evidence.status, ["passed", "failed", "skipped", "error"]) &&
            text(evidence.detail),
        ),
    ) &&
    list(
      value.queue,
      50,
      (item) =>
        record(item) &&
        text(item.id) &&
        text(item.repository) &&
        text(item.event) &&
        member(item.status, ["pending", "processing", "retrying", "failed"]) &&
        count(item.attempts) &&
        date(item.receivedAt) &&
        (item.nextAttemptAt === null || date(item.nextAttemptAt)),
    )
  );
}

export async function fetchDashboard(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DashboardData> {
  let response: Response;
  try {
    response = await fetchImpl("/api/dashboard", {
      method: "GET",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error(
      "Live data is unavailable. Check your connection and retry; your last loaded data is unchanged.",
    );
  }
  if (response.status === 401)
    throw new Error("Access token was not accepted. Enter a valid dashboard token and retry.");
  if (!response.ok)
    throw new Error("Dashboard data is temporarily unavailable. Retry or switch to demo.");
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error("Dashboard returned an invalid response. Your last loaded data is unchanged.");
  }
  if (!isDashboardData(data))
    throw new Error("Dashboard returned an invalid response. Your last loaded data is unchanged.");
  return data;
}
