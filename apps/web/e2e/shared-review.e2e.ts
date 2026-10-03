import { expect, test } from "@playwright/test";
import { getDemoDashboard } from "../lib/demo-data";
import { getDemoReview } from "../lib/review-demo";
import type { SharedReviewData } from "../lib/shared-review-types";

test("shared review saves, retains a conflicting draft and reloads the teammate's version", async ({
  page,
}) => {
  const dashboard = getDemoDashboard();
  dashboard.mode = "live";
  const run = dashboard.runs[0];
  if (!run) throw new Error("Missing fixture");
  let state: SharedReviewData = {
    runId: run.id,
    version: 0,
    owner: "",
    note: "",
    dismissed: false,
    updatedAt: null,
    events: [],
  };
  let conflict = false;
  await page.route("**/api/dashboard", (route) => route.fulfill({ json: dashboard }));
  await page.route(`**/api/review/${run.id}`, (route) =>
    route.fulfill({ json: { ...getDemoReview(run.id), mode: "live" } }),
  );
  await page.route(`**/api/review/${run.id}/state`, async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: state });
    const value = route.request().postDataJSON();
    if (conflict) return route.fulfill({ status: 409, json: { error: "Conflict" } });
    expect(value.version).toBe(state.version);
    expect(Object.keys(value).sort()).toEqual(["dismissed", "note", "owner", "version"]);
    state = { ...state, ...value, version: state.version + 1, updatedAt: new Date().toISOString() };
    state.events = [
      {
        version: state.version,
        actorGithubUserId: "7",
        actorLogin: "alice",
        owner: state.owner,
        note: state.note,
        dismissed: state.dismissed,
        createdAt: state.updatedAt as string,
      },
    ];
    return route.fulfill({ json: state });
  });
  await page.goto("http://127.0.0.1:4175");
  await page.locator("tbody tr button").first().click();
  const review = page.getByRole("region", { name: "Shared team review" });
  await expect(review.getByLabel("Team owner")).toBeVisible();
  await review.getByLabel("Team owner").fill("alice");
  await review.getByLabel("Team review note").fill("Check the new API example");
  await review.getByRole("button", { name: "Save shared review" }).click();
  await expect(review.getByText("Shared review saved.")).toBeVisible();
  await review.getByText("Recent review history").click();
  await expect(review.getByText("Open · Owner: alice")).toBeVisible();
  conflict = true;
  state = { ...state, version: 2, owner: "bob", note: "Teammate changed this" };
  await review.getByLabel("Team review note").fill("My unsaved draft");
  await review.getByRole("button", { name: "Save shared review" }).click();
  await expect(review.getByRole("alert")).toContainText("Someone changed this review");
  await expect(review.getByLabel("Team review note")).toHaveValue("My unsaved draft");
  await expect(review.getByRole("button", { name: "Save shared review" })).toBeDisabled();
  await review.getByRole("button", { name: "Reload latest (discards draft)", exact: true }).click();
  await expect(review.getByLabel("Team owner")).toHaveValue("bob");
  await expect(review.getByLabel("Team review note")).toHaveValue("Teammate changed this");
});

test("shared review outage never substitutes browser-only persistence", async ({ page }) => {
  const dashboard = getDemoDashboard();
  dashboard.mode = "live";
  const run = dashboard.runs[0];
  if (!run) throw new Error("Missing fixture");
  await page.route("**/api/dashboard", (route) => route.fulfill({ json: dashboard }));
  await page.route(`**/api/review/${run.id}`, (route) =>
    route.fulfill({ json: { ...getDemoReview(run.id), mode: "live" } }),
  );
  await page.route(`**/api/review/${run.id}/state`, (route) =>
    route.fulfill({ status: 503, json: { error: "Unavailable" } }),
  );
  await page.goto("http://127.0.0.1:4175");
  await page.locator("tbody tr button").first().click();
  await expect(
    page.getByRole("region", { name: "Shared team review" }).getByRole("alert"),
  ).toBeVisible();
  await expect(page.getByText("Your local review", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save shared review" })).toHaveCount(0);
});
