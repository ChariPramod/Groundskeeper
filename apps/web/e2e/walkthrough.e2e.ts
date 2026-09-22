import { expect, test } from "@playwright/test";

test("walkthrough explains the complete repair path and returns to the dashboard", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Product walkthrough" }).click();
  await expect(page).toHaveURL(/\/walkthrough$/);
  await expect(page.getByText("Illustrative scenario.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Previous step" })).toBeDisabled();
  for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "Next step" }).click();
  await expect(
    page.getByRole("heading", { name: "A reviewable draft, with evidence" }),
  ).toBeVisible();
  await expect(
    page.getByText("The maintainer decides whether to merge.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Explore the workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "A healthier home for your docs." }),
  ).toBeVisible();
});

test("unavailable runtime blocks the illustrative repair and restart clears state on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/walkthrough");
  await page.getByRole("checkbox", { name: "Simulate unavailable runtime" }).check();
  await page.getByRole("button", { name: "03 The example is checked" }).click();
  await expect(page.getByRole("heading", { name: "Unknown, not passed" })).toBeVisible();
  await page.getByRole("button", { name: "Next step" }).click();
  await expect(page.getByRole("heading", { name: "Repair blocked" })).toBeVisible();
  await page.getByRole("button", { name: "Next step" }).click();
  await expect(page.getByRole("heading", { name: "No draft PR is created" })).toBeVisible();
  await page.getByRole("button", { name: "Restart walkthrough" }).click();
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Previous step" })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
