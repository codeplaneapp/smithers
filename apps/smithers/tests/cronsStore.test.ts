import { beforeEach, describe, expect, test } from "bun:test";
import { bindCronActions, useCronsStore } from "../src/crons/cronsStore";
import { useNotificationsStore } from "../src/notifications/notificationsStore";

const enabledCron = {
  id: "cron-old",
  name: "nightly",
  pattern: "0 3 * * *",
  workflowPath: "nightly",
  enabled: true,
  nextHint: "Daily at 03:00",
};

beforeEach(() => {
  useCronsStore.setState({
    crons: [enabledCron],
    loading: false,
    error: null,
    actionError: null,
    rpc: null,
  });
  useNotificationsStore.setState({ notifications: [] });
});

describe("crons store toggle", () => {
  test("does not claim an enabled cron was disabled when deleting the old row fails", async () => {
    const created: unknown[] = [];
    const removed: unknown[] = [];
    let refetches = 0;
    bindCronActions({
      create: async (vars) => {
        created.push(vars);
      },
      remove: async (vars) => {
        removed.push(vars);
        throw new Error("delete unavailable");
      },
      refetch: async () => {
        refetches += 1;
      },
    });

    useCronsStore.getState().toggle(enabledCron.id);
    for (let index = 0; index < 100 && !useCronsStore.getState().actionError; index += 1) {
      await Bun.sleep(1);
    }

    expect(created).toEqual([{ workflow: "nightly", pattern: "0 3 * * *", enabled: false }]);
    expect(removed).toEqual([{ cronId: "cron-old" }]);
    expect(refetches).toBe(1);
    expect(useCronsStore.getState().actionError).toContain("old schedule is still active");
    expect(useNotificationsStore.getState().notifications).toEqual([
      expect.objectContaining({
        title: "Trigger still active",
        detail: "nightly · 0 3 * * *",
        status: "failed",
      }),
    ]);
    expect(useNotificationsStore.getState().notifications.some((item) => item.title === "Trigger disabled")).toBe(
      false,
    );
  });
});
