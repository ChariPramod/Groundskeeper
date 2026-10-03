export interface OperationsData {
  mode: "demo" | "live";
  installationId: string;
  generatedAt: string;
  workerStatus: "unknown";
  queue: {
    pending: number;
    processing: number;
    retrying: number;
    failed: number;
    stalled: number;
    total: number;
    oldestUnfinishedAt: string | null;
  };
  analyses: { completedLast24Hours: number; latestAt: string | null };
  jobs: {
    id: string;
    event: "push" | "pull_request";
    status: "failed" | "stalled";
    attempts: number;
    receivedAt: string;
    nextAttemptAt: string | null;
  }[];
}
const date = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
const nullableDate = (v: unknown) => v === null || date(v);
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export function isOperationsData(value: unknown): value is OperationsData {
  if (
    !object(value) ||
    !["live", "demo"].includes(String(value.mode)) ||
    value.workerStatus !== "unknown" ||
    typeof value.installationId !== "string" ||
    !/^[1-9]\d{0,18}$/.test(value.installationId) ||
    !date(value.generatedAt) ||
    !object(value.queue) ||
    !object(value.analyses) ||
    !Array.isArray(value.jobs) ||
    value.jobs.length > 10
  )
    return false;
  const q = value.queue;
  if (
    ![q.pending, q.processing, q.retrying, q.failed, q.stalled, q.total].every(count) ||
    (q.pending as number) +
      (q.processing as number) +
      (q.retrying as number) +
      (q.failed as number) !==
      q.total ||
    (q.stalled as number) > (q.total as number) ||
    !nullableDate(q.oldestUnfinishedAt) ||
    !count(value.analyses.completedLast24Hours) ||
    !nullableDate(value.analyses.latestAt)
  )
    return false;
  return value.jobs.every(
    (job) =>
      object(job) &&
      typeof job.id === "string" &&
      job.id.length > 0 &&
      job.id.length <= 200 &&
      ["push", "pull_request"].includes(String(job.event)) &&
      ["failed", "stalled"].includes(String(job.status)) &&
      count(job.attempts) &&
      date(job.receivedAt) &&
      nullableDate(job.nextAttemptAt),
  );
}
export function demoOperations(): OperationsData {
  return {
    mode: "demo",
    installationId: "42",
    generatedAt: "2026-10-02T12:00:00.000Z",
    workerStatus: "unknown",
    queue: {
      pending: 3,
      processing: 1,
      retrying: 2,
      failed: 1,
      stalled: 1,
      total: 7,
      oldestUnfinishedAt: "2026-10-02T10:00:00.000Z",
    },
    analyses: { completedLast24Hours: 18, latestAt: "2026-10-02T11:58:00.000Z" },
    jobs: [
      {
        id: "sample-failed-delivery",
        event: "push",
        status: "failed",
        attempts: 5,
        receivedAt: "2026-10-02T10:00:00.000Z",
        nextAttemptAt: null,
      },
      {
        id: "sample-stalled-delivery",
        event: "pull_request",
        status: "stalled",
        attempts: 2,
        receivedAt: "2026-10-02T11:20:00.000Z",
        nextAttemptAt: "2026-10-02T11:25:00.000Z",
      },
    ],
  };
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function recoveryCommands(data: OperationsData, job: OperationsData["jobs"][number]) {
  const inspect = `pnpm queue --installation-id ${quote(data.installationId)} --event ${quote(job.event)}`;
  return {
    inspect,
    retry: job.status === "failed" ? `${inspect} --retry-failed ${quote(job.id)}` : null,
  };
}
