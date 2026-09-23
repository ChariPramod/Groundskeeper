CREATE TABLE "TeamMember" (
  "workspaceId" TEXT NOT NULL,
  "githubUserId" BIGINT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("workspaceId", "githubUserId"),
  CONSTRAINT "TeamMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "TeamSession" (
  "tokenHash" TEXT PRIMARY KEY,
  "workspaceId" TEXT NOT NULL,
  "githubUserId" BIGINT NOT NULL,
  "login" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeamSession_member_fkey" FOREIGN KEY ("workspaceId", "githubUserId") REFERENCES "TeamMember"("workspaceId", "githubUserId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "TeamSession_expiresAt_idx" ON "TeamSession"("expiresAt");
