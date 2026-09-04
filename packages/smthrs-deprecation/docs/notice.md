## The unscoped `smthrs` package throws on import

```
smthrs 1.0 is a migration notice, not a runtime.
Smithers 1.0 ships as @smthrs/* packages. Install @smthrs/flows (authoring and engine)
and @smthrs/cli (the `smthrs` command), then run `smthrs migrate` in a 0.x project.
Migration guide: https://smithers.sh/migration/1.0
```

`smthrs@1.0.0-rc.0` is a deprecation notice, not a runtime. Smithers 1.0 has no
umbrella package.

Every 0.x subpath fails in a different, less useful way. `smthrs/jsx-runtime`,
`smthrs/jsx-dev-runtime`, `smthrs/ui`, and the rest raise
`ERR_PACKAGE_PATH_NOT_EXPORTED` with no migration text because the package
exports `.` and nothing else.

`jsxImportSource: "smthrs"` makes every `.tsx` file resolve
`smthrs/jsx-runtime` before anything imports the bare name, so that is the
error most 0.x projects see first. It means the same thing as the notice.

Remove the old package, install the 1.0 packages, and run the migration:

```sh
npm remove smthrs
npm install @smthrs/flows@1.0.0-rc.0 @smthrs/cli@1.0.0-rc.0
npx smthrs migrate
```

`smthrs@0.35.0` keeps the `latest` dist-tag until 1.0.0 is final, so
`npm install smthrs` still installs 0.x. Only `smthrs@next` reaches the notice.
