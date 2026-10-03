import { expect, test } from "@playwright/test";
import { getDemoDashboard } from "../lib/demo-data";
import { getDemoReview } from "../lib/review-demo";

test("workspace denial clears loaded reports and exports, while an outage preserves them", async ({
  page,
}) => {
  const dashboard = getDemoDashboard();
  dashboard.mode = "live";
  let status = 200;
  await page.route("**/api/dashboard", (route) =>
    route.fulfill({ status, json: status === 200 ? dashboard : { error: "Unavailable" } }),
  );
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: { githubUserId: "7", login: "alice", role: "reviewer", viewScope: "a".repeat(64) },
    }),
  );
  await page.goto("http://127.0.0.1:4175");
  await expect(page.locator("tbody tr")).toHaveCount(5);
  status = 503;
  await page.getByRole("button", { name: "Refresh workspace", exact: true }).click();
  await expect(page.getByRole("alert", { name: "Workspace connection error" })).toContainText(
    "last loaded view",
  );
  await expect(page.locator("tbody tr")).toHaveCount(5);
  status = 403;
  await page.getByRole("button", { name: "Refresh workspace", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Workspace access expired or was revoked." }),
  ).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Export report", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Open quick actions" }).click();
  await page.getByRole("combobox", { name: "Search quick actions" }).fill("python-sdk");
  await expect(page.getByText("No matching actions or loaded runs.")).toBeVisible();
  await page.keyboard.press("Escape");
  status = 200;
  await page.getByRole("button", { name: "Refresh workspace", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(5);
});

test("session rejection closes private evidence and an older refresh cannot restore it", async ({
  page,
}) => {
  const dashboard = getDemoDashboard();
  dashboard.mode = "live";
  const run = dashboard.runs[0];
  if (!run) throw new Error("Missing fixture");
  let sessionStatus = 200;
  let hold = false;
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/dashboard", async (route) => {
    if (hold) await waiting;
    await route.fulfill({ json: dashboard });
  });
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      status: sessionStatus,
      json: { githubUserId: "7", login: "alice", role: "reviewer", viewScope: "a".repeat(64) },
    }),
  );
  await page.route(`**/api/review/${run.id}`, (route) =>
    route.fulfill({ json: { ...getDemoReview(run.id), mode: "live" } }),
  );
  await page.route(`**/api/review/${run.id}/state`, (route) =>
    route.fulfill({
      json: {
        runId: run.id,
        version: 0,
        owner: "private owner",
        note: "private note",
        dismissed: false,
        updatedAt: null,
        events: [],
      },
    }),
  );
  await page.goto("http://127.0.0.1:4175");
  await expect(page.getByText("reviewer access", { exact: true })).toBeVisible();
  hold = true;
  await page.getByRole("button", { name: "Refresh workspace", exact: true }).click();
  await page.locator("tbody tr button").first().click();
  await expect(page.getByRole("dialog").getByLabel("Team review note")).toHaveValue("private note");
  sessionStatus = 401;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByRole("heading", { name: "Workspace access expired or was revoked." }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  release?.();
  await expect(page.getByRole("button", { name: "Refresh workspace", exact: true })).toBeEnabled();
  await expect(page.locator("tbody tr")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Export report", exact: true })).toBeDisabled();
});
