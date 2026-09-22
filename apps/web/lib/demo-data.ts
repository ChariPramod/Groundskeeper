import type { DashboardData, DashboardRun } from "./dashboard-types";

const repositories = [
  { id: "repo-sdk", name: "python-sdk", fullName: "acme/python-sdk", defaultBranch: "main" },
  { id: "repo-api", name: "platform-api", fullName: "acme/platform-api", defaultBranch: "main" },
  {
    id: "repo-docs",
    name: "developer-docs",
    fullName: "acme/developer-docs",
    defaultBranch: "main",
  },
  { id: "repo-examples", name: "quickstarts", fullName: "acme/quickstarts", defaultBranch: "main" },
] as const;

const runs: DashboardRun[] = [
  {
    id: "run-1042",
    repository: repositories[0],
    beforeCommit: "a17bc029",
    afterCommit: "c84f210a",
    createdAt: "2026-09-21T16:42:00.000Z",
    affectedClaims: 3,
    totalClaims: 42,
    status: "needs-review",
    evidence: [
      {
        id: "e1",
        label: "Client initialization",
        status: "failed",
        detail:
          "The quickstart still uses the removed timeout argument. Update the example to request_timeout.",
      },
      {
        id: "e2",
        label: "Pagination tutorial",
        status: "passed",
        detail: "All three Python tutorial steps completed with the expected output.",
      },
      {
        id: "e3",
        label: "Retry configuration",
        status: "skipped",
        detail: "This example requires network access. Automatic execution remains unavailable.",
      },
    ],
  },
  {
    id: "run-1041",
    repository: repositories[1],
    beforeCommit: "1abc309f",
    afterCommit: "d53e11b7",
    createdAt: "2026-09-21T16:18:00.000Z",
    affectedClaims: 0,
    totalClaims: 28,
    status: "verified",
    evidence: [
      {
        id: "e4",
        label: "Response normalization",
        status: "passed",
        detail: "Python example matched its expected output in an isolated sandbox.",
      },
    ],
  },
  {
    id: "run-1040",
    repository: repositories[2],
    beforeCommit: "c458ab11",
    afterCommit: "f77290ce",
    createdAt: "2026-09-21T15:54:00.000Z",
    affectedClaims: 2,
    totalClaims: 56,
    status: "needs-review",
    evidence: [
      {
        id: "e5",
        label: "Authentication reference",
        status: "failed",
        detail: "Two linked claims reference a function whose signature changed.",
      },
    ],
  },
  {
    id: "run-1039",
    repository: repositories[3],
    beforeCommit: "138fc40e",
    afterCommit: "eb821de0",
    createdAt: "2026-09-21T15:26:00.000Z",
    affectedClaims: 0,
    totalClaims: 18,
    status: "unknown",
    evidence: [
      {
        id: "e6",
        label: "Sandbox unavailable",
        status: "error",
        detail: "Execution could not start. Restore Docker, then request a new verification run.",
      },
    ],
  },
  {
    id: "run-1038",
    repository: repositories[0],
    beforeCommit: "358ea762",
    afterCommit: "a17bc029",
    createdAt: "2026-09-21T14:40:00.000Z",
    affectedClaims: 0,
    totalClaims: 42,
    status: "verified",
    evidence: [
      {
        id: "e7",
        label: "Getting started",
        status: "passed",
        detail: "The selected runnable examples completed successfully.",
      },
    ],
  },
  {
    id: "run-1037",
    repository: repositories[1],
    beforeCommit: "b61003da",
    afterCommit: "1abc309f",
    createdAt: "2026-09-21T13:16:00.000Z",
    affectedClaims: 0,
    totalClaims: 28,
    status: "unknown",
    evidence: [],
  },
  {
    id: "run-1036",
    repository: repositories[3],
    beforeCommit: "ad6301ec",
    afterCommit: "138fc40e",
    createdAt: "2026-09-20T20:08:00.000Z",
    affectedClaims: 0,
    totalClaims: 18,
    status: "verified",
    evidence: [
      {
        id: "e8",
        label: "First request tutorial",
        status: "passed",
        detail: "The tutorial's expected output matched across every runnable step.",
      },
    ],
  },
];

/** Stable sample records. Never substitute these for a failed live request. */
export function getDemoDashboard(): DashboardData {
  return structuredClone({
    mode: "demo",
    generatedAt: "2026-09-21T17:00:00.000Z",
    repositories: [...repositories],
    runs,
    queue: [
      {
        id: "delivery-1045",
        repository: "acme/python-sdk",
        event: "push",
        status: "processing",
        attempts: 1,
        receivedAt: "2026-09-21T16:59:00.000Z",
        nextAttemptAt: null,
      },
      {
        id: "delivery-1044",
        repository: "acme/developer-docs",
        event: "push",
        status: "pending",
        attempts: 0,
        receivedAt: "2026-09-21T16:58:00.000Z",
        nextAttemptAt: null,
      },
      {
        id: "delivery-1043",
        repository: "acme/quickstarts",
        event: "push",
        status: "retrying",
        attempts: 2,
        receivedAt: "2026-09-21T16:49:00.000Z",
        nextAttemptAt: "2026-09-21T17:04:00.000Z",
      },
      {
        id: "delivery-1035",
        repository: "acme/platform-api",
        event: "push",
        status: "failed",
        attempts: 5,
        receivedAt: "2026-09-21T15:10:00.000Z",
        nextAttemptAt: null,
      },
    ],
  });
}
