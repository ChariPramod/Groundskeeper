CREATE INDEX "TeamSession_workspaceId_expiresAt_tokenHash_idx"
  ON "TeamSession"("workspaceId", "expiresAt", "tokenHash");
DROP INDEX "TeamSession_expiresAt_idx";
