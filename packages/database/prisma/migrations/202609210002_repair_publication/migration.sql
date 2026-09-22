CREATE TABLE "RepairPublication" (
  "analysisRunId" TEXT NOT NULL,
  "proposalId" TEXT NOT NULL,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "pullRequestUrl" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RepairPublication_pkey" PRIMARY KEY ("analysisRunId"),
  CONSTRAINT "RepairPublication_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
