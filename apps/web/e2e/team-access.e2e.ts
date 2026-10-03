import { expect, test } from "@playwright/test";
import { getDemoDashboard } from "../lib/demo-data";
import { changeDemoTeam, demoTeam } from "../lib/team-management-client";

test("sample team supports reviewed changes, retained audit history and last-admin protection", async ({
  page,
}) => {
  let requests = 0;
  await page.route("**/api/team*", (route) => {
    requests++;
    return route.abort();
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Team access", exact: true })
    .click();
  const team = page.getByRole("region", { name: "Team access" });
  await team.getByRole("button", { name: "Remove GitHub user 1001" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Remove access", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Add another admin");
  await dialog.getByRole("button", { name: "Reload team", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await team.getByLabel("GitHub numeric ID", { exact: true }).fill("9000");
  await team.getByRole("button", { name: "Review access", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("GitHub user #9000 to viewer access");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(team.getByText("GitHub user #9000", { exact: true })).toHaveCount(0);
  await team.getByRole("button", { name: "Review access", exact: true }).click();
  await dialog.getByRole("button", { name: "Confirm access", exact: true }).click();
  await expect(team.getByLabel("Role for GitHub user 9000")).toHaveValue("viewer");
  await team.getByLabel("Role for GitHub user 9000").selectOption("reviewer");
  const member = team
    .getByRole("listitem")
    .filter({ has: page.getByText("GitHub user #9000", { exact: true }) });
  await member.getByRole("button", { name: "Review change" }).click();
  await dialog.getByRole("button", { name: "Confirm access", exact: true }).click();
  await expect(team.getByText("User #9000 · viewer → reviewer", { exact: true })).toBeVisible();
  await team.getByRole("button", { name: "Remove GitHub user 9000" }).click();
  await dialog.getByRole("button", { name: "Remove access", exact: true }).click();
  await expect(team.getByLabel("Role for GitHub user 9000")).toHaveCount(0);
  await expect(
    team.getByText("User #9000 · reviewer → Access removed", { exact: true }),
  ).toBeVisible();
  await team.getByRole("button", { name: "Reset sample team" }).click();
  await expect(team.getByText("User #9000", { exact: false })).toHaveCount(0);
  expect(requests).toBe(0);
});

test("admin saves are confirmed, conflicts require reload and lost access clears the roster", async ({
  page,
}) => {
  const dashboard = getDemoDashboard();
  dashboard.mode = "live";
  let directory = demoTeam();
  let status = 200;
  let saves = 0;
  await page.route("**/api/dashboard", (route) => route.fulfill({ json: dashboard }));
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: { githubUserId: "1001", login: "maya", role: "admin", viewScope: "a".repeat(64) },
    }),
  );
  await page.route("**/api/team*", (route) => {
    if (route.request().method() === "PUT") {
      saves++;
      if (status !== 200) return route.fulfill({ status, json: { error: "Unavailable" } });
      const body = route.request().postDataJSON();
      expect(Object.keys(body).sort()).toEqual(["githubUserId", "role", "version"]);
      directory = changeDemoTeam(directory, body);
      return route.fulfill({ json: { version: directory.version, changed: true } });
    }
    return route.fulfill({ status: status === 403 ? 403 : 200, json: directory });
  });
  await page.goto("http://127.0.0.1:4175");
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Team access", exact: true })
    .click();
  const team = page.getByRole("region", { name: "Team access" });
  await team.getByLabel("GitHub numeric ID", { exact: true }).fill("9000");
  await team.getByRole("button", { name: "Review access", exact: true }).click();
  const dialog = page.getByRole("dialog");
  expect(saves).toBe(0);
  await dialog.getByRole("button", { name: "Confirm access", exact: true }).click();
  await expect(team.getByLabel("Role for GitHub user 9000")).toHaveValue("viewer");
  status = 409;
  await team.getByRole("button", { name: "Remove GitHub user 9000" }).click();
  await dialog.getByRole("button", { name: "Remove access", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Reload the team");
  await expect(dialog.getByRole("button", { name: "Remove access", exact: true })).toHaveCount(0);
  expect(saves).toBe(2);
  await dialog.getByRole("button", { name: "Reload team", exact: true }).click();
  await expect(team.getByLabel("Role for GitHub user 9000")).toHaveValue("viewer");
  status = 403;
  await team.getByRole("button", { name: "Refresh team", exact: true }).click();
  await expect(team.getByText("GitHub user #9000", { exact: true })).toHaveCount(0);
  await expect(team.getByLabel("GitHub numeric ID", { exact: true })).toHaveCount(0);
  await expect(team.getByRole("alert")).toContainText("Admin access is no longer available");
});

test("an uncertain save pauses editing and a session downgrade closes admin controls", async ({
  page,
}) => {
  const dashboard = getDemoDashboard();
  dashboard.mode = "live";
  let role = "admin";
  let requests = 0;
  await page.route("**/api/dashboard", (route) => route.fulfill({ json: dashboard }));
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: { githubUserId: "1001", login: "maya", role, viewScope: "a".repeat(64) },
    }),
  );
  await page.route("**/api/team*", (route) => {
    requests++;
    return route.fulfill({
      json: route.request().method() === "PUT" ? { unexpected: true } : demoTeam(),
    });
  });
  await page.goto("http://127.0.0.1:4175");
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Team access", exact: true })
    .click();
  const team = page.getByRole("region", { name: "Team access" });
  await team.getByRole("button", { name: "Remove GitHub user 1002" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Remove access", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("could not be confirmed");
  role = "viewer";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(team.getByText("You have viewer access.", { exact: false })).toBeVisible();
  await expect(team.getByLabel("Role for GitHub user 1002")).toHaveCount(0);
  const previousRequests = requests;
  await page.reload();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Team access", exact: true })
    .click();
  await expect(team.getByText("You have viewer access.", { exact: false })).toBeVisible();
  expect(requests).toBe(previousRequests);
});
