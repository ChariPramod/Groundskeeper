import type { AnalysisReport, VerificationReport } from "@groundskeeper/contracts";
import type { RepositoryFile } from "../worker.js";

export interface RepairIdentity {
  id: string;
  installationId: string;
  repositoryId: string;
  fullName: string;
  baseCommit: string;
  defaultBranch: string;
  report: AnalysisReport;
}
export interface PrepareRepairInput {
  analysis: RepairIdentity;
  files: RepositoryFile[];
  image?: string;
  replacements?: { path: string; after: string }[];
}
export interface RepairProposal {
  version: 1;
  id: string;
  analysisRunId: string;
  installationId: string;
  repositoryId: string;
  fullName: string;
  baseCommit: string;
  defaultBranch: string;
  image: string;
  createdAt: string;
  files: { path: string; before: string; after: string }[];
  summary: string;
  baseline: VerificationReport | null;
  verification: VerificationReport | null;
  state: "verified" | "blocked";
  reasons: string[];
}
