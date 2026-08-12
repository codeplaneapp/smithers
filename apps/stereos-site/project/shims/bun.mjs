// Stub for the "bun" module under Node. Only surfaces used by guarded
// code paths; anything else throwing here means a real Bun dependency leaked.
export function plugin() {}
export default { plugin };
