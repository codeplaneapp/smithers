import { describe, expect, test } from "bun:test";
import { realDbAdapter } from "../src/adapters/realDbAdapter.ts";

describe("real-db adapter admission", () => {
  test("rejects an unwritable or non-production resource before execution", async () => {
    const adapter = realDbAdapter({
      open: async () => ({
        db: {},
        path: "/definitely/not/a/live/smithers.db",
        insertRun: () => undefined,
        heartbeatRun: () => undefined,
        listRuns: () => [],
        close: () => undefined,
      } as never),
    });
    await expect(adapter.admissionProbe()).rejects.toMatchObject({ code: "ADMISSION_FAILED" });
  });
});
