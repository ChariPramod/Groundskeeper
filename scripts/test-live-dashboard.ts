/** Real PostgreSQL + production Next smoke. Requires a built web app and migrated test DB. */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, expect } from "@playwright/test";
import { analyzeLocally } from "../apps/github/src/analysis.js";
import {
  createTeamSession,
  type Prisma,
  PrismaClient,
  setTeamMembership,
  storeAnalysisRun,
} from "../packages/database/src/index.js";
import { extractClaims } from "../packages/parser/src/index.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const origin = "http://127.0.0.1:4176";
const stop = new AbortController();
const signalHandler = () => stop.abort();
const deadline = setTimeout(signalHandler, 240_000);
process.once("SIGINT", signalHandler);
process.once("SIGTERM", signalHandler);
let stage = "configuration";
let child: ChildProcess | undefined;
let childClosed: Promise<void> | undefined;
let db: PrismaClient | undefined;
let browser: Browser | undefined;
const workspaceIds: string[] = [];
const queueIds: string[] = [];

async function request(path: string, token?: string) {
  return fetch(`${origin}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.any([stop.signal, AbortSignal.timeout(8000)]),
  });
}
async function wait(milliseconds: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  stop.signal.throwIfAborted();
}
function kill(signal: NodeJS.Signals) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
  }
}

async function startNext(env: NodeJS.ProcessEnv) {
  child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../apps/web/node_modules/next/dist/bin/next", import.meta.url)),
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      "4176",
    ],
    { cwd: `${root}apps/web`, env, stdio: "ignore", detached: process.platform !== "win32" },
  );
  let spawnFailed = false;
  child.once("error", () => {
    spawnFailed = true;
  });
  childClosed = new Promise((resolve) => child?.once("close", () => resolve()));
  const startupDeadline = Date.now() + 45_000;
  let ready = false;
  while (Date.now() < startupDeadline) {
    assert(!spawnFailed && child.exitCode === null && child.signalCode === null, "Next exited");
    try {
      const health = await request("/api/health");
      if (health.ok) {
        const value = await health.json();
        assert.equal(value.liveReady, true);
        assert.equal(value.mode, "live");
        assert.equal(health.headers.get("cache-control"), "no-store");
        ready = true;
        break;
      }
    } catch {
      stop.signal.throwIfAborted();
    }
    await wait(200);
  }
  assert(ready, "Live readiness timed out");
}

async function stopNext() {
  kill("SIGTERM");
  if (childClosed) {
    const force = setTimeout(() => kill("SIGKILL"), 3000);
    await childClosed;
    clearTimeout(force);
  }
}

try {
  // Never silently fall back to DATABASE_URL, which may be production.
  assert(process.env.DATABASE_TEST_URL, "DATABASE_TEST_URL is required");
  const url = new URL(process.env.DATABASE_TEST_URL);
  assert(["postgres:", "postgresql:"].includes(url.protocol), "Expected PostgreSQL");
  url.searchParams.set("connect_timeout", "3");
  url.searchParams.set("pool_timeout", "3");
  url.searchParams.set("connection_limit", "2");
  db = new PrismaClient({ datasourceUrl: url.toString() });
  const suffix = randomUUID();
  const installationIds = [BigInt(randomInt(1, 2 ** 48 - 1)), BigInt(randomInt(1, 2 ** 48 - 1))];
  assert.notEqual(installationIds[0], installationIds[1]);
  const token = randomBytes(32).toString("hex");

  stage = "real fixture analysis";
  const fixture = async (path: string) =>
    readFile(new URL(`../examples/demo/${path}`, import.meta.url), "utf8");
  const source = async (directory: string) =>
    Promise.all(
      ["client.py", "transport.ts"].map(async (path) => ({
        path,
        content: await fixture(`${directory}/${path}`),
      })),
    );
  const report = await analyzeLocally({
    claims: extractClaims(await fixture("docs/quickstart.md"), "docs/quickstart.md"),
    before: await source("before"),
    after: await source("after"),
  });
  assert(report.claims.length > 0 && report.impacts.length > 0, "Fixture must have real findings");

  stage = "isolated test data";
  const runs: { runId: string; fullName: string }[] = [];
  for (const [index, installationId] of installationIds.entries()) {
    const id = `live-smoke-${suffix}-${index}`;
    // Create rather than upsert: a random identity collision must fail without adopting data.
    await db.$transaction(
      async (tx) => {
        await tx.workspace.create({
          data: { id, installationId, account: `live-smoke-${suffix}` },
        });
      },
      { timeout: 10_000 },
    );
    workspaceIds.push(id);
    const fullName = `live-smoke-${suffix}/${index === 0 ? "owned" : "foreign"}`;
    const { runId } = await storeAnalysisRun(db, {
      installationId,
      account: `live-smoke-${suffix}`,
      deliveryId: `${id}-analysis`,
      repository: { githubId: BigInt(index + 1), fullName, defaultBranch: "main" },
      beforeCommit: "a".repeat(40),
      afterCommit: "b".repeat(40),
      report: report as unknown as Prisma.InputJsonObject,
    });
    runs.push({ runId, fullName });
    await db.$transaction(
      async (tx) => {
        await tx.webhookDelivery.create({
          data: {
            id,
            event: index === 0 ? "pull_request" : "push",
            installationId,
            repositoryId: BigInt(index + 1),
            payload: { full_name: fullName },
          },
        });
      },
      { timeout: 10_000 },
    );
    queueIds.push(id);
  }
  const own = runs[0];
  const foreign = runs[1];
  assert(own && foreign);

  stage = "production Next startup";
  const env = {
    ...process.env,
    NODE_ENV: "production",
    DATABASE_URL: url.toString(),
    DASHBOARD_MODE: "live",
    DASHBOARD_INSTALLATION_ID: String(installationIds[0]),
    DASHBOARD_ACCESS_TOKEN: token,
    // Explicit empty values prevent Next .env.local from activating an unrelated OAuth setup.
    GITHUB_OAUTH_CLIENT_ID: "",
    GITHUB_OAUTH_CLIENT_SECRET: "",
    AUTH_ORIGIN: "",
    AUTH_SECRET: "",
  };
  await startNext(env);

  stage = "authentication and dashboard isolation";
  assert.equal((await request("/api/dashboard")).status, 401);
  assert.equal((await request("/api/dashboard", "wrong-token")).status, 401);
  const response = await request(`/api/dashboard?installationId=${installationIds[1]}`, token);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const dashboard = await response.json();
  assert.equal(dashboard.mode, "live");
  assert.deepEqual(
    dashboard.runs.map((run: { id: string }) => run.id),
    [own.runId],
  );
  assert.deepEqual(
    dashboard.repositories.map((repo: { fullName: string }) => repo.fullName),
    [own.fullName],
  );
  assert.deepEqual(
    dashboard.queue.map((item: { id: string }) => item.id),
    [queueIds[0]],
  );
  assert.equal(dashboard.queue[0].event, "pull_request");
  assert.equal(dashboard.runs[0].totalClaims, report.claims.length);
  assert(dashboard.runs[0].affectedClaims > 0);
  assert(!JSON.stringify(dashboard).includes(foreign.fullName));

  stage = "review evidence and cross-tenant denial";
  assert.equal((await request(`/api/review/${own.runId}`)).status, 401);
  const ownResponse = await request(`/api/review/${own.runId}`, token);
  assert.equal(ownResponse.status, 200);
  const review = await ownResponse.json();
  assert.equal(review.id, own.runId);
  assert.equal(review.mode, "live");
  assert.equal(review.repository, own.fullName);
  assert.equal(review.totalClaims, report.claims.length);
  assert(review.findings.some((finding: { impact: string | null }) => finding.impact !== null));
  const denied = await request(`/api/review/${foreign.runId}`, token);
  assert.equal(denied.status, 404);
  assert(!(await denied.text()).includes(foreign.fullName));
  assert.equal((await request(`/api/review/missing-${suffix}`, token)).status, 404);
  stage = "real browser connection and review";
  browser = await chromium.launch({ timeout: 15_000 });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.name));
  await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.getByRole("button", { name: "Connect workspace", exact: true }).click();
  await page.getByLabel("Dashboard access token").fill(token);
  await page.getByRole("button", { name: "Connect live data", exact: true }).click();
  await expect(page.getByText("Live data", { exact: true })).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.getByRole("button", { name: `View owned run ${own.runId}`, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Documentation review", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Linked changed symbols", { exact: true }).first()).toBeVisible();
  assert.equal(await dialog.locator("article").count(), review.findings.length);
  assert.deepEqual(pageErrors, []);
  await browser.close();
  browser = undefined;
  await stopNext();

  stage = "team session setup and production restart";
  const installationId = installationIds[0];
  assert(installationId);
  await setTeamMembership(db, installationId, 7n, true);
  const alice = await createTeamSession(db, installationId, 7n, "alice");
  assert(alice);
  const teamOrigin = "https://team.example";
  await startNext({
    ...env,
    DASHBOARD_ACCESS_TOKEN: "",
    GITHUB_OAUTH_CLIENT_ID: "live-smoke-client",
    GITHUB_OAUTH_CLIENT_SECRET: randomBytes(32).toString("hex"),
    AUTH_ORIGIN: teamOrigin,
    AUTH_SECRET: randomBytes(32).toString("hex"),
  });
  // Seed real hashed sessions, then exercise HTTP authorization. This does not test GitHub login
  // or browser transport of Secure cookies: the HTTPS origin is supplied by a trusted proxy in use.
  const stateRequest = (runId: string, session: string, body?: object, from = teamOrigin) =>
    fetch(`${origin}/api/review/${runId}/state`, {
      method: body ? "PUT" : "GET",
      headers: {
        Cookie: `__Host-gk-session=${session}`,
        ...(body ? { Origin: from, "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(8000)]),
    });
  stage = "shared review defaults and session-attributed audit";
  const initialResponse = await stateRequest(own.runId, alice);
  assert.equal(initialResponse.status, 200);
  assert.equal(initialResponse.headers.get("cache-control"), "no-store");
  const initial = await initialResponse.json();
  assert.equal(initial.version, 0);
  assert.deepEqual(initial.events, []);
  const update = {
    version: 0,
    owner: "alice",
    note: "Review output drift",
    dismissed: true,
  };
  const savedResponse = await stateRequest(own.runId, alice, update);
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  assert.equal(saved.runId, own.runId);
  assert.equal(saved.version, 1);
  assert.equal(saved.owner, update.owner);
  assert.equal(saved.note, update.note);
  assert.equal(saved.dismissed, true);
  assert.equal(saved.events.length, 1);
  assert.equal(saved.events[0].actorGithubUserId, "7");
  assert.equal(saved.events[0].actorLogin, "alice");
  assert.equal(saved.events[0].version, 1);

  stage = "shared review conflicts, origin validation and tenant denial";
  assert.equal((await stateRequest(own.runId, alice, update)).status, 409);
  assert.equal((await stateRequest(foreign.runId, alice)).status, 404);
  assert.equal((await stateRequest(foreign.runId, alice, update)).status, 404);
  assert.equal(
    (await stateRequest(own.runId, alice, { ...update, version: 1 }, "https://wrong.example"))
      .status,
    403,
  );
  assert.deepEqual(await (await stateRequest(own.runId, alice)).json(), saved);

  stage = "shared review membership revocation and another teammate session";
  await setTeamMembership(db, installationId, 7n, false);
  assert([401, 403].includes((await stateRequest(own.runId, alice)).status));
  assert(
    [401, 403].includes((await stateRequest(own.runId, alice, { ...update, version: 1 })).status),
  );
  await setTeamMembership(db, installationId, 8n, true);
  const bob = await createTeamSession(db, installationId, 8n, "bob");
  assert(bob);
  const persistedResponse = await stateRequest(own.runId, bob);
  assert.equal(persistedResponse.status, 200);
  assert.deepEqual(await persistedResponse.json(), saved);

  const teamGet = (path: string, session = bob) =>
    fetch(`${origin}${path}`, {
      headers: { Cookie: `__Host-gk-session=${session}` },
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(8000)]),
    });
  const sessionRole = async (role: string) => {
    const response = await teamGet("/api/auth/session");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { githubUserId: "8", login: "bob", role });
  };
  stage = "existing session role downgrade and read-only access";
  await sessionRole("reviewer");
  assert.equal((await request("/api/auth/session", token)).status, 401);
  await setTeamMembership(db, installationId, 8n, true, "viewer");
  await sessionRole("viewer");
  assert.equal((await stateRequest(own.runId, bob, { ...update, version: 1 })).status, 403);
  const viewerRead = await stateRequest(own.runId, bob);
  assert.equal(viewerRead.status, 200);
  assert.deepEqual(await viewerRead.json(), saved);
  assert.equal(await db.sharedReviewEvent.count({ where: { analysisRunId: own.runId } }), 1);

  stage = "scoped shared inbox, filters and malformed cursor";
  const inbox = async (query: string, expectedIds: string[]) => {
    const response = await teamGet(`/api/reviews${query}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const value = await response.json();
    assert.equal(value.mode, "live");
    assert.equal(value.nextCursor, null);
    assert.deepEqual(
      value.rows.map((row: { id: string }) => row.id),
      expectedIds,
    );
    assert(!JSON.stringify(value).includes(foreign.fullName));
    return value;
  };
  const allReviews = await inbox("?status=all", [own.runId]);
  assert.equal(allReviews.rows[0].review.owner, "alice");
  assert.equal(allReviews.rows[0].review.dismissed, true);
  assert.equal(allReviews.rows[0].review.version, 1);
  await inbox("?status=dismissed&owner=ALICE", [own.runId]);
  await inbox("", []);
  await inbox("?status=all&unassigned=true", []);
  await inbox(`?status=all&repository=${encodeURIComponent(foreign.fullName)}`, []);
  await inbox("?status=all&owner=somebody-else", []);
  assert.equal((await teamGet("/api/reviews?cursor=invalid-cursor")).status, 400);
  assert.equal((await request("/api/reviews?status=all", token)).status, 401);

  stage = "scoped operations status and redacted recovery jobs";
  // A foreign failed job must not alter this installation's counts or recovery list.
  // Source-bearing fields are deliberately seeded and must never reach the operations DTO.
  await db.webhookDelivery.updateMany({
    where: { id: { in: queueIds } },
    data: {
      failedAt: new Date(),
      attemptCount: 5,
      lastError: "PRIVATE_QUEUE_ERROR",
      leaseToken: "PRIVATE_LEASE_TOKEN",
      payload: { secret: "PRIVATE_QUEUE_PAYLOAD" },
    },
  });
  assert.equal((await request("/api/operations")).status, 401);
  const operationsResponse = await teamGet("/api/operations");
  assert.equal(operationsResponse.status, 200);
  assert.equal(operationsResponse.headers.get("cache-control"), "no-store");
  const operations = await operationsResponse.json();
  assert.equal(operations.mode, "live");
  assert.equal(operations.installationId, installationId.toString());
  assert.equal(operations.workerStatus, "unknown");
  assert.deepEqual(
    {
      pending: operations.queue.pending,
      processing: operations.queue.processing,
      retrying: operations.queue.retrying,
      failed: operations.queue.failed,
      stalled: operations.queue.stalled,
      total: operations.queue.total,
    },
    { pending: 0, processing: 0, retrying: 0, failed: 1, stalled: 0, total: 1 },
  );
  assert.equal(operations.analyses.completedLast24Hours, 1);
  assert.equal(operations.jobs.length, 1);
  assert.equal(operations.jobs[0].id, queueIds[0]);
  assert.equal(operations.jobs[0].event, "pull_request");
  assert.equal(operations.jobs[0].status, "failed");
  assert.equal(operations.jobs[0].attempts, 5);
  assert(!JSON.stringify(operations).includes("PRIVATE_"));
  assert(!JSON.stringify(operations).includes(foreign.fullName));

  stage = "existing session elevation and inbox reflecting persisted edits";
  await setTeamMembership(db, installationId, 8n, true, "admin");
  await sessionRole("admin");
  const adminResponse = await stateRequest(own.runId, bob, {
    version: 1,
    owner: "",
    note: "Admin follow-up",
    dismissed: false,
  });
  assert.equal(adminResponse.status, 200);
  const adminSaved = await adminResponse.json();
  assert.equal(adminSaved.version, 2);
  assert.equal(adminSaved.events.length, 2);
  assert.equal(adminSaved.events[0].actorGithubUserId, "8");
  assert.equal(adminSaved.events[0].actorLogin, "bob");
  assert.deepEqual(adminSaved.events[1], saved.events[0]);
  await inbox("", [own.runId]);
  await inbox("?unassigned=true", [own.runId]);
  await inbox("?status=dismissed", []);

  stage = "real keyset pagination across equal timestamps";
  const paginationSource = await db.analysisRun.findUniqueOrThrow({
    where: { id: own.runId },
  });
  const pageIds = Array.from(
    { length: 21 },
    (_, index) => `live-page-${suffix}-${index.toString().padStart(2, "0")}`,
  );
  // All 21 added rows share one timestamp, forcing the second page to use the ID tie-breaker.
  // Their repository belongs to the isolated workspace, so existing cascade cleanup owns them.
  const tiedTimestamp = new Date(paginationSource.createdAt.getTime() + 1);
  await db.analysisRun.createMany({
    data: pageIds.map((id) => ({
      id,
      repositoryId: paginationSource.repositoryId,
      deliveryId: `${id}-delivery`,
      beforeCommit: paginationSource.beforeCommit,
      afterCommit: paginationSource.afterCommit,
      inputDigest: paginationSource.inputDigest,
      report: paginationSource.report as Prisma.InputJsonObject,
      createdAt: tiedTimestamp,
    })),
  });
  const firstPageResponse = await teamGet("/api/reviews?status=all");
  assert.equal(firstPageResponse.status, 200);
  const firstPage = await firstPageResponse.json();
  assert.equal(firstPage.rows.length, 20);
  assert.equal(typeof firstPage.nextCursor, "string");
  assert(firstPage.nextCursor.length > 0);
  const secondPageResponse = await teamGet(
    `/api/reviews?status=all&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
  );
  assert.equal(secondPageResponse.status, 200);
  const secondPage = await secondPageResponse.json();
  assert.equal(secondPage.rows.length, 2);
  assert.equal(secondPage.nextCursor, null);
  const pagedIds = [...firstPage.rows, ...secondPage.rows].map((row: { id: string }) => row.id);
  assert.equal(new Set(pagedIds).size, 22);
  assert.deepEqual(new Set(pagedIds), new Set([own.runId, ...pageIds]));
  assert(!JSON.stringify([firstPage, secondPage]).includes(foreign.fullName));
  console.log(
    "Live dashboard smoke passed: real analysis + PostgreSQL + production Next + browser, scoped review inbox, immediate role changes, shared review audit and redacted operations (seeded sessions; no OAuth provider login).",
  );
} catch {
  console.error(
    `Live dashboard smoke failed during ${stage}. Check the test database, production build and required dependencies.`,
  );
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  process.removeListener("SIGINT", signalHandler);
  process.removeListener("SIGTERM", signalHandler);
  if (browser) {
    try {
      await browser.close();
    } catch {
      process.exitCode = 1;
    }
  }
  await stopNext();
  if (db) {
    try {
      // Exact IDs only. Never truncate shared tables or delete another test's workspace.
      await db.$transaction(
        async (tx) => {
          await tx.webhookDelivery.deleteMany({ where: { id: { in: queueIds } } });
          await tx.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
        },
        { timeout: 10_000 },
      );
    } catch {
      console.error(
        "Live dashboard smoke cleanup failed; remove only live-smoke-* rows from the dedicated test database.",
      );
      process.exitCode = 1;
    } finally {
      await db.$disconnect();
    }
  }
}
