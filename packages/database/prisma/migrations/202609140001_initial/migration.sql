-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('unknown', 'verified', 'stale', 'unverifiable');

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "installationId" BIGINT NOT NULL,
    "account" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Repository" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "githubId" BIGINT NOT NULL,
    "fullName" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL,
    "maxPages" INTEGER NOT NULL DEFAULT 3,
    "maxPrs" INTEGER NOT NULL DEFAULT 1,
    "maxLinesChanged" INTEGER NOT NULL DEFAULT 150,

    CONSTRAINT "Repository_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Page" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "indexedCommit" TEXT NOT NULL,
    "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Page_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Claim" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "stableKey" TEXT NOT NULL,
    "anchor" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "position" JSONB NOT NULL,
    "references" JSONB NOT NULL,
    "language" TEXT,
    "runnable" BOOLEAN NOT NULL DEFAULT false,
    "expectedOutput" TEXT,
    "status" "ClaimStatus" NOT NULL DEFAULT 'unknown',
    "lastVerified" TIMESTAMP(3),
    "verificationMethod" TEXT,

    CONSTRAINT "Claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Symbol" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "stableKey" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "qualifiedName" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "startLine" INTEGER NOT NULL,
    "endLine" INTEGER NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "indexedCommit" TEXT NOT NULL,

    CONSTRAINT "Symbol_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaimLink" (
    "claimId" TEXT NOT NULL,
    "symbolId" TEXT NOT NULL,
    "match" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "ClaimLink_pkey" PRIMARY KEY ("claimId","symbolId")
);

-- CreateTable
CREATE TABLE "Evidence" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "commit" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "status" "ClaimStatus" NOT NULL,
    "artifact" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "installationId" BIGINT NOT NULL,
    "repositoryId" BIGINT,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_installationId_key" ON "Workspace"("installationId");

-- CreateIndex
CREATE UNIQUE INDEX "Repository_workspaceId_githubId_key" ON "Repository"("workspaceId", "githubId");

-- CreateIndex
CREATE UNIQUE INDEX "Page_repositoryId_path_key" ON "Page"("repositoryId", "path");

-- CreateIndex
CREATE INDEX "Claim_status_lastVerified_idx" ON "Claim"("status", "lastVerified");

-- CreateIndex
CREATE UNIQUE INDEX "Claim_pageId_stableKey_key" ON "Claim"("pageId", "stableKey");

-- CreateIndex
CREATE INDEX "Symbol_repositoryId_name_idx" ON "Symbol"("repositoryId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Symbol_repositoryId_stableKey_key" ON "Symbol"("repositoryId", "stableKey");

-- CreateIndex
CREATE INDEX "Evidence_claimId_createdAt_idx" ON "Evidence"("claimId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_processedAt_receivedAt_idx" ON "WebhookDelivery"("processedAt", "receivedAt");

-- AddForeignKey
ALTER TABLE "Repository" ADD CONSTRAINT "Repository_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Page" ADD CONSTRAINT "Page_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Symbol" ADD CONSTRAINT "Symbol_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimLink" ADD CONSTRAINT "ClaimLink_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimLink" ADD CONSTRAINT "ClaimLink_symbolId_fkey" FOREIGN KEY ("symbolId") REFERENCES "Symbol"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

