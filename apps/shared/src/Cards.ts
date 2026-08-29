import { z } from "zod"
import { RepoPluginSchema, RepoSchema, TargetSchema } from "./LocalApp"
import {
  AffectedCardPayloadSchema,
  CiMatrixCardPayloadSchema,
  GraphCardPayloadSchema,
  RunHistoryCardPayloadSchema,
  RunTimelineCardPayloadSchema
} from "./TargetGraph"

/*
 * The card wire model, shared by the server boundary (which validates frames off
 * the upstream stream), the web agent, and the client store. A card is how the
 * agent surfaces structured state — a plan, an approval request, a status — into
 * the transcript; the client renders it with zero UI changes per DESIGN.md §5.
 */

export const CardPlanItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["pending", "active", "done"])
})
export type CardPlanItem = z.infer<typeof CardPlanItemSchema>

const cardBaseShape = {
  id: z.string(),
  title: z.string(),
  body: z.string().optional(),
  status: z.enum(["active", "acted", "error"]),
  createdAt: z.number(),
  ordinal: z.number().int().nonnegative()
}

export const CardSchema = z.discriminatedUnion("kind", [
  z.object({
    ...cardBaseShape,
    kind: z.literal("plan"),
    payload: z.object({ items: z.array(CardPlanItemSchema) })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("approval"),
    payload: z.object({
      capability: z.string(),
      detail: z.string().optional(),
      /*
       * The run identity an approval decision round-trips against
       * (gateway submitApproval RPC). Optional so Wave-1 demo cards stay
       * valid; a card without them cannot be decided against a backend.
       */
      runId: z.string().optional(),
      nodeId: z.string().optional(),
      iteration: z.number().int().nonnegative().optional(),
      /** Wave 11: the watched repo whose per-user gateway the run lives on. */
      repo: z.string().optional(),
      decision: z.enum(["approved", "denied"]).optional(),
      decidedAt: z.number().optional(),
      /** A decision is in flight to the backend: the card must not be re-decided. */
      pending: z.boolean().optional(),
      /** The last decision attempt failed; the card stays retryable. */
      error: z.string().optional(),
      /*
       * A chain approval park (DESIGN.md §14): the decision resolves against
       * the in-app chain runtime (runId = the lineage) and resumes it, not
       * against the workflow gateway — so nodeId/iteration never apply.
       * `background` marks a lineage the runtime resumes itself: the
       * controller freezes the card and starts no turn.
       */
      chain: z.boolean().optional(),
      background: z.boolean().optional(),
      /** The parked call's flow name; with `capability` it reconstructs the ask after a reload. */
      flow: z.string().optional()
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("balance"),
    payload: z.object({
      totalUsd: z.string(),
      state: z.enum(["ok", "low", "empty"]),
      allowedToStartWork: z.boolean(),
      lifetimeChargedUsd: z.string(),
      chargeCount: z.number().int().nonnegative(),
      /** The one-time first-run grant ("You have $500 of usage on us."), when unspent. */
      introUsd: z.string().nullable()
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("status"),
    payload: z.object({
      progress: z.number().min(0).max(1).optional(),
      note: z.string().optional()
    })
  }),
  /* The admin plugin's cards (Launch Checklist §E — registered only for admin sessions). */
  z.object({
    ...cardBaseShape,
    kind: z.literal("grant-confirm"),
    payload: z.object({
      login: z.string(),
      amountUsd: z.number().positive(),
      phase: z.enum(["confirm", "sending", "granted", "failed"]),
      grantId: z.string().optional(),
      error: z.string().optional()
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("request-queue"),
    payload: z.object({
      requests: z.array(
        z.object({
          login: z.string(),
          note: z.string().nullable(),
          createdAt: z.string()
        })
      ),
      /** The login an allowlist-add is in flight for (one at a time). */
      approving: z.string().nullable(),
      error: z.string().optional()
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("admin-health"),
    payload: z.object({
      services: z.array(
        z.object({
          name: z.string(),
          status: z.enum(["ok", "failed", "unconfigured"]),
          detail: z.string()
        })
      ),
      queueDepth: z.number().int().nonnegative().nullable(),
      charges: z
        .object({
          chargeCount: z.number().int().nonnegative(),
          lifetimeChargedUsd: z.string()
        })
        .nullable(),
      checkedAt: z.string()
    })
  }),
  /*
   * Wave 10 — the repo-chooser card: the onboarding conversation's one
   * question, embedded in the transcript (never a takeover). `via` records
   * how the chooser was opened (first run, /repos.watch, or the agent tool)
   * and lands on the PUT /api/identity/watched call unchanged.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("repo-chooser"),
    payload: z.object({
      candidates: z.array(
        z.object({
          fullName: z.string(),
          private: z.boolean(),
          pushedAt: z.string().nullable(),
          openIssues: z.number().int().nonnegative()
        })
      ),
      selected: z.array(z.string()),
      via: z.enum(["onboarding", "command", "agent"]),
      phase: z.enum(["choosing", "saving", "failed"]),
      error: z.string().optional()
    })
  }),
  /* The connect surface as an embedded chat card (the agent's connect form; §2c″). */
  z.object({
    ...cardBaseShape,
    kind: z.literal("connect"),
    payload: z.object({
      github: z.object({ connected: z.boolean(), login: z.string().nullable() }),
      nativeAvailable: z.boolean()
    })
  }),
  /* A world query's embedded answer card (the agent's world form; §2c″). */
  z.object({
    ...cardBaseShape,
    kind: z.literal("world"),
    payload: z.object({
      documents: z.array(
        z.object({ path: z.string(), title: z.string(), confidence: z.number() })
      )
    })
  }),
  /*
   * The browser surface (Wave 10, §2d′): an embedded, maximizable view of a
   * URL. `frameable:false` carries the honest blocked reason (the site
   * refused framing) — never a silent blank.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("browser"),
    payload: z.object({
      url: z.string(),
      finalUrl: z.string().nullable(),
      status: z.number().int().nullable(),
      frameable: z.boolean(),
      blockReason: z.string().nullable(),
      error: z.string().optional()
    })
  }),
  /*
   * Wave 11 — the embedded run card: a workflow run on the user's workspace
   * gateway, tracked live from the relay event stream. `steps` is the node
   * progress in words (a short tail); `result` leads once the run settles.
   * `lastSeq` is the per-run event cursor so a reload resumes the pump from
   * exactly where it stopped (reconnect-and-replay).
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("flow-run"),
    payload: z.object({
      repo: z.string(),
      runId: z.string(),
      workflow: z.string(),
      phase: z.enum([
        "launching",
        "running",
        "waiting-approval",
        "reconnecting",
        /*
         * Wave 12 §3 — the bounded client stance. A run the workspace never
         * finishes goes QUIET rather than being polled forever: after a
         * generous stale bound with no event progress the card says so
         * plainly and offers stop/retry. Honest, not silent, and not a
         * pump hammering a workspace that has stopped answering.
         */
        "quiet",
        /*
         * The human stopped WATCHING. This seam relays no cancelRun, so
         * "cancelled" would be a claim about the workspace that nothing
         * proves — the honest state is the one about this client.
         */
        "stopped",
        "completed",
        "failed",
        "cancelled",
        "no-capacity"
      ]),
      steps: z.array(z.string()),
      result: z.string().nullable(),
      error: z.string().optional(),
      lastSeq: z.number().int().nonnegative(),
      /** How long the run had gone without progress when it went quiet. */
      quietForMs: z.number().int().nonnegative().optional()
    })
  }),
  /* The workspace's workflows as an embedded card (flow.list). */
  z.object({
    ...cardBaseShape,
    kind: z.literal("workflow-list"),
    payload: z.object({
      repo: z.string(),
      workflows: z.array(
        z.object({ key: z.string(), description: z.string().nullable() })
      )
    })
  }),
  /*
   * Wave 12 §2 — which watched repository. With more than one watched repo and
   * no `owner/repo` argument, the target is a genuine user choice (the
   * ≤3-questions law permits it), so it is asked as an embedded card among the
   * WATCHED set — never guessed, never a takeover. One act answers it.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("workflow-repo"),
    payload: z.object({
      /** The pending intent this choice completes. */
      intent: z.literal("create"),
      description: z.string(),
      repos: z.array(z.string()),
      chosen: z.string().nullable()
    })
  }),
  /*
   * The multi-parity domain cards (MULTI-ACTIONS-GAP.md Tier 1/2): issues,
   * landings ("PRs" — landing is QUEUED, never "merged"), BYOK keys,
   * notifications, the agent environment, and the repo import job. Payloads
   * mirror the platform answers trimmed to what the card states; bodies live
   * in src/mainview/cards/*.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("issue-list"),
    payload: z.object({
      repo: z.string(),
      filter: z.enum(["open", "closed", "all"]),
      issues: z.array(
        z.object({
          number: z.number().int(),
          title: z.string(),
          state: z.enum(["open", "closed"]),
          author: z.string().nullable(),
          comments: z.number().int().nonnegative(),
          updatedAt: z.string().nullable()
        })
      )
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("issue"),
    payload: z.object({
      repo: z.string(),
      number: z.number().int(),
      title: z.string(),
      state: z.enum(["open", "closed"]),
      author: z.string().nullable(),
      issueBody: z.string(),
      labels: z.array(z.string()),
      comments: z.array(
        z.object({
          author: z.string().nullable(),
          commentBody: z.string(),
          createdAt: z.string().nullable()
        })
      )
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("pr-list"),
    payload: z.object({
      repo: z.string(),
      landings: z.array(
        z.object({
          number: z.number().int(),
          title: z.string(),
          state: z.string(),
          author: z.string().nullable(),
          updatedAt: z.string().nullable()
        })
      )
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("pr"),
    payload: z.object({
      repo: z.string(),
      number: z.number().int(),
      title: z.string(),
      /** Platform landing state; "queued" after a land — never "merged". */
      state: z.string(),
      author: z.string().nullable(),
      prBody: z.string(),
      reviews: z.array(
        z.object({
          author: z.string().nullable(),
          type: z.string(),
          reviewBody: z.string()
        })
      ),
      checks: z.array(z.object({ context: z.string(), state: z.string() }))
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("keys"),
    payload: z.object({
      keys: z.array(z.object({ provider: z.string(), masked: z.string() }))
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("notifications"),
    payload: z.object({
      unread: z.number().int().nonnegative(),
      items: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          repo: z.string().nullable(),
          reason: z.string().nullable(),
          createdAt: z.string().nullable(),
          read: z.boolean()
        })
      )
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("env"),
    payload: z.object({
      repo: z.string(),
      vars: z.array(z.object({ name: z.string(), value: z.string() })),
      setupScript: z.string().nullable(),
      /** Secret NAMES only — values are write-only upstream and never surface. */
      secretNames: z.array(z.string())
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("repo-import"),
    payload: z.object({
      repo: z.string(),
      jobId: z.string().nullable(),
      phase: z.enum(["starting", "running", "done", "failed"]),
      detail: z.string().nullable()
    })
  }),
  /* Wave 2 of the multi parity: bookmarks (jj branches) and repo file reads. */
  z.object({
    ...cardBaseShape,
    kind: z.literal("branches"),
    payload: z.object({
      repo: z.string(),
      bookmarks: z.array(z.object({ name: z.string(), head: z.string().nullable() }))
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("file-list"),
    payload: z.object({
      repo: z.string(),
      path: z.string(),
      entries: z.array(z.object({ name: z.string(), kind: z.enum(["file", "dir"]) }))
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("file"),
    payload: z.object({
      repo: z.string(),
      path: z.string(),
      content: z.string(),
      /** True when the read was cut at the card cap; the full file stays upstream. */
      truncated: z.boolean(),
      /*
       * The file's bytes are not text. The card states that instead of
       * printing them: base64 rendered as source is one 42626px line the
       * reader cannot use and cannot reach (§8.27). Optional so cards
       * persisted before the field parse without a schema reset.
       */
      binary: z.boolean().optional()
    })
  }),
  /*
   * The /theme picker: one swatch per palette, painted in that palette's own
   * colors. `selected` is the palette live when the card last synced; the
   * mainview owns the palette list, so the payload carries only the key.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("theme-picker"),
    payload: z.object({
      selected: z.string()
    })
  }),
  /*
   * The local app's repository cards (apps/ui/docs/LOCAL-APP.md "Cards"):
   * the opened repository, its trusted typed target list, and one streamed
   * target run. The legacy html variant remains decodable for existing rows,
   * but the product no longer creates executable model-authored panels.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("targets"),
    payload: z.object({
      repoId: z.string(),
      repoName: z.string(),
      status: z.enum(["pending", "done", "failed"]),
      targets: z.array(TargetSchema),
      warnings: z.array(z.string()),
      /** The row an explicit target.open flow pointed at; the list highlights it. */
      highlighted: z.string().optional()
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("html"),
    payload: z.object({
      title: z.string(),
      html: z.string(),
      source: z.enum(["agent", "template"]),
      repoId: z.string()
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("target-run"),
    payload: z.object({
      runId: z.string(),
      repoId: z.string(),
      label: z.string(),
      status: z.enum(["running", "done", "failed"]),
      exitCode: z.number().nullable(),
      output: z.string()
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("repo"),
    payload: z.object({ repo: RepoSchema })
  }),
  /*
   * The target-graph cards (smithers-shared/TargetGraph): the typed DAG with
   * plan facts and an optional live run overlay, one run's timeline with its
   * critical path, the run history with replay, the diff-affected set, and
   * the generated CI matrix.
   */
  z.object({ ...cardBaseShape, kind: z.literal("graph"), payload: GraphCardPayloadSchema }),
  z.object({ ...cardBaseShape, kind: z.literal("run-timeline"), payload: RunTimelineCardPayloadSchema }),
  z.object({ ...cardBaseShape, kind: z.literal("run-history"), payload: RunHistoryCardPayloadSchema }),
  z.object({ ...cardBaseShape, kind: z.literal("affected"), payload: AffectedCardPayloadSchema }),
  z.object({ ...cardBaseShape, kind: z.literal("ci-matrix"), payload: CiMatrixCardPayloadSchema }),
  /*
   * The repo plugin card (LOCAL-APP.md "Plugin manifest"): the repository's
   * parsed `.smithers/UI.json`, upserted ahead of the targets card when the
   * manifest is valid. Each entry's Run rides the existing `target.run` flow.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("repo-plugin"),
    payload: z.object({ repoId: z.string(), manifest: RepoPluginSchema })
  })
])
export type Card = z.infer<typeof CardSchema>

export const CardPatchSchema = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
  status: z.enum(["active", "acted", "error"]).optional(),
  payload: z.unknown().optional(),
  createdAt: z.number().optional(),
  ordinal: z.number().int().nonnegative().optional()
})
export type CardPatch = z.infer<typeof CardPatchSchema>
