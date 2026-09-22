export type EvidenceStatus = "passed" | "failed" | "skipped" | "error";
export type RunStatus = "needs-review" | "verified" | "unknown";

export interface DashboardRepository {
  id: string;
  name: string;
  fullName: string;
  defaultBranch: string;
}

export interface DashboardRun {
  id: string;
  repository: Pick<DashboardRepository, "name" | "fullName">;
  beforeCommit: string;
  afterCommit: string;
  createdAt: string;
  affectedClaims: number;
  totalClaims: number;
  status: RunStatus;
  evidence: { id: string; label: string; status: EvidenceStatus; detail: string }[];
}

export interface DashboardData {
  mode: "demo" | "live";
  generatedAt: string;
  repositories: DashboardRepository[];
  runs: DashboardRun[];
  queue: {
    id: string;
    repository: string;
    event: string;
    status: "pending" | "processing" | "retrying" | "failed";
    attempts: number;
    receivedAt: string;
    nextAttemptAt: string | null;
  }[];
}
