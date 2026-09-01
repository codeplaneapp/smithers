/**
 * The in-process just-bash sandbox provider.
 *
 * A `Sandbox.Provider` whose sessions are directories in a shared virtual
 * filesystem and whose commands run through a buffered just-bash interpreter.
 * The caller must mount both injected surfaces on the same tree. This is a
 * workspace boundary, not a security boundary.
 *
 * @since 0.1.0
 */
export * from "./JustBashLike.ts"
export * from "./make.ts"
