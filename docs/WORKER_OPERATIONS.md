# Supervised background processing

`pnpm worker` remains the finite, scriptable batch command. `pnpm worker:serve` runs continuously, consuming both push and actionable pull-request deliveries. It does not execute repository examples or publish GitHub changes. Webhook ingress must run separately and write to the same migrated PostgreSQL database.

## Start and inspect

```sh
pnpm install --frozen-lockfile
uv sync --locked
pnpm db:generate
pnpm db:migrate
pnpm worker:serve
curl -i http://127.0.0.1:9090/health/live
curl -i http://127.0.0.1:9090/health/ready
```

Configure `DATABASE_URL`, `APP_ID`, and `PRIVATE_KEY` or the supported private-key file setting in the root `.env`. Never put credentials in command arguments or source control. Existing installation permissions and webhook verification remain mandatory. `--event push` and `--event pull_request` allow separate pools; default `all` consumes either event. `--poll-ms` is bounded to 1–60 seconds. `--host`/`WORKER_HEALTH_HOST` and `--port`/`WORKER_HEALTH_PORT` configure health binding; the default is loopback port 9090.

The status endpoint deliberately contains only process phase, timestamps and counters. It has no authentication and must stay on a private network. It exposes no repository payloads, source, identifiers, or exception messages.

- `/health/live`: HTTP 200 while the supervisor HTTP server can respond. Use this for container liveness/restart checks.
- `/health/ready`: HTTP 503 until one finite batch succeeds, during dependency backoff, or while stopping. A successful empty-queue poll is sufficient. HTTP 200 means a recent supervisor heartbeat and a functioning last batch; it does **not** prove GitHub credentials, installation permission, end-to-end processing, or an empty dead-letter queue. Use synthetic delivery/pilot checks for those.
- JSON `worker_batch` log records describe success, failure streak, timing, and completed batches. A batch can be an empty poll. Delivery errors continue to record sanitized retry outcomes; inspect the queue for individual failed deliveries.

## Failure and shutdown behavior

The supervisor runs one finite, one-delivery child at a time. It does not start another until the previous process closes. Each batch has a four-minute wall-clock deadline. A stalled database connection, GitHub request, or child cannot stall the whole worker indefinitely. Failed batches retry with equal-jitter exponential backoff capped at 60 seconds; successful batches reset the streak and poll every five seconds by default. Delivery-level retry timing and maximum attempts still come from the durable queue, not the supervisor.

On SIGTERM/SIGINT, readiness fails immediately, no new batch starts, and the current child has 30 seconds to drain. It is then killed if necessary. Unacknowledged deliveries remain recoverable after their database lease expires. Persist-before-acknowledge and lease-token fencing prevent an expired worker from replacing a newer owner's result. Recovery may wait for the existing ten-minute lease; do not delete queue rows to accelerate it.

The trusted Python analysis bridge creates its own process group and has its own 60-second deadline. If the Node batch is force-killed, that isolated analysis process may finish or hit its timeout afterward; it does not write the database or execute repository examples. Container shutdown must use an init process to reap subprocesses.

If readiness stays unavailable, inspect database reachability, migrations, GitHub App configuration and queue metadata. Restarting alone does not repair bad credentials or terminal deliveries. Use the documented queue recovery command after fixing the cause. Alert on sustained readiness failures, rising terminal queue counts, old pending deliveries, and absence of expected installation activity. The health endpoint alone is not an alerting system.

## Container reference

`deploy/worker.Dockerfile` installs locked Node/Python dependencies, generates Prisma, runs as a non-root user, and exposes only health. It has no Docker socket or GitHub write task. Build context ignores credentials and runtime artifacts. Root dependencies are retained because the current CLI uses TypeScript source through `tsx`.

```sh
docker build -f deploy/worker.Dockerfile -t groundskeeper-worker .
# The first file establishes the base directory used by Compose paths:
docker compose -f deploy/compose.worker.yaml -f compose.yaml up -d postgres
# Apply migrations from the host or a one-off container before starting the worker.
pnpm db:migrate
docker compose -f deploy/compose.worker.yaml -f compose.yaml up -d worker
```

The overlay assumes local/pilot PostgreSQL credentials and reads the root `.env`; use managed secrets, TLS database connectivity, backups and an external process orchestrator in production. Supply private-key contents via the supported environment setting or explicitly mount a secret file; a host-only key path is not available in the container. The overlay's loopback health port is intentional. Add a readiness probe through the platform separately from liveness. No external service has been provisioned by adding these files.

## Validation boundary

Unit tests exercise sequential execution, backoff and recovery, stale readiness, interruptible waiting, process failures, actual hung-child termination and graceful draining. Real database queue concurrency tests remain the authority for lease behavior. A Docker build and deployed worker soak test are required in an environment with Docker and real GitHub App secrets; local creation of these files is not evidence of a functioning hosted worker.
