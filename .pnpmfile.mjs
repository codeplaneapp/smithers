/**
 * Development-only compiler isolation. These exact tool versions require the
 * classic TypeScript API. Give each its own compiler instead of letting the
 * package being linted supply its runtime TypeScript 7 through a peer edge.
 * Nothing in a published runtime manifest or install is changed by this hook.
 */
export const classicCompilerTools = new Map([
  ["madge", "8.0.0"],
  ["typescript-eslint", "8.69.0"],
  ["@typescript-eslint/parser", "8.69.0"],
  ["@typescript-eslint/typescript-estree", "8.69.0"],
  ["@typescript-eslint/project-service", "8.69.0"],
  ["@typescript-eslint/tsconfig-utils", "8.69.0"],
  ["@typescript-eslint/utils", "8.69.0"],
  ["@typescript-eslint/eslint-plugin", "8.69.0"],
  ["@typescript-eslint/type-utils", "8.69.0"]
])

export const hooks = {
  readPackage(pkg) {
    const version = classicCompilerTools.get(pkg.name)
    if (version === undefined || version !== pkg.version) return pkg
    const peerDependencies = { ...pkg.peerDependencies }
    delete peerDependencies.typescript
    return {
      ...pkg,
      dependencies: { ...pkg.dependencies, typescript: "5.9.3" },
      peerDependencies
    }
  }
}
