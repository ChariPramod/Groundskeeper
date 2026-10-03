import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { getDemoDashboard } from "../lib/demo-data";
import { demoReviewInbox } from "../lib/review-inbox-client";
import { defaultInboxFilters } from "../lib/review-inbox-types";

test("downloads the loaded page with applied filters and spreadsheet-safe CSV", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Review inbox", exact: true })
    .click();
  await page.getByLabel("Owner · exact label").fill("maya");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByText("1 review on this page", { exact: false })).toBeVisible();
  await page.getByLabel("Owner · exact label").fill("unapplied-draft");
  const jsonDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON", exact: true }).click();
  const json = await jsonDownload;
  const path = await json.path();
  if (!path) throw new Error("Missing download");
  const data = JSON.parse(await readFile(path, "utf8"));
  expect(data).toMatchObject({ mode: "demo", rowCount: 1, page: 1, filters: { owner: "maya" } });
  expect(data.rows[0].owner).toBe("maya");
  const csvDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV", exact: true }).click();
  const csv = await csvDownload;
  expect(csv.suggestedFilename()).toBe("groundskeeper-demo-inbox-page-1.csv");
  const csvPath = await csv.path();
  if (!csvPath) throw new Error("Missing CSV download");
  expect(await readFile(csvPath, "utf8")).toContain('"run-1042"');
});

test("download and clipboard failures offer selectable text, and revoked access removes it", async ({
  page,
}) => {
  const dashboard = { ...getDemoDashboard(), mode: "live" };
  const inbox = { ...demoReviewInbox(defaultInboxFilters), mode: "live" };
  let status = 200;
  await page.route("**/api/dashboard", (route) => route.fulfill({ json: dashboard }));
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: { githubUserId: "7", login: "alice", role: "reviewer", viewScope: "a".repeat(64) },
    }),
  );
  await page.route("**/api/reviews?*", (route) =>
    route.fulfill({
      status,
      json: status === 200 ? inbox : { error: "Unavailable" },
    }),
  );
  await page.addInitScript(() => {
    URL.createObjectURL = () => {
      throw new Error("Download unavailable");
    };
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("Clipboard unavailable")) },
    });
  });
  await page.goto("http://127.0.0.1:4175");
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Review inbox", exact: true })
    .click();
  await page.getByRole("button", { name: "Export JSON", exact: true }).click();
  const text = page.getByLabel("JSON export · page 1");
  await expect(text).toBeVisible();
  await page.getByRole("button", { name: "Copy export text", exact: true }).click();
  await expect(page.getByText("Clipboard unavailable.", { exact: false })).toBeVisible();
  status = 503;
  await page.getByRole("button", { name: "Refresh inbox", exact: true }).click();
  await expect(page.getByRole("region", { name: "Review inbox" }).getByRole("alert")).toBeVisible();
  expect(JSON.parse(await text.inputValue()).stale).toBe(true);
  status = 403;
  await page.getByRole("button", { name: "Refresh inbox", exact: true }).click();
  await expect(text).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Export JSON", exact: true })).toHaveCount(0);
});
