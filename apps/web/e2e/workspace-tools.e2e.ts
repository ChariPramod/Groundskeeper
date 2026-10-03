import { expect, test } from "@playwright/test";
import { getDemoDashboard } from "../lib/demo-data";
import { demoOperations } from "../lib/operations-types";
import { demoReviewInbox } from "../lib/review-inbox-client";
import { defaultInboxFilters } from "../lib/review-inbox-types";
import { savedViewsKey } from "../lib/saved-inbox-views";

test("saved inbox views survive reload, apply filters, update and delete", async ({ page }) => {
  const openInbox = async () => {
    await page.goto("/");
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("button", { name: "Review inbox", exact: true })
      .click();
  };
  await openInbox();
  await page.getByLabel("Owner · exact label").fill("maya");
  await page.getByLabel("View name", { exact: true }).fill("Maya’s queue");
  await expect(page.getByRole("button", { name: "Save view", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Apply filters" }).click();
  await page.getByRole("button", { name: "Save view", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved “Maya’s queue”." })).toBeVisible();
  await openInbox();
  await page.getByLabel("Saved inbox view").selectOption("Maya’s queue");
  await page.getByRole("button", { name: "Load view", exact: true }).click();
  await expect(page.getByLabel("Owner · exact label")).toHaveValue("maya");
  await expect(page.getByText("1 review on this page", { exact: false })).toBeVisible();
  await page.getByLabel("Unassigned only").check();
  await page.getByRole("button", { name: "Apply filters" }).click();
  await page.getByLabel("View name", { exact: true }).fill("Maya’s queue");
  await page.getByRole("button", { name: "Update view", exact: true }).click();
  await expect(page.getByText("Private to this browser · 1/8 views")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).first().click();
  await page.getByRole("button", { name: "Load view", exact: true }).click();
  await expect(page.getByLabel("Unassigned only")).toBeChecked();
  await page.getByRole("button", { name: "Delete selected view" }).click();
  await openInbox();
  await expect(page.getByLabel("Saved inbox view")).toBeDisabled();
});

test("saved views recover from corrupt storage and keep working in memory when writes fail", async ({
  page,
}) => {
  await page.addInitScript((key) => {
    localStorage.setItem(key, "{corrupt");
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name.startsWith("groundskeeper:inbox-views:"))
        throw new DOMException("Full", "QuotaExceededError");
      return original.call(this, name, value);
    };
  }, savedViewsKey("demo"));
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Review inbox", exact: true })
    .click();
  await expect(page.getByText("Saved views could not be read.", { exact: false })).toBeVisible();
  await page.getByLabel("View name", { exact: true }).fill("This visit");
  await page.getByRole("button", { name: "Save view", exact: true }).click();
  await expect(page.getByText("Browser storage is unavailable.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Load view", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Review .* at / }).first()).toBeVisible();
});

test("saved live views are isolated by authenticated workspace and user", async ({ page }) => {
  const dashboard = getDemoDashboard();
  dashboard.mode = "live";
  const inbox = demoReviewInbox(defaultInboxFilters);
  inbox.mode = "live";
  let viewScope = "a".repeat(64);
  await page.route("**/api/dashboard", (route) => route.fulfill({ json: dashboard }));
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ json: { githubUserId: "7", login: "alice", role: "reviewer", viewScope } }),
  );
  await page.route("**/api/reviews?*", (route) => route.fulfill({ json: inbox }));
  const openInbox = async () => {
    await page.goto("http://127.0.0.1:4175");
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("button", { name: "Review inbox", exact: true })
      .click();
  };
  await openInbox();
  await page.getByLabel("View name", { exact: true }).fill("Workspace A");
  await page.getByRole("button", { name: "Save view", exact: true }).click();
  await page.getByLabel("Owner · exact label").fill("private-owner-a");
  viewScope = "b".repeat(64);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("Private to this browser · 0/8 views")).toBeVisible();
  await expect(page.getByLabel("Owner · exact label")).toHaveValue("");
  await expect(page.getByLabel("Saved inbox view")).toBeDisabled();
  viewScope = "a".repeat(64);
  await openInbox();
  await page.getByLabel("Saved inbox view").selectOption("Workspace A");
  await expect(page.getByRole("button", { name: "Load view", exact: true })).toBeEnabled();
});

