CREATE TABLE "AnalysisRun" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "beforeCommit" TEXT NOT NULL,
    "afterCommit" TEXT NOT NULL,
    "inputDigest" TEXT NOT NULL,
    "report" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AnalysisRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AnalysisRun_deliveryId_key" ON "AnalysisRun"("deliveryId");
CREATE INDEX "AnalysisRun_repositoryId_createdAt_idx" ON "AnalysisRun"("repositoryId", "createdAt");
ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_repositoryId_fkey"
    FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
