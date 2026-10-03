CREATE TABLE "SharedReview" (
  "analysisRunId" TEXT NOT NULL PRIMARY KEY,
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "owner" VARCHAR(100) NOT NULL,
  "note" VARCHAR(2000) NOT NULL,
  "dismissed" BOOLEAN NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SharedReview_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "SharedReviewEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "analysisRunId" TEXT NOT NULL,
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "actorGithubUserId" BIGINT NOT NULL CHECK ("actorGithubUserId" > 0),
  "actorLogin" VARCHAR(39) NOT NULL,
  "owner" VARCHAR(100) NOT NULL,
  "note" VARCHAR(2000) NOT NULL,
  "dismissed" BOOLEAN NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SharedReviewEvent_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SharedReviewEvent_analysisRunId_version_key" ON "SharedReviewEvent"("analysisRunId", "version");
