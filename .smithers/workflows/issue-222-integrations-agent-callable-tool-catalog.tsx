// smithers-source: bespoke
// smithers-display-name: Issue 222 — OAuth authorization-URL builder
/** @jsxImportSource smithers-orchestrator */
import { ClaudeCodeAgent, createSmithers, Sequence, Task, UI, type AgentLike } from "smithers-orchestrator";
import { z } from "zod/v4";
import { ValidationLoop, implementOutputSchema, validateOutputSchema, validationLoopState } from "../components/ValidationLoop";
import { reviewOutputSchema, reviewSynthesisSchema } from "../components/Review";
import { codexFirst } from "../lib/codexAccounts";

// Codex-first role pools: Sol plans/reviews, Luna implements, Terra validates.
const solPool: AgentLike[] = codexFirst({ model: "gpt-5.6-sol", skipGitRepoCheck: true }, [new ClaudeCodeAgent({ model: "claude-opus-4-8" })]);
const lunaPool: AgentLike[] = codexFirst({ model: "gpt-5.6-luna", config: { model_reasoning_effort: "medium" }, skipGitRepoCheck: true }, [new ClaudeCodeAgent({ model: "claude-sonnet-5" })]);
const terraPool: AgentLike[] = codexFirst({ model: "gpt-5.6-terra", skipGitRepoCheck: true }, [new ClaudeCodeAgent({ model: "claude-sonnet-5" })]);

// Issue #222 is an integrations program (72 items). Its named "load-bearing
// gap" is the delegated per-user OAuth connection plane: auth-code + PKCE,
// encrypted storage, single-flight refresh, per-tenant scoping. PKCE helpers
// already landed in packages/accounts (createPkcePair / deriveCodeChallenge).
// This workflow lands the next minimal, pure brick of that plane — a
// network-free OAuth 2.0 authorization-code request URL builder that consumes
// a PKCE challenge and supports per-tenant scoping — TDD-first. It is one
// self-contained checkbox-worth of progress, not the whole epic.

export const inputSchema = z.object({
  spec: z.string().default(
    `Add a pure, network-free OAuth 2.0 authorization-code request URL builder to
\`packages/accounts\`, the next brick of issue #222's delegated per-user OAuth
connection plane (which already has RFC 7636 PKCE helpers in packages/accounts/src/pkce.js).

TDD — write the failing test FIRST, watch it go red, then implement until green.

NEW SOURCE FILE packages/accounts/src/buildAuthorizationUrl.js (JS with JSDoc,
mirroring the style of packages/accounts/src/pkce.js — no TypeScript, node:
built-ins only, NO new dependencies). Export one function:

  buildAuthorizationUrl(request) -> string

It builds an RFC 6749 §4.1.1 authorization-code request URL carrying RFC 7636
PKCE parameters. \`request\` is an object with:
  - authorizationEndpoint: string (required) — the provider authorize URL.
  - clientId: string (required)
  - redirectUri: string (required)
  - state: string (required)
  - codeChallenge: string (required) — from deriveCodeChallenge / createPkcePair.
  - scope?: string | readonly string[] (optional) — an array is joined with a
    single space; a string is used verbatim; omitted entirely when absent/empty.
  - codeChallengeMethod?: "S256" | "plain" (optional, default "S256").
  - extraParams?: Record<string,string> (optional) — extra query params, e.g. a
    per-tenant \`audience\` / \`resource\`. Applied on top of the standard params.

Behavior:
  - Parse authorizationEndpoint with the WHATWG \`URL\`. Throw a TypeError if it
    is not an absolute http:/https: URL. PRESERVE any query params already on
    the endpoint (so a provider/tenant-specific authorize URL keeps its params).
  - Throw a TypeError when clientId, redirectUri, state, or codeChallenge is not
    a non-empty string.
  - Set search params: response_type=code, client_id, redirect_uri, state,
    code_challenge, code_challenge_method, and scope when present. Apply
    extraParams last (they override standard params by design).
  - Return \`url.toString()\`.

Then export it from packages/accounts/src/index.js alongside the pkce exports
(add to the existing \`export { ... } from "./pkce.js";\` line's neighbourhood as
its own \`export { buildAuthorizationUrl } from "./buildAuthorizationUrl.js";\`).
Preserve the @smithers-type-exports block byte-for-byte; do NOT hand-edit index.d.ts.

NEW TEST FILE packages/accounts/tests/buildAuthorizationUrl.test.js (mirror the
style of packages/accounts/tests/pkce.test.js — bun:test describe/test, import
from "../src/index.js"). Cover, at minimum:
  - Builds a URL whose query has response_type=code, the given client_id,
    redirect_uri, state, code_challenge, and code_challenge_method=S256 by
    default; assert by parsing the result with \`new URL(...)\` and reading
    searchParams.
  - scope given as an array is space-joined into a single \`scope\` param; scope
    given as a string is used verbatim; scope omitted entirely when not provided.
  - codeChallengeMethod defaults to "S256" and honours an explicit "plain".
  - extraParams are merged in AND any query params already present on the
    authorizationEndpoint are preserved (per-tenant scoping).
  - Integrates with createPkcePair: passing pair.codeChallenge yields a
    code_challenge param equal to pair.codeChallenge.
  - Throws for a non-absolute / non-http(s) endpoint and for empty clientId,
    redirectUri, state, or codeChallenge.

CONSTRAINTS: minimal, idiomatic, one export per file, no new dependencies, no
unrelated refactors, follow packages/accounts conventions exactly.
VERIFY by running: \`pnpm -C packages/accounts test\` — the new test must go
red before the implementation and green after, and the whole accounts suite
(currently 52 passing) must stay green. Also run \`pnpm -C packages/accounts typecheck\`.`,
  ),
});

const { Workflow, smithers, outputs } = createSmithers({
  input: inputSchema,
  plan: z.object({
    plan: z.string().describe("the concrete implementation plan for buildAuthorizationUrl"),
    testPath: z.string().default("packages/accounts/tests/buildAuthorizationUrl.test.js"),
  }),
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  review: reviewOutputSchema,
  reviewSynthesis: reviewSynthesisSchema,
});

export default smithers((ctx) => {
  const spec = ctx.input.spec ?? "";
  const plan = ctx.latest("plan", "i222:plan");

  const state = validationLoopState(ctx, { prefix: "i222:impl" });

  const implementPrompt = plan
    ? `${spec}\n\n---\nAPPROVED PLAN:\n${plan.plan}`
    : spec;

  return (
    <Workflow name="issue-222-integrations-agent-callable-tool-catalog">
      <UI entry="../ui/implement.tsx" title={"Issue 222 — OAuth authorize URL"} />
      <Sequence>
        <Task id="i222:plan" output={outputs.plan} agent={solPool}>
          {`You are planning a small, well-scoped, pure addition. Read the spec, then read
packages/accounts/src/pkce.js, packages/accounts/src/index.js, packages/accounts/tests/pkce.test.js,
and packages/accounts/src/README.md so the new file matches local conventions exactly. Produce a
concrete, minimal implementation plan and the test path.

SPEC:
${spec}`}
        </Task>

        {plan ? (
          <ValidationLoop
            idPrefix="i222:impl"
            prompt={implementPrompt}
            implementAgents={lunaPool}
            validateAgents={terraPool}
            reviewAgents={[solPool]}
            reviewModerator={solPool}
            synthesizeReview
            reviewWhen={state.validationPassed}
            feedback={state.feedback}
            done={state.done}
            maxIterations={3}
          />
        ) : null}
      </Sequence>
    </Workflow>
  );
});
