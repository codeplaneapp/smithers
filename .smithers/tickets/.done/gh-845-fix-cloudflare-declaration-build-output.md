# Fix Cloudflare declaration build output

GitHub: https://github.com/smithersai/smithers/issues/845

Update packages/cloudflare/tsup.config.ts so the d.ts-only build refreshes the committed packages/cloudflare/src/index.d.ts, following the sibling in-place declaration pattern or using an equivalent copy step. Verify the generated declaration matches the source exports.


> Closed by ticket-fleet: landed on main in 64e37cbc02f0365f39610b47fb128632ee163d99.
