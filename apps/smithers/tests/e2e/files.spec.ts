import { expect, test } from "@playwright/test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expectNoPageErrors, trackPageErrors } from "./surfaceTestUtils";

const e2eDir = dirname(fileURLToPath(import.meta.url));
const runtimeDir = resolve(e2eDir, "fixtures/runtime-files");
const editablePath = resolve(runtimeDir, "editable.txt");
const readonlyPath = resolve(runtimeDir, "readonly.txt");
const binaryPath = resolve(runtimeDir, "binary.bin");

test.beforeAll(async () => {
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(editablePath, "editable fixture\n");
  await writeFile(readonlyPath, "r".repeat(512 * 1024 + 1));
  await writeFile(binaryPath, Buffer.from([0, 1, 2, 3, 0, 255]));
});

test.afterAll(async () => {
  await rm(runtimeDir, { recursive: true, force: true });
});

async function openRuntimeDirectory(page: import("@playwright/test").Page): Promise<void> {
  for (const name of ["apps", "smithers", "tests", "e2e", "fixtures", "runtime-files"]) {
    await page.getByTestId("files-tree-dir").filter({ hasText: name }).click();
  }
}

test("loads the real tree and renders editable, read-only, and binary previews", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await page.goto("/files");
  await expect(page.getByTestId("files-empty")).toContainText("Select a file");
  await expect(page.getByRole("complementary", { name: "Workspace files" })).toBeVisible();
  await openRuntimeDirectory(page);

  await page.getByTestId("files-tree-file").filter({ hasText: "editable.txt" }).click();
  const editor = page.getByTestId("files-editor-textarea");
  await expect(editor).toHaveValue("editable fixture\n");
  await expect(page.getByTestId("files-save")).toBeDisabled();
  await editor.fill("saved through the real files API\n");
  await expect(page.getByTestId("files-save")).toBeEnabled();
  await page.getByTestId("files-save").click();
  await expect(page.getByTestId("files-save")).toHaveText("Saved");
  expect(await readFile(editablePath, "utf8")).toBe("saved through the real files API\n");

  await page.getByTestId("files-tree-file").filter({ hasText: "readonly.txt" }).click();
  await expect(page.getByTestId("files-readonly-preview")).toContainText("read-only previews");
  await expect(page.getByTestId("files-save")).toBeDisabled();

  await page.getByTestId("files-tree-file").filter({ hasText: "binary.bin" }).click();
  await expect(page.getByTestId("files-binary-preview")).toContainText("Binary file");
  expectNoPageErrors(pageErrors);
});

test("shows dirty state, save success, and real backend save failure feedback", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await writeFile(editablePath, "editable again\n");
  await page.goto("/files");
  await openRuntimeDirectory(page);
  await page.getByTestId("files-tree-file").filter({ hasText: "editable.txt" }).click();
  const editor = page.getByTestId("files-editor-textarea");
  await editor.fill("this save will race a real size change\n");
  await expect(page.getByTestId("files-save")).toHaveText("Save");

  // Change the real workspace file after it was opened so the production API's
  // write-time editability check rejects the stale editor save. No route or
  // response is mocked: this is the actual NOT_EDITABLE backend path.
  await writeFile(editablePath, "x".repeat(512 * 1024 + 1));
  await page.getByTestId("files-save").click();
  await expect(page.locator(".files-alert")).toContainText("This file is not editable through the local UI.");
  await writeFile(editablePath, "editable restored\n");
  expectNoPageErrors(pageErrors);
});