test("quick actions support keyboard navigation, empty search and focus return", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open quick actions" }).click();
  await expect(page.getByRole("heading", { name: "Go anywhere" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Go anywhere" })).toBeVisible();
  const search = dialog.getByRole("combobox", { name: "Search quick actions" });
  await expect(search).toBeFocused();
  await search.fill("no-matching-action");
  await expect(dialog.getByText("No matching actions or loaded runs.")).toBeVisible();
  await search.fill("Review inbox");
  await search.press("Enter");
  await expect(
    page.getByRole("heading", { name: "The right work. Ready for review." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open quick actions" }).click();
  await search.press("Escape");
  await expect(page.getByRole("button", { name: "Open quick actions" })).toBeFocused();
});

test("review inbox filters assignments and opens the underlying evidence", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Review inbox", exact: true })
    .click();
  await expect(page.getByText("Demo inbox", { exact: false })).toBeVisible();
  await page.getByLabel("Owner · exact label").fill("MAYA");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByText("1 review on this page", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: /^Review .* at / }).click();
  await expect(
    page.getByRole("dialog").getByText("Documentation review", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByLabel("Owner · exact label").fill("nobody");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByRole("heading", { name: "No reviews match these filters" })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).first().click();
  await expect(page.getByRole("button", { name: /^Review .* at / }).first()).toBeVisible();
});

test("operations labels sample jobs and keeps recovery commands available", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Operations", exact: true })
    .click();
  const operations = page.getByRole("region", { name: "Operations center" });
  await expect(operations.getByRole("heading", { name: "Worker health: unknown" })).toBeVisible();
  await expect(operations.getByText("Sample operations data.", { exact: false })).toBeVisible();
  await expect(operations.getByText("sample-failed-delivery", { exact: true })).toBeVisible();
  await page.route("**/api/operations", (route) =>
    route.fulfill({ status: 503, json: { error: "Unavailable" } }),
  );
  await operations.getByRole("button", { name: "Refresh", exact: true }).click();
  // Demo intentionally remains local; its refresh does not attempt a live API request.
  await expect(operations.getByText("sample-failed-delivery", { exact: true })).toBeVisible();
});

test("live operations retains last data on outage and clears it on lost access", async ({
  page,
}) => {
  const dashboard = getDemoDashboard();
  dashboard.mode = "live";
  const operations = demoOperations();
  operations.mode = "live";
  let status = 200;
  await page.route("**/api/dashboard", (route) => route.fulfill({ json: dashboard }));
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ json: { githubUserId: "7", login: "alice", role: "reviewer" } }),
  );
  await page.route("**/api/operations", (route) =>
    route.fulfill({ status, json: status === 200 ? operations : { error: "Unavailable" } }),
  );
  await page.goto("http://127.0.0.1:4175");
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Operations", exact: true })
    .click();
  const region = page.getByRole("region", { name: "Operations center" });
  await expect(region.getByText("sample-failed-delivery", { exact: true })).toBeVisible();
  status = 503;
  await region.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(region.getByRole("alert")).toContainText("last successful snapshot");
  await expect(region.getByText("sample-failed-delivery", { exact: true })).toBeVisible();
  status = 401;
  await region.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(region.getByText("sample-failed-delivery", { exact: true })).toHaveCount(0);
});

test("inbox retains applied filters on outage and clears rows after access revocation", async ({
  page,
}) => {
  const dashboard = getDemoDashboard();
  dashboard.mode = "live";
  const inbox = demoReviewInbox(defaultInboxFilters);
  inbox.mode = "live";
  let status = 200;
  await page.route("**/api/dashboard", (route) => route.fulfill({ json: dashboard }));
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ json: { githubUserId: "7", login: "alice", role: "reviewer" } }),
  );
  await page.route("**/api/reviews?*", (route) =>
    route.fulfill({ status, json: status === 200 ? inbox : { error: "Unavailable" } }),
  );
  await page.goto("http://127.0.0.1:4175");
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Review inbox", exact: true })
    .click();
  const rows = page.getByRole("button", { name: /^Review .* at / });
  await expect(rows).toHaveCount(inbox.rows.length);
  status = 503;
  await page.getByLabel("Owner · exact label").fill("changed-filter");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByRole("region", { name: "Review inbox" }).getByRole("alert")).toContainText(
    "last loaded reviews",
  );
  await expect(page.getByText("Showing: open · any owner · all repositories")).toBeVisible();
  await expect(rows).toHaveCount(inbox.rows.length);
  status = 403;
  await page.getByRole("button", { name: "Retry inbox" }).click();
  await expect(rows).toHaveCount(0);
});

test("recovery commands remain selectable when clipboard access is denied", async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async () => {
          throw new Error("Denied");
        },
      },
    }),
  );
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Operations", exact: true })
    .click();
  await page.getByRole("button", { name: "Copy command" }).first().click();
  await expect(
    page.getByText("Copy unavailable. Select the command text to copy it manually."),
  ).toBeVisible();
  await expect(
    page.locator("code").filter({ hasText: "pnpm queue --installation-id" }).first(),
  ).toBeVisible();
});
