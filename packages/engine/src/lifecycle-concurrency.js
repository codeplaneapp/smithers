import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A process-local admission scope shared by a run and lifecycle-linked child
 * runs. Detached runs never enter this context, even when they record
 * parentRunId for lineage.
 *
 * @typedef {{
 *   readonly ownerRunId: string;
 *   acquire(priority: number, requestingRunId: string): Promise<void>;
 *   release(): void;
 * }} LifecycleConcurrencyScope
 */

/**
 * @typedef {{
 *   runChild<A>(execute: () => Promise<A>): Promise<A>;
 * }} LifecycleTaskLease
 */

/** @type {AsyncLocalStorage<readonly LifecycleConcurrencyScope[]>} */
const childScopesStorage = new AsyncLocalStorage();
/** @type {AsyncLocalStorage<LifecycleTaskLease>} */
const taskLeaseStorage = new AsyncLocalStorage();

/** @returns {readonly LifecycleConcurrencyScope[]} */
export function getLifecycleChildScopes() {
  return childScopesStorage.getStore() ?? [];
}

/** @returns {LifecycleTaskLease | undefined} */
export function getLifecycleTaskLease() {
  return taskLeaseStorage.getStore();
}

/**
 * @template A
 * @param {LifecycleTaskLease} lease
 * @param {() => A} execute
 * @returns {A}
 */
export function withLifecycleTaskLease(lease, execute) {
  return taskLeaseStorage.run(lease, execute);
}

/**
 * @template A
 * @param {readonly LifecycleConcurrencyScope[]} scopes
 * @param {() => Promise<A>} execute
 * @returns {Promise<A>}
 */
export function withLifecycleChildScopes(scopes, execute) {
  return childScopesStorage.run(scopes, execute);
}

/**
 * A task awaiting a lifecycle child must not retain any ancestor/run slots:
 * the child needs those same slots to make progress. Release inner-to-outer
 * before starting it, then reacquire outer-to-inner after it settles so the
 * parent task can finish without introducing a lock cycle.
 *
 * @param {{
 *   heldScopes: readonly LifecycleConcurrencyScope[];
 *   childScopes: readonly LifecycleConcurrencyScope[];
 *   priority: number;
 *   requestingRunId: string;
 * }} options
 * @returns {LifecycleTaskLease}
 */
export function createLifecycleTaskLease(options) {
  let childWaits = 0;
  return {
    async runChild(execute) {
      // Concurrent lifecycle calls from one task share the yielded lease. The
      // last child to settle reacquires it, so an earlier sibling cannot take
      // the only slot while another sibling still needs that slot to finish.
      if (childWaits === 0) {
        for (let index = options.heldScopes.length - 1; index >= 0; index -= 1) {
          options.heldScopes[index].release();
        }
      }
      childWaits += 1;
      try {
        return await withLifecycleChildScopes(options.childScopes, execute);
      } finally {
        childWaits -= 1;
        if (childWaits === 0) {
          for (const scope of options.heldScopes) {
            await scope.acquire(options.priority, options.requestingRunId);
          }
        }
      }
    },
  };
}

/**
 * @param {{
 *   ownerRunId: string;
 *   cap: number;
 *   onWait?: (active: number, waiting: number, requestingRunId: string) => Promise<void> | void;
 * }} options
 * @returns {LifecycleConcurrencyScope}
 */
export function createFixedLifecycleConcurrencyScope(options) {
  let active = 0;
  /** @type {{ priority: number; resolve: () => void }[]} */
  const waiters = [];
  return {
    ownerRunId: options.ownerRunId,
    async acquire(priority, requestingRunId) {
      if (active < options.cap) {
        active += 1;
        return;
      }
      let transferred = false;
      let resolveWaiter = () => {};
      const waitPromise = new Promise((resolve) => {
        resolveWaiter = resolve;
      });
      const waiter = {
        priority,
        resolve: () => {
          transferred = true;
          resolveWaiter();
        },
      };
      let index = waiters.length;
      while (index > 0 && waiters[index - 1].priority < priority) index -= 1;
      waiters.splice(index, 0, waiter);
      try {
        await options.onWait?.(active, waiters.length, requestingRunId);
      } catch (error) {
        if (transferred) {
          const next = waiters.shift();
          if (next) next.resolve();
          else active = Math.max(0, active - 1);
        } else {
          const waiterIndex = waiters.indexOf(waiter);
          if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
        }
        throw error;
      }
      await waitPromise;
    },
    release() {
      const next = waiters.shift();
      if (next) {
        next.resolve();
      } else {
        active = Math.max(0, active - 1);
      }
    },
  };
}
