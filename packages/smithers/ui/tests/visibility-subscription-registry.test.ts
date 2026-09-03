import { describe, expect, test } from "bun:test";
import { subscribeVisibility, type VisibilityListeners } from "../src/chat/visibilitySubscriptionRegistry";

describe("visibility subscription registry", () => {
  test("does not retain entries after historical message churn", () => {
    const visibilityListeners: VisibilityListeners = new Map();

    for (let index = 0; index < 100; index += 1) {
      const unsubscribe = subscribeVisibility(visibilityListeners, `message-${index}`, () => {});
      unsubscribe();
    }

    expect(visibilityListeners.size).toBe(0);
  });

  test("keeps an entry until its final listener unsubscribes", () => {
    const visibilityListeners: VisibilityListeners = new Map();
    const firstUnsubscribe = subscribeVisibility(visibilityListeners, "message", () => {});
    const secondUnsubscribe = subscribeVisibility(visibilityListeners, "message", () => {});

    firstUnsubscribe();
    expect(visibilityListeners.has("message")).toBe(true);
    secondUnsubscribe();
    expect(visibilityListeners.has("message")).toBe(false);
  });

  test("does not let stale cleanup remove replacement subscriptions", () => {
    const visibilityListeners: VisibilityListeners = new Map();
    const oldUnsubscribe = subscribeVisibility(visibilityListeners, "message", () => {});

    oldUnsubscribe();
    const newUnsubscribe = subscribeVisibility(visibilityListeners, "message", () => {});
    oldUnsubscribe();

    expect(visibilityListeners.has("message")).toBe(true);
    newUnsubscribe();
    newUnsubscribe();
    expect(visibilityListeners.size).toBe(0);
  });
});
