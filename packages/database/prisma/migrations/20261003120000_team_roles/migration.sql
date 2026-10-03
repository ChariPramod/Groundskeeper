-- Preserve the review permissions of existing approved members.
CREATE TYPE "TeamRole" AS ENUM ('viewer', 'reviewer', 'admin');
ALTER TABLE "TeamMember" ADD COLUMN "role" "TeamRole" NOT NULL DEFAULT 'reviewer';
