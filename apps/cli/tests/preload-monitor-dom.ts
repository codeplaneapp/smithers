// Radix selects its layout-effect implementation when the module loads, so
// the monitor component shard needs a DOM before the test module imports any
// shared UI primitive. Keep the registration in Bun's test preload; doing it
// inside the test file is already too late for transitive static imports.
const monitorComponentShard = Bun.argv.some((arg) => arg.endsWith("monitor-shell-controls.test.tsx"));

if (monitorComponentShard) {
  const [{ GlobalRegistrator }, { afterAll }] = await Promise.all([
    import("@happy-dom/global-registrator"),
    import("bun:test"),
  ]);
  const nativeFetch = globalThis.fetch;
  const previousActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;

  GlobalRegistrator.register({ url: "http://localhost/monitor" });
  globalThis.fetch = nativeFetch;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  afterAll(async () => {
    await GlobalRegistrator.unregister();
    globalThis.fetch = nativeFetch;
    if (previousActEnvironment === undefined) {
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    } else {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
  });
}
