import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expectNoPageErrors, trackPageErrors } from "./surfaceTestUtils";

const accountsPath = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/smithers-home/accounts.json");
let originalAccounts = "";

test.describe.serial("agents registry", () => {
  test.beforeAll(async () => {
    originalAccounts = await readFile(accountsPath, "utf8");
  });

  test.afterAll(async () => {
    if (originalAccounts) await writeFile(accountsPath, originalAccounts);
  });

  test("filters real accounts, opens details, and completes registration controls", async ({ page }) => {
    const pageErrors = trackPageErrors(page);
    await page.goto("/agents");
    await expect(page.getByTestId("agents-row")).toHaveCount(3);
    await expect(page.getByText("codex-main", { exact: true })).toBeVisible();
    await expect(page.getByText("openai-dormant", { exact: true })).toBeVisible();

    await page.getByTestId("agents-filter").getByRole("button", { name: "Available" }).click();
    await expect(page.getByTestId("agents-row")).toHaveCount(2);
    await expect(page.getByText("openai-dormant", { exact: true })).toHaveCount(0);

    await page.getByTestId("agents-filter").getByRole("button", { name: "Not detected" }).click();
    await expect(page.getByTestId("agents-row")).toHaveCount(1);
    await expect(page.getByTestId("agents-row")).toContainText("openai-dormant");

    await page.getByTestId("agents-filter").getByRole("button", { name: "All" }).click();
    await page.getByTestId("agents-row").filter({ hasText: "codex-main" }).click();
    await expect(page.getByTestId("agents-detail")).toContainText("gpt-5.6-terra");
    await expect(page.getByTestId("agents-detail")).toContainText("Codex");

    await page.getByRole("button", { name: "Register agent" }).click();
    const drawer = page.getByTestId("agents-register");
    await drawer.getByRole("button", { name: "Claude Code" }).click();
    await expect(page.getByTestId("agents-register-config")).toBeVisible();
    await expect(page.getByTestId("agents-register-apikey")).toHaveCount(0);
    await page.getByTestId("agents-register-label").fill("codex-main");
    await expect(drawer).toContainText("already exists");
    await expect(page.getByTestId("agents-register-submit")).toBeDisabled();
    await drawer.getByRole("button", { name: "Cancel" }).click();
    await expect(drawer).toHaveCount(0);

    await page.getByRole("button", { name: "Register agent" }).click();
    await page.getByTestId("agents-register").getByRole("button", { name: "OpenAI API" }).click();
    await expect(page.getByTestId("agents-register-apikey")).toBeVisible();
    await expect(page.getByTestId("agents-register-config")).toHaveCount(0);
    await page.getByTestId("agents-register-label").fill("openai-e2e");
    await page.getByTestId("agents-register-apikey").fill("e2e-placeholder-key");
    await page.getByTestId("agents-register-model").fill("gpt-5.6-luna");
    await page.getByLabel(/Force/).check();
    await page.getByTestId("agents-register-submit").click();
    await expect(page.getByTestId("agents-row").filter({ hasText: "openai-e2e" })).toBeVisible();

    expectNoPageErrors(pageErrors);
  });

  test("renders the empty registry from an empty real accounts fixture", async ({ page }) => {
    const pageErrors = trackPageErrors(page);
    await writeFile(accountsPath, JSON.stringify({ version: 1, accounts: [] }, null, 2));
    try {
      await page.goto("/agents");
      await expect(page.getByText("No agents here.")).toBeVisible();
      await expect(page.getByTestId("agents-row")).toHaveCount(0);
      expectNoPageErrors(pageErrors);
    } finally {
      await writeFile(accountsPath, originalAccounts);
    }
  });
});
