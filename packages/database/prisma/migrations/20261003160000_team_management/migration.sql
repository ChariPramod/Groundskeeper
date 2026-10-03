ALTER TABLE "Workspace" ADD COLUMN "teamVersion" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "TeamAccessEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "actorSource" VARCHAR(8) NOT NULL,
  "actorGithubUserId" BIGINT,
  "actorLogin" VARCHAR(39),
  "targetGithubUserId" BIGINT NOT NULL,
  "previousRole" "TeamRole",
  "newRole" "TeamRole",
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  CONSTRAINT "TeamAccessEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TeamAccessEvent_actor_check" CHECK (
    ("actorSource" = 'operator' AND "actorGithubUserId" IS NULL AND "actorLogin" IS NULL) OR
    ("actorSource" = 'member' AND "actorGithubUserId" > 0 AND "actorLogin" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "TeamAccessEvent_workspaceId_version_key" ON "TeamAccessEvent"("workspaceId", "version");
