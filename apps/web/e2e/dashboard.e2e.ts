import { expect, test } from "@playwright/test";
import { getDemoDashboard } from "../lib/demo-data";

test("search, status filters and clearing an empty result", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "A healthier home for your docs." }),
  ).toBeVisible();
  await expect(
    page.getByText("All reports and activity below are illustrative.", { exact: false }),
  ).toBeVisible();
  await page.keyboard.press("/");
  await expect(page.getByRole("textbox", { name: "Search runs" })).toBeFocused();
  await page.getByRole("button", { name: "Verified", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(3);
  await page.getByRole("textbox", { name: "Search runs" }).fill("no-such-repository");
  await expect(page.getByRole("heading", { name: "Nothing matches just yet" })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(5);
});

test("evidence dialog supports inspection and Escape", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: /View python-sdk run/ })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Execution evidence" })).toBeVisible();
  await expect(dialog.getByText("Failed", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: /View python-sdk run/ }).first()).toBeFocused();
});

test("repository selection scopes activity and queue is navigable", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Repositories", exact: true }).click();
  await page
    .locator(".repository-card")
    .filter({ has: page.getByRole("heading", { name: "python-sdk", exact: true }) })
    .click();
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await page.getByRole("button", { name: "Clear repository filter" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(7);
  await page.getByRole("button", { name: /Work queue/ }).click();
  await expect(page.getByRole("heading", { name: "Delivery queue" })).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(4);
});

test("failed refresh keeps last data and a retry recovers", async ({ page }) => {
  await page.goto("/");
  await page.route("**/api/dashboard", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
  await page.getByRole("button", { name: "Refresh workspace" }).click();
  await expect(page.getByRole("alert", { name: "Workspace connection error" })).toContainText(
    "last loaded view",
  );
  await expect(page.locator("tbody tr")).toHaveCount(5);
  await page.unroute("**/api/dashboard");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("alert", { name: "Workspace connection error" })).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("Workspace refreshed.");
});

test("malformed refresh cannot replace a working dashboard", async ({ page }) => {
  await page.goto("/");
  await page.route("**/api/dashboard", (route) =>
    route.fulfill({ json: { mode: "live", runs: "invalid" } }),
  );
  await page.getByRole("button", { name: "Refresh workspace" }).click();
  await expect(page.getByRole("alert", { name: "Workspace connection error" })).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(5);
});

test("export is a labeled JSON download and settings explain connection", async ({ page }) => {
  await page.goto("/");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export report" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("groundskeeper-demo-report.json");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  if (!stream) throw new Error("Download stream missing");
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  expect(JSON.parse(Buffer.concat(chunks).toString()).mode).toBe("demo");
  await page.getByRole("button", { name: "Connection settings", exact: true }).first().click();
  await expect(page.getByRole("dialog")).toContainText("DASHBOARD_INSTALLATION_ID");
});

test("mobile navigation and dialog fit without page overflow", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page
    .getByRole("button", { name: /View python-sdk run/ })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Repositories", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Every repository. In view." })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole("button", { name: "Connection settings", exact: true }).last().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("live connection fails closed and demo is an explicit fallback", async ({ page, request }) => {
  const unauthorized = await request.get("http://127.0.0.1:4174/api/dashboard");
  expect(unauthorized.status()).toBe(401);
  expect(await unauthorized.json()).not.toHaveProperty("runs");
  await page.goto("http://127.0.0.1:4174");
  await expect(
    page.getByRole("heading", { name: "Your workspace is ready to connect." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Connect workspace", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Dashboard access token").fill("browser-test-token");
  await dialog.getByRole("button", { name: "Connect live data", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("unavailable", { timeout: 15000 });
  await expect(page.locator("tbody tr")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Explore demo", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(5);
  await expect(
    page.getByText("All reports and activity below are illustrative.", { exact: false }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
  ).toEqual({ local: 0, session: 0 });
});

test("detailed review annotations survive reopening without changing evidence", async ({
  page,
}) => {
  await page.goto("/");
  const open = page.getByRole("button", { name: /View python-sdk run/ }).first();
  await open.click();
  let dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Your local review" })).toBeVisible();
  await dialog.getByLabel("Owner", { exact: true }).fill("SDK team");
  await dialog
    .getByLabel("Review note", { exact: true })
    .fill("Check the intended timeout behavior before changing the example.");
  await dialog.getByRole("button", { name: "Dismiss locally", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.reload();
  await open.click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Owner", { exact: true })).toHaveValue("SDK team");
  await expect(dialog.getByRole("button", { name: "Reopen local review" })).toBeVisible();
  await expect(dialog.getByText("Failed", { exact: true })).toBeVisible();
});

test("unavailable browser storage keeps review edits in memory", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new Error("storage blocked");
    };
    Storage.prototype.setItem = () => {
      throw new Error("storage blocked");
    };
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: /View python-sdk run/ })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("Browser storage is unavailable or unreadable.", { exact: false }),
  ).toBeVisible();
  await dialog.getByLabel("Owner", { exact: true }).fill("Temporary owner");
  await expect(dialog.getByLabel("Owner", { exact: true })).toHaveValue("Temporary owner");
});

test("repair workspace shows an explicit sample diff and retains it after an invalid lookup", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Repairs", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Repair workspace", exact: true })).toBeVisible();
  await expect(page.getByText("Current documentation", { exact: true })).toBeVisible();
  await expect(page.getByText("Proposed documentation", { exact: true })).toBeVisible();
  await expect(page.getByText("This is an illustrative sample.", { exact: false })).toBeVisible();
  await page.getByLabel("Artifact SHA-256").fill("e".repeat(64));
  await page.getByRole("button", { name: "Review artifact", exact: true }).click();
  await expect(
    page.getByText("Artifact details could not be validated.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("Current documentation", { exact: true })).toBeVisible();
});

test("unavailable live review details preserve the loaded overview", async ({ page }) => {
  await page.route("**/api/dashboard", (route) =>
    route.fulfill({ json: { ...getDemoDashboard(), mode: "live" } }),
  );
  await page.route("**/api/review/**", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
  await page.goto("http://127.0.0.1:4174");
  await page.getByRole("button", { name: "Connect workspace", exact: true }).click();
  await page.getByLabel("Dashboard access token").fill("browser-test-token");
  await page.getByRole("button", { name: "Connect live data", exact: true }).click();
  await page
    .getByRole("button", { name: /View python-sdk run/ })
    .first()
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "temporarily unavailable",
  );
  await page.keyboard.press("Escape");
  await expect(page.locator("tbody tr")).toHaveCount(5);
  await expect(page.getByText("Live data", { exact: true })).toBeVisible();
});
