/**
 * Minimal ambient anchor for the optional Bun matcher augmentation.
 *
 * The testing core is Node-compatible, so importing its declarations must not
 * require consumers to install Bun's global types. When bun-types is present,
 * its full `bun:test` declaration merges with this empty interface.
 */
declare module "bun:test" {
  interface Matchers<T> {}
}
