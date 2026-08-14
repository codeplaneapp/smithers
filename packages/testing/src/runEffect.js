// src/runEffect.ts
async function runMaybeEffect(value) {
  if (value == null) {
    return value;
  }
  if (typeof value.then === "function") {
    return value;
  }
  const { Effect } = await import("effect");
  if (Effect.isEffect(value)) {
    return Effect.runPromise(value);
  }
  return value;
}
export {
  runMaybeEffect
};
