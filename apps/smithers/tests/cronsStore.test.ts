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
    pendingToggleKeys: [],
    rpc: null,
  });
  useNotificationsStore.setState({ notifications: [] });
});

describe("crons store toggle", () => {
  test("upserts the existing cron once while the same toggle is in flight", async () => {
    const created: unknown[] = [];
    const removed: unknown[] = [];
    let releaseCreate!: () => void;
    bindCronActions({
      create: async (vars) => {
        created.push(vars);
        await new Promise<void>((resolve) => {
          releaseCreate = resolve;
        });
      },
      remove: async (vars) => {
        removed.push(vars);
      },
      refetch: async () => {},
    });

    useCronsStore.getState().toggle(enabledCron.id);
    useCronsStore.getState().toggle(enabledCron.id);

    expect(created).toEqual([{ workflow: "nightly", pattern: "0 3 * * *", cronId: "cron-old", enabled: false }]);
    expect(useCronsStore.getState().pendingToggleKeys).toHaveLength(1);
    releaseCreate();
    for (let index = 0; index < 100 && useCronsStore.getState().pendingToggleKeys.length > 0; index += 1) {
      await Bun.sleep(1);
    }

    expect(removed).toEqual([]);
    expect(useCronsStore.getState().crons).toEqual([expect.objectContaining({ id: "cron-old", enabled: false })]);
    expect(useCronsStore.getState().pendingToggleKeys).toEqual([]);
  });

  test("rolls back and does not claim success when the upsert fails", async () => {
    const created: unknown[] = [];
    const removed: unknown[] = [];
    let refetches = 0;
    bindCronActions({
      create: async (vars) => {
        created.push(vars);
        throw new Error("write unavailable");
      },
      remove: async (vars) => {
        removed.push(vars);
      },
      refetch: async () => {
        refetches += 1;
      },
    });

    useCronsStore.getState().toggle(enabledCron.id);
    for (let index = 0; index < 100 && !useCronsStore.getState().actionError; index += 1) {
      await Bun.sleep(1);
    }

    expect(created).toEqual([{ workflow: "nightly", pattern: "0 3 * * *", cronId: "cron-old", enabled: false }]);
    expect(removed).toEqual([]);
    expect(refetches).toBe(1);
    expect(useCronsStore.getState().actionError).toContain("write unavailable");
    expect(useCronsStore.getState().crons).toEqual([expect.objectContaining({ id: "cron-old", enabled: true })]);
    expect(useNotificationsStore.getState().notifications).toEqual([]);
    expect(useNotificationsStore.getState().notifications.some((item) => item.title === "Trigger disabled")).toBe(
      false,
    );
  });
});
