-- PostgreSQL CHECK permits NULL/UNKNOWN, so member identity needs an explicit null guard.
ALTER TABLE "TeamAccessEvent" DROP CONSTRAINT "TeamAccessEvent_actor_check";
ALTER TABLE "TeamAccessEvent" ADD CONSTRAINT "TeamAccessEvent_actor_check" CHECK (
  ("actorSource" = 'operator' AND "actorGithubUserId" IS NULL AND "actorLogin" IS NULL) OR
  ("actorSource" = 'member' AND "actorGithubUserId" IS NOT NULL AND "actorGithubUserId" > 0 AND "actorLogin" IS NOT NULL)
);
