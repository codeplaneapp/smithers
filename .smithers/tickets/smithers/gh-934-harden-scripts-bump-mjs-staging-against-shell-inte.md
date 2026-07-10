# Harden scripts/bump.mjs staging against shell interpolation

GitHub: https://github.com/smithersai/smithers/issues/934

Replace the manually quoted git add command in scripts/bump.mjs with execFileSync or spawnSync using an argument array, preserving all generated pathspecs. Add tests with a fake git executable that capture argv for paths containing spaces, quotes, semicolons, backticks, and dollar syntax, verifying no shell interpretation occurs.
