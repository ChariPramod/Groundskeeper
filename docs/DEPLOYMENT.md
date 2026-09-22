# Hosted dashboard preview

## Connected repository deployment

Source: https://github.com/ChariPramod/Groundskeeper (public). The existing claimed Vercel project is connected to this repository. Its root directory is `apps/web`, Node is 22.x, installation uses the frozen pnpm lockfile, and the build generates Prisma before building Next.js. `apps/web/vercel.json` preserves these build commands and explicit demo mode. Pushes to `main` deploy production; pull requests can receive previews through the Vercel Git integration.

The standalone temporary packaging instructions below are retained as a fallback and are no longer the normal deployment path.

The preview deploys the Next.js web interface in explicit demo mode. It includes search/filtering, repository and queue views, evidence details, local review annotations, JSON export, and illustrative repair diffs. It does not execute Docker jobs, process webhooks, or publish GitHub repairs. Browser notes stay on the current browser and origin.

## Rebuild the Vercel preview

Vercel's temporary uploader failed to package this pnpm workspace's symlinked dependencies. A repeatable packaging script prepares an isolated web checkout from the existing source without copying environment files, credentials, local repair artifacts, tests, or build output:

```sh
node scripts/prepare-web-preview.mjs
cd .groundskeeper/vercel-preview
npm install --no-audit --no-fund --cache /tmp/groundskeeper-npm-cache
npm_config_cache=/tmp/groundskeeper-npm-cache pnpm dlx vercel deploy --temporary --yes
```

The package pins direct dependencies to the locally installed versions, uses the same Prisma schema, and replaces only the workspace's minimal Prisma re-export with the equivalent direct import. It flattens the TypeScript base configuration and fixes the build/tracing root to the preview directory. The original application and worker retain their monorepo structure. The isolated npm lockfile captures the resolved preview dependencies. Retain it for repeat deployments; use `npm ci` when its package versions have not changed.

Temporary deployments must be claimed through the Vercel-provided claim link to retain them. Treat claim links and `.vercel` metadata as private; do not commit them or include them in public documentation. After claiming, authenticate the CLI and link this directory to the claimed project for subsequent deployments.

## Live operation remains separate

A real-data dashboard needs a reachable Postgres database, applied migrations, persisted analysis runs, and installation-scoped dashboard credentials. This preview deliberately receives none of those secrets. Do not switch the public preview to live mode as a substitute for hosted per-user authorization.

The GitHub ingress, queue worker, Python analyzer and isolated Docker executor must run on suitable separate infrastructure. Local repair JSON files do not become available on Vercel; hosted artifact inspection needs a tenant-scoped durable artifact store. Draft PR publication remains an explicit operator CLI action. Follow PROJECT_HANDOFF.md and REPAIR_WORKFLOW.md for that pipeline's setup and validation.

## Deployment record — September 22, 2026

Vercel reported READY for https://temporary-racing-aurora-75uu7zy.vercel.app. This is a temporary preview, expiring approximately September 22 at 4:21 PM America/Los_Angeles unless claimed. Its private claim link was returned directly in the conversation.

Build and type checks passed. Dependency auditing reports four high-severity entries in the Prisma CLI configuration dependency chain (`prisma`, `@prisma/config`, `deepmerge-ts`, `effect`). These require a separately tested tooling upgrade; the preview uses demo data and no database credentials. No forced dependency downgrade was applied during deployment.
