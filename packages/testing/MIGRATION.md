# Testing harness migration

Descriptor-only `integrationHarness()` and `e2eDescriptor()` remain available
for compatibility, but they deliberately cannot pass admission. A real claim
requires an executable adapter whose admission probe touches the production
database or process.

```ts
// compatibility: reports capability-failure for real capabilities
const oldHarness = integrationHarness();

// production-backed boundary
const harness = integrationHarness({
  adapter: realDbAdapter({ open: async () => openProductionSmithersDb() }),
});
```

The same rule applies to `e2eHarness({ adapter: realProcessAdapter(...) })`.
Unit scenarios remain plain TypeScript: callbacks use `taskRuntime.effect()`
for controllable effects and `taskRuntime.opaque()` when an external effect is
intentionally uncontrollable. External exactly-once claims are rejected; use
at-least-once, an idempotency key, or a journal CAS claim.
