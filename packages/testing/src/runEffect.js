// src/runEffect.ts
async function runMaybeEffect(value) {
  if (value == null) {
    return value;
  }
  if (typeof value.then === "function") {
    return value;
  }
  if (typeof value.pipe === "function") {
    const effectMod = await import("effect");
    const Effect = effectMod.Effect;
    return Effect.runPromise(value);
  }
  return value;
}
export {
  runMaybeEffect
};
