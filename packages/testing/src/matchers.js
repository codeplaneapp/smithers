// src/matchers.ts
function executedOf(received) {
  return Array.isArray(received.executed) ? received.executed : [];
}
function formatValue(value) {
  return JSON.stringify(value);
}
function hasSubsequence(actual, expected) {
  let expectedIndex = 0;
  for (const id of actual) {
    if (id === expected[expectedIndex]) {
      expectedIndex += 1;
    }
    if (expectedIndex === expected.length) {
      return true;
    }
  }
  return expectedIndex === expected.length;
}
function toHaveExecuted(received, ids) {
  const executed = executedOf(received);
  const missing = ids.filter((id) => !executed.includes(id));
  const pass = missing.length === 0;
  return {
    pass,
    message: () =>
      pass
        ? `Expected simulation not to have executed ${formatValue(ids)}, but actual executed nodes were ${formatValue(executed)}.`
        : `Expected simulation to have executed ${formatValue(ids)}, but missing ids were ${formatValue(missing)}. Actual executed nodes were ${formatValue(executed)}.`,
  };
}
function toHaveExecutedInOrder(received, ids) {
  const executed = executedOf(received);
  const pass = hasSubsequence(executed, ids);
  return {
    pass,
    message: () =>
      pass
        ? `Expected simulation not to have executed in order ${formatValue(ids)}, but actual executed order was ${formatValue(executed)}.`
        : `Expected simulation to have executed in order ${formatValue(ids)}, but actual executed order was ${formatValue(executed)}.`,
  };
}
function toHaveFinished(received) {
  const pass = received.status === "finished";
  return {
    pass,
    message: () =>
      pass
        ? 'Expected simulation not to have finished, but status was "finished".'
        : `Expected simulation to have finished, but status was ${formatValue(received.status)}.`,
  };
}
var simMatchers = { toHaveExecuted, toHaveExecutedInOrder, toHaveFinished };
export { simMatchers, toHaveExecuted, toHaveExecutedInOrder, toHaveFinished };
