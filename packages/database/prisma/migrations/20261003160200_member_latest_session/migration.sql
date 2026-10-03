-- Supports bounded last-known-login lookup and membership session revocation.
-- The separate workspace/expiry index still serves ordered cleanup batches.
CREATE INDEX "TeamSession_member_latest_idx"
  ON "TeamSession"("workspaceId", "githubUserId", "createdAt", "tokenHash");
