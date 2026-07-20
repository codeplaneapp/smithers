# 🐛 pi-plugin: RunInspector render cache keyed on width only — stale layout on height change, frozen stale-banner seconds

GitHub: https://github.com/smithersai/smithers/issues/589

**What happens**
`RunInspector.render(width, height, theme)` (packages/pi-plugin/src/views/RunInspector.ts:109-112) short-circuits with `if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;`. The cache key ignores `height` and `theme`, but the body height drives the layout (lines 114, 123) and the stale banner renders `Date.now() - staleSince` seconds (line 118).

**Why it's wrong / failure scenario**
- Vertical-only terminal resize: render() is called with a new height but the same width and returns lines laid out for the old height until the next store emit or keypress calls invalidate().
- The "stale: gateway disconnected for Ns" counter (and any time-derived text) freezes at whatever value it had when the cache was filled.

**Expected behavior**
Include height (and theme identity) in the cache key, and either exclude time-dependent lines from caching or bound the cache with a short TTL so the disconnect counter ticks.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
