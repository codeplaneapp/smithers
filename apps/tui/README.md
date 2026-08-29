# smithers-tui

Local Bun terminal client for the Smithers MVP chat contract, rendered with
`@opentui/core` and `@opentui/react`.

## Launch

From `apps/tui`, attach through a local `wrangler dev` Worker boundary with:

```sh
SMITHERS_TUI_COOKIE='<existing session cookie, if auth is enabled>' bun run dev -- --origin http://localhost:8787
```

The TUI does not add a terminal sign-in flow. As in the native app, an
auth-gated product boundary requires an existing Smithers session; pass its
cookie in `SMITHERS_TUI_COOKIE`. Local boundaries without auth need no cookie.

Attach directly to the same chat upstream used by the native Bun side with:

```sh
SMITHERS_CHAT_URL=https://chat.smithers.sh/chat SMITHERS_CHAT_ORIGIN=https://smithers.sh bun run dev
```

Those are the defaults, so `bun run dev` is sufficient for the production chat
upstream. `SMITHERS_TUI_ORIGIN` is the environment alternative to `--origin`;
`--worker` selects `http://localhost:8787`.

Enter sends, Esc cancels the current turn, and Ctrl+C tears down OpenTUI and
restores the terminal. Transcript persistence and live UI/TUI session mirroring
are explicit follow-up seams; state is in memory for this round.

## Verification

```sh
bun run typecheck
bun test
bun run smoke
```

The smoke command incrementally feeds a scripted, chunk-split
`AgentTurnFrame` NDJSON stream through the headless decoder/store and prints the
resulting transcript plus the next composer-built `StartAgentTurnRequest`.

## OpenTUI prior art

The implementation follows the shell, sticky transcript, focused composer, and
renderer-owned teardown patterns in:

- `reference/opencode/packages/tui/src/app.tsx`
- `reference/opencode/packages/tui/src/routes/session/index.tsx`
- `reference/opencode/packages/tui/src/component/prompt/index.tsx`
- `reference/opencode/packages/tui/src/util/renderer.ts`
- `reference/opencode/packages/tui/src/context/exit.tsx`

It intentionally deviates by using the React reconciler rather than Solid,
keeping a single screen and single-line composer, omitting routes/dialogs/
autocomplete/history, and rendering cards as one-line placeholders. The
installed `@opentui/react` README and component/hook declarations are the API
source for `createRoot`, `useKeyboard`, `useTerminalDimensions`, controlled
`input`, and `scrollbox` props.
