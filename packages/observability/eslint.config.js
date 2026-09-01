import js from "@eslint/js"
import importPlugin from "eslint-plugin-import"
import unicorn from "eslint-plugin-unicorn"
import tseslint from "typescript-eslint"
import { ambientAuthority, invariants, uninstalledSafety } from "../../eslint.invariants.js"
import { jsdocConvention } from "../../eslint.jsdoc.js"

export default tseslint.config(
  { ignores: ["**/dist", "**/coverage"] },
  js.configs.recommended,
  importPlugin.flatConfigs.recommended,
  importPlugin.flatConfigs.typescript,
  {
    files: ["src/**/*.ts"],
    extends: [tseslint.configs.recommended],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    settings: { "import/resolver": { typescript: { project: ["./tsconfig.json"] } } },
    plugins: { unicorn },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "off",
      "import/no-duplicates": "error",
      "no-console": "error"
    }
  },
  ...jsdocConvention,
  // `swallowedCause` is not wired yet: src/JournalLogger.ts:91 forwards log records
  // through `Effect.catchCause(() => Effect.void)`.
  ...invariants(uninstalledSafety, ambientAuthority)
)
