CREATE TABLE "VerificationRun" (
    "id" TEXT NOT NULL,
    "analysisRunId" TEXT NOT NULL,
    "sourceDigest" TEXT NOT NULL,
    "inputDigest" TEXT NOT NULL,
    "report" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VerificationRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VerificationRun_analysisRunId_createdAt_idx" ON "VerificationRun"("analysisRunId", "createdAt");
ALTER TABLE "VerificationRun" ADD CONSTRAINT "VerificationRun_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
