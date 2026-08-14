# 🧹 react-reconciler: injectIntoDevTools registers stale package name '@smthrs/core-react' (version '0.0.0')

GitHub: https://github.com/smithersai/smithers/issues/608

**What happens**
`packages/react-reconciler/src/reconciler.js:457-462`:
```js
reconciler.injectIntoDevTools({
    bundleType: ...,
    version: "0.0.0",
    rendererPackageName: "@smthrs/core-react",
    ...
});
```

**Why it's wrong**
The package is `@smthrs/react-reconciler`; `@smthrs/core-react` does not exist anywhere in the repo (repo-wide grep matches only this line). Anyone inspecting the `__REACT_DEVTOOLS_GLOBAL_HOOK__` renderer registry sees a nonexistent package at version 0.0.0.

**Expected behavior**
Register the real package name, and ideally the real package version.

Cosmetic / observability-only; the string is externally observable via the DevTools hook, so change deliberately rather than as a drive-by.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
