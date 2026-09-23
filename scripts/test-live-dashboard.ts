/** Real PostgreSQL + production Next smoke. Requires a built web app and migrated test DB. */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, expect } from "@playwright/test";
import { analyzeLocally } from "../apps/github/src/analysis.js";
import { type Prisma, PrismaClient, storeAnalysisRun } from "../packages/database/src/index.js";
import { extractClaims } from "../packages/parser/src/index.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const origin = "http://127.0.0.1:4176";
const stop = new AbortController();
const signalHandler = () => stop.abort();
const deadline = setTimeout(signalHandler, 180_000);
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
  console.log(
    "Live dashboard smoke passed: real analysis + PostgreSQL + production Next + browser, auth, queue/review data and cross-tenant isolation.",
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
  kill("SIGTERM");
  if (childClosed) {
    const force = setTimeout(() => kill("SIGKILL"), 3000);
    await childClosed;
    clearTimeout(force);
  }
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
