import { z } from "zod"
import { AgentRoleIdSchema } from "./AgentRoles"
import {
  ChangeCheckSchema,
  ChangeDiffSchema,
  ChangeFacetSchema,
  ChangeFindingSchema,
  ChangeRevisionSchema,
  ChangeThreadSchema,
  ChangeVerdictSchema,
  ChangesetStateSchema,
  RevisionPinSchema
} from "./Changes"
import { HARNESS_IDS, RepoPluginSchema, RepoSchema, TargetSchema } from "./LocalApp"
import {
  AffectedCardPayloadSchema,
  CiMatrixCardPayloadSchema,
  GraphCardPayloadSchema,
  GraphNodeSchema,
  NodeTimingSchema,
  RunHistoryCardPayloadSchema,
  RunRecordSchema,
  RunSummarySchema,
  RunTimelineCardPayloadSchema
} from "./TargetGraph"

/*
 * The targets card's table state (apps/ui cards/TargetsTable.ts): the filter
 * the user set, the row they selected, and what the card has read about
 * individual targets. All optional: cards persisted before the table parse.
 */
export const TARGET_RUN_STATES = ["never", "passed", "failed", "running"] as const
export const TargetRunStateSchema = z.enum(TARGET_RUN_STATES)
export type TargetRunState = z.infer<typeof TargetRunStateSchema>

/** The table's views: the repository's essentials, everything, or what ran most recently. */
export const TARGETS_VIEW_MODES = ["featured", "all", "recent"] as const
export const TargetsViewModeSchema = z.enum(TARGETS_VIEW_MODES)
export type TargetsViewMode = z.infer<typeof TargetsViewModeSchema>

/** One pattern run a manifest features (LocalApp featuredPatternRuns): a verb over a pattern. */
export const PatternRunEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  workspace: z.string(),
  verb: z.string(),
  pattern: z.string()
})
export type PatternRunEntry = z.infer<typeof PatternRunEntrySchema>

export const TargetsViewSchema = z.object({
  /** Featured / All / Recent; absent = Featured when the repo has featured or starred targets, else All. */
  mode: TargetsViewModeSchema.optional(),
  /** Substring match on the label or the workspace. */
  query: z.string().optional(),
  /** Kind chips that are ON; absent or empty = every kind. */
  kinds: z.array(z.string()).optional(),
  /** Last-run state chips that are ON; absent or empty = every state. */
  states: z.array(TargetRunStateSchema).optional(),
  /** One workspace, or absent for all. */
  workspace: z.string().optional(),
  /** The row whose detail drawer is open. */
  selected: z.string().optional(),
  /** Grouped rows (same name across packages, `//...:name`) the user expanded, by group label. */
  expanded: z.array(z.string()).optional(),
  /** Per group label, the member labels picked to run; absent = every member. */
  picked: z.record(z.string(), z.array(z.string())).optional()
})
export type TargetsView = z.infer<typeof TargetsViewSchema>

/** What the card has read about one target through `graph <label> --plan`. */
export const TargetDetailSchema = z.object({
  status: z.enum(["pending", "done", "failed"]),
  node: GraphNodeSchema.optional(),
  deps: z.array(z.string()).optional(),
  rdeps: z.array(z.string()).optional(),
  error: z.string().optional()
})
export type TargetDetail = z.infer<typeof TargetDetailSchema>

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
  ordinal: z.number().int().nonnegative(),
  /**
   * The conversation this card belongs to (LOCAL-APP.md "Tabs"). There is
   * one Smithers, so live cards carry no id; the field stays so cards
   * persisted by a build that had conversation tabs parse unchanged.
   */
  tabId: z.string().optional()
}

/*
 * Lane sync (ADR 0005 "Rate limits"): a GitHub-proxied call's rate-limit
 * facts, carried on the card that made the refused call (or whose status
 * read reports them). `resetAt` is the wire's reset timestamp; null when
 * the wire names none. The line renders only from these fields — a plain
 * 429 with no structured body (plue#472's shape is not deployed) reads as
 * the verbatim error, never an invented reset.
 */
export const GitHubRateLimitSchema = z.object({
  limit: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  resetAt: z.string().nullable()
})
export type GitHubRateLimit = z.infer<typeof GitHubRateLimitSchema>

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
       * The run identity an approval decision round-trips against (the
       * gateway's `Approval.Submit` procedure). Optional so demo cards stay
       * valid; a card without them cannot be decided against a backend.
       */
      runId: z.string().optional(),
      /** The gate's own id, which is what identifies it to the engine. */
      requestId: z.string().optional(),
      /*
       * The submit-ready `ApprovalTarget.Node` envelope the gateway published
       * with the request. A decision hands this back unchanged, so the client
       * never reconstructs the authority it is exercising.
       */
      approval: z.record(z.string(), z.unknown()).optional(),
      /** The loaded repository whose per-user gateway the run lives on. */
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
       * against the workflow gateway — so requestId never applies.
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
      quietForMs: z.number().int().nonnegative().optional(),
      /*
       * Lane runs — the run lifecycle the card surfaces. All optional so
       * cards persisted before the lane parse.
       */
      /** The launch input, so `runs.rerun` relaunches the same flow with the same arguments. */
      input: z.record(z.string(), z.unknown()).optional(),
      /** Why a live run is not moving, in the control plane's word ("approval", "timer", "executor" when accepted). */
      waiting: z.string().optional(),
      /** Whether an operator steer is queued for the run. */
      steeringPending: z.boolean().optional(),
      /** Which body tab the card shows; the steps tail by default. */
      facet: z.enum(["steps", "transcript", "events"]).optional(),
      /** Whether the transcript keeps following the live run. */
      follow: z.boolean().optional(),
      /** The transcript tab's rows, merged from the transcript projection while the card follows. */
      transcriptRows: z
        .array(
          z.object({
            sequence: z.number(),
            turn: z.number().optional(),
            at: z.number().optional(),
            kind: z.string(),
            text: z.string()
          })
        )
        .optional(),
      /** The events tab's records: the run's raw control events in journal order. */
      events: z.array(z.record(z.string(), z.unknown())).optional()
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
   * Lane runs §2 — the run inbox: every run on the workspace, one summary row
   * each, with the filters the listing was cut at so the card states what it
   * shows. A row opens its run card; the filters are the flow's arguments,
   * never hidden state.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("run-list"),
    payload: z.object({
      repo: z.string(),
      /** Every status the unfiltered workspace carried when listed; the filter chips read it. Optional for older cards. */
      statuses: z.array(z.string()).optional(),
      status: z.string().optional(),
      flow: z.string().optional(),
      lineage: z.string().optional(),
      runs: z.array(
        z.object({
          runId: z.string(),
          flowId: z.string(),
          status: z.string(),
          waiting: z.string().optional(),
          createdAt: z.number(),
          turns: z.number().int().nonnegative(),
          calls: z.number().int().nonnegative()
        })
      )
    })
  }),
  /*
   * Lane runs §5 — the approvals inbox: every pending gate across the
   * workspace's runs. Each row carries the submit-ready envelope the gateway
   * published, so a decision goes back with it unchanged — the client never
   * reconstructs authority.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("approvals-inbox"),
    payload: z.object({
      repo: z.string(),
      approvals: z.array(
        z.object({
          runId: z.string(),
          requestId: z.string(),
          title: z.string(),
          approval: z.record(z.string(), z.unknown()),
          requestedAt: z.number(),
          decision: z.enum(["approved", "denied"]).optional(),
          decisionError: z.string().optional(),
          /** A decision is in flight: the buttons hide until the server answers, so a second click cannot send a contradicting decision. */
          pending: z.boolean().optional()
        })
      )
    })
  }),
  /*
   * Wave 12 §2 — which loaded repository. With more than one loaded repo and
   * no `owner/repo` argument, the target is a genuine user choice (the
   * ≤3-questions law permits it), so it is asked as an embedded card among the
   * loaded set — never guessed, never a takeover. One act answers it.
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
          updatedAt: z.string().nullable(),
          /** Where the row came from: jjhub's own tracker, or GitHub for a mirrored repo. Optional so older cards parse. */
          source: z.enum(["jjhub", "github"]).optional(),
          htmlUrl: z.string().optional()
        })
      ),
      /**
       * The GitHub read's provenance (X-Metadata-* headers on
       * /api/user/github-repos/{o}/{r}/issues): "synced" with a syncedAt, or
       * "live"; stale=true when the store is behind; a sync error verbatim.
       * Absent when GitHub was not read (not linked, not mirrored, refused).
       */
      github: z.object({
        source: z.string(),
        syncedAt: z.string().nullable(),
        stale: z.boolean(),
        syncError: z.string().nullable(),
        refusal: z.string().nullable()
      }).optional()
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
      /*
       * Lane sync (ADR 0005 "Link an issue to Linear"): the Linear mapping
       * when the issue DTO carries one (`Linear ENG-482`); absent until
       * plue#473, and absent-vs-null is not distinguished — no mapping line
       * renders without the DTO field. Optional so older cards parse.
       */
      linear: z.object({ identifier: z.string(), url: z.string() }).nullable().optional(),
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
  /*
   * Lane sync (ADR 0005): the import becomes a job card. `stage`, `counts`,
   * `error`, `repository`, and `workspaceId` are the progress fields of
   * plue#471 — all optional, parsed only when the wire carries them, never
   * invented (today's answer carries stage and error only).
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("repo-import"),
    payload: z.object({
      repo: z.string(),
      jobId: z.string().nullable(),
      phase: z.enum(["starting", "running", "done", "failed"]),
      detail: z.string().nullable(),
      /** The job's raw stage word (`provisioning_workspace`); optional — older answers carry none. */
      stage: z.string().nullable().optional(),
      /** Progress counts (`refs 214 of 214 · objects … · issues …`); absent until plue#471's wire fields. */
      counts: z.object({
        refs: z.object({ done: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
        objects: z.object({ done: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
        issues: z.object({ done: z.number().int().nonnegative(), total: z.number().int().nonnegative() })
      }).optional(),
      /** The job's error verbatim; the failed phase renders it with Retry. */
      error: z.string().nullable().optional(),
      /** The imported repository, when the job's answer names it (the done state links it). */
      repository: z.object({ owner: z.string(), name: z.string() }).nullable().optional(),
      /** The workspace the import created, when it created one (the done state links its card). */
      workspaceId: z.string().nullable().optional(),
      /** A refused GitHub call's rate-limit line (lane sync; GitHubRateLimitSchema below). */
      rateLimit: GitHubRateLimitSchema.optional()
    })
  }),
  /*
   * Lane sync (ADR 0005): the connector-setup card — one kind serves both
   * handoffs. The steps are the wizard (`linear`: authorize → team →
   * repository → confirm; `github`: install → reconcile), rendered as rows
   * that fill in; a failed step reads the server error verbatim on its own
   * line. On confirm the SAME card turns into the connected state (`phase:
   * "connected"`), which for Linear carries the integration and for GitHub
   * the installation. The setup key is the OAuth callback's opaque one-time
   * handle (plue#469's team pick; expires in minutes — an expired one reads
   * `authorization expired · Open Linear again`, never a silent retry).
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("connector-setup"),
    payload: z.object({
      connector: z.enum(["linear", "github"]),
      /** `org/repo` — the repository being connected. */
      repo: z.string(),
      phase: z.enum(["setup", "connected"]),
      steps: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          state: z.enum(["pending", "active", "done", "error"]),
          /** The row's filled-in value (`authorized as <actor>`, `ENG · Engineering`); null while unset. */
          detail: z.string().nullable(),
          /** The server error verbatim, under the step that failed. */
          error: z.string().optional()
        })
      ),
      /** The OAuth callback's setup handle (Linear only); the team pick and the create consume it. */
      setupKey: z.string().optional(),
      setupExpiresAt: z.string().optional(),
      /** `authorized as <actor>` — only when the setup answer names the viewer; never invented. */
      actor: z.string().nullable().optional(),
      /** The teams the setup key can see (Linear step 2). */
      teams: z.array(z.object({ id: z.string(), name: z.string(), key: z.string() })).optional(),
      /** The picked team (Linear step 2's one click). */
      teamId: z.string().optional(),
      /** The connected Linear integration (the connected state's header and last-sync line). */
      integration: z.object({
        id: z.number().int(),
        teamKey: z.string(),
        teamName: z.string(),
        active: z.boolean(),
        lastSyncAt: z.string().nullable()
      }).optional(),
      /** The GitHub App installation (the connected state's `installation <id> · configured`). */
      installationId: z.number().int().nullable().optional(),
      configured: z.boolean().optional(),
      /** The trusted install URL (https://github.com only) step 1 opens. */
      installUrl: z.string().optional(),
      /** The rate-limit line: below 20% remaining, and always on a card whose call was refused. */
      rateLimit: GitHubRateLimitSchema.optional(),
      /** The last act's honest refusal, kept on the card. */
      error: z.string().optional()
    })
  }),
  /*
   * Lane sync (ADR 0005): the sync-ops card — one kind serves Linear syncs
   * and GitHub mirror syncs. Rows are the durable ops, newest first, a
   * failed row carrying the server's error verbatim with a Retry act
   * (`sync.retry <opId>`); failures are never filtered out. The header's
   * run state and counts stay live while ops arrive once sync runs exist
   * (plue#468 Linear, plue#470 mirror); until then `runState` is null, the
   * ops list is empty, and `opsNote` renders the ADR's degraded wording —
   * the feed is never faked.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("sync-ops"),
    payload: z.object({
      /** The header subject: `Linear ENG ↔ org/repo` or `Mirror · org/repo`. */
      subject: z.string(),
      source: z.enum(["linear", "github-mirror"]),
      /** The Linear integration id the run belongs to (Linear only). */
      integrationId: z.string().optional(),
      /** `org/repo` (the mirror's repository). */
      repo: z.string().optional(),
      /** The run's state from the sync-run DTO; null until plue#468/#470 — no state word is faked. */
      runState: z.enum(["running", "done", "failed"]).nullable(),
      /** The header counts from the run DTO; absent with it. */
      counts: z.object({
        total: z.number().int().nonnegative(),
        done: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative()
      }).nullable().optional(),
      /** The one fact the trigger answered (`sync started`, `already running`, `synced`); null when it said nothing. */
      trigger: z.string().nullable().optional(),
      /** The ops, newest first; empty while the ops feed doesn't exist (plue#468/#470). */
      ops: z.array(
        z.object({
          id: z.string(),
          source: z.string(),
          target: z.string(),
          entity: z.string(),
          entityId: z.string().nullable(),
          action: z.string(),
          status: z.enum(["done", "failed", "running", "pending"]),
          /** The server error verbatim, on its own line. */
          error: z.string().optional(),
          retryable: z.boolean(),
          at: z.string().nullable()
        })
      ),
      /** Why the ops list is empty (the ADR's degraded wording); absent when the feed answered. */
      opsNote: z.string().optional(),
      /** The activity window this card was cut at (`24h`), when it is the activity view. */
      window: z.string().optional(),
      /** `show more` revealed the whole cut; the first N rows show by default. */
      expanded: z.boolean().optional(),
      /** Older ops exist beyond this cut (`load older` pages the feed). */
      hasOlder: z.boolean().optional(),
      /** The rate-limit line when a GitHub call behind this card was refused. */
      rateLimit: GitHubRateLimitSchema.optional(),
      /** The last act's honest refusal, kept on the card. */
      error: z.string().optional()
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
  /*
   * Lane piper (ADR 0001): file cards carry the GLOBAL path
   * (`/org/repo/path`) and the position they were read at. `readAt.commitId`
   * is what "head moved" compares — a change id survives a rebase, a commit
   * id does not. Optional so cards persisted before the fields parse.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("file-list"),
    payload: z.object({
      repo: z.string(),
      path: z.string(),
      entries: z.array(z.object({ name: z.string(), kind: z.enum(["file", "dir"]) })),
      /** True when the listing was cut (a local directory past its cap); optional so older cards parse. */
      truncated: z.boolean().optional(),
      /** The global path (`/org/repo/path`); absent on cards written before lane piper. */
      address: z.string().optional(),
      readAt: z.object({
        changeId: z.string().nullable(),
        commitId: z.string().nullable(),
        /** `head` = read at the repository head (head-moved applies); `working-copy` = read at a checkout's `@` (drift is "N ahead", never "head moved"). */
        source: z.enum(["head", "working-copy"]).optional()
      }).optional()
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
      binary: z.boolean().optional(),
      /** The global path (`/org/repo/path`); absent on cards written before lane piper. */
      address: z.string().optional(),
      /*
       * Lane change (ADR 0003 §3): the revision pin `{ changeId, seq,
       * commitId }`. `seq` stays absent until plue#450 records revisions —
       * a card read from a local working copy pins by commit id, never a
       * server seq. Optional so cards persisted before the lane parse.
       */
      readAt: z.object({
        changeId: z.string().nullable(),
        commitId: z.string().nullable(),
        seq: z.number().int().positive().nullable().optional(),
        source: z.enum(["head", "working-copy"]).optional()
      }).optional()
    })
  }),
  /*
   * Lane change (ADR 0003 — the change is the unit): the change card. One
   * fact per line of the ADR's mockup and nothing else: the header (change
   * id, `rev N of M` once plue#450 records revisions, stack position,
   * landing state), the description, the per-repo stat, checks / findings /
   * review at the current revision, the conflict line, the current
   * revision's provenance, and the facet strip (Diff, Findings, Checks,
   * Review, History).
   *
   * Degraded until #450-#457 land: `currentSeq`/`revisionCount` are null and
   * `revisions` is empty (the header reads `qupxosqw · a03f5f`, the History
   * facet reads "revision history not recorded yet"); `diff` offers
   * `parent → current` only (interdiff is #451); `findings` is null (no
   * route, #454); verdicts and threads carry `commitId: null` and
   * `state: null` (#453). Nothing is inferred from timestamps.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("change"),
    payload: z.object({
      /** `org/repo` the change was read from. */
      repo: z.string(),
      changeId: z.string(),
      description: z.string(),
      /** The current revision's commit (today's DTO carries exactly one). */
      commitId: z.string().nullable(),
      /** Today's DTO carries none — null until plue#450, never invented. */
      currentSeq: z.number().int().positive().nullable(),
      revisionCount: z.number().int().nonnegative().nullable(),
      revisions: z.array(ChangeRevisionSchema),
      /** The current revision's provenance: the author and timestamp the DTO states. */
      authorName: z.string().nullable(),
      timestamp: z.string().nullable(),
      /** One entry per repo touched, with its stat (one repo is one entry, not a group header). */
      repos: z.array(
        z.object({
          repo: z.string(),
          additions: z.number().int().nonnegative(),
          deletions: z.number().int().nonnegative()
        })
      ),
      /** The diff the Diff facet renders; null while unread. */
      diff: ChangeDiffSchema.nullable(),
      /** Check rows at the current commit (the statuses route); null while unread. */
      checks: z.array(ChangeCheckSchema).nullable(),
      /** Findings per revision; null — the route does not exist (plue#454). */
      findings: z.array(ChangeFindingSchema).nullable(),
      /**
       * Verdicts and threads on the change's landing request; null while unread
       * (`unread.reviews` / `unread.threads` name why), [] once the landing list
       * was read and no request carries the change.
       */
      reviews: z.array(ChangeVerdictSchema).nullable(),
      threads: z.array(ChangeThreadSchema).nullable(),
      /** The change's per-file conflicts; null while unread (`unread.conflicts` names why). */
      conflicts: z.array(z.object({ path: z.string(), state: z.string() })).nullable(),
      /** The landing request carrying this change: its state, the change's stack position, the target. */
      stack: z.object({
        landingNumber: z.number().int(),
        state: z.string(),
        /** 1-based from the bottom, like `jj log`. */
        position: z.number().int().positive(),
        size: z.number().int().positive(),
        /** The request's change ids in request order; the last is the top, whose Land lands 1 → size. */
        changeIds: z.array(z.string()),
        targetBookmark: z.string(),
        conflictStatus: z.string()
      }).nullable(),
      /** The changeset this change belongs to (live at /api/orgs/{org}/changesets); null when none. */
      changeset: ChangesetStateSchema.nullable(),
      /**
       * Why an auxiliary above is null: the failed read's reason in the
       * platform's words. One rule (ChangeSeam `surfaceChange`): a read writes
       * every auxiliary from its own answer, a failed read writes null and
       * names it here, and nothing from an earlier read survives.
       */
      unread: z.object({
        diff: z.string().optional(),
        conflicts: z.string().optional(),
        checks: z.string().optional(),
        reviews: z.string().optional(),
        threads: z.string().optional(),
        stack: z.string().optional(),
        changeset: z.string().optional()
      }).optional(),
      /** Which body tab the card shows; the diff by default. */
      facet: ChangeFacetSchema.optional(),
      /** The last act's honest refusal, kept on the card. */
      error: z.string().optional()
    })
  }),
  /*
   * Lane change (ADR 0003 §1/§3): the `diff` card — one change's diff at two
   * pinned revisions (`parent ▾ → rev 5 ▾`; degraded: `parent → current`
   * only). The header carries the revision pin; when the change's current
   * revision moves past the pin and BOTH seqs are known, one mono line
   * `rev N exists · view` — never a claim a commit comparison cannot name.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("diff"),
    payload: z.object({
      repo: z.string(),
      changeId: z.string(),
      /** The pickers' tokens: "parent", "current", or "rev N" once revisions exist. */
      from: z.string(),
      to: z.string(),
      /** Where the `to` side pins: seq null until plue#450 records revisions. */
      pin: RevisionPinSchema,
      files: ChangeDiffSchema.shape.files,
      /** The one file this card was cut at, when the flow named one. */
      path: z.string().optional(),
      error: z.string().optional()
    })
  }),
  /*
   * Lane citc (ADR 0002): the workspace card — a persistent cloud computer
   * bound to a repository bookmark. The payload carries exactly what plue's
   * workspace DTO carries: NO kind, NO uptime, NO workspace head, NO
   * ahead/behind (plue#446 — never faked). `bookmarkHead` is the TARGET
   * BOOKMARK's head from the bookmarks call, labeled as such in the header —
   * never the workspace's own head. The Files and Services facets have no
   * routes (plue#449), so no payload fields serve them: they render empty.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("workspace"),
    payload: z.object({
      workspaceId: z.string(),
      /** `org/repo` — the repository the workspace is bound to. */
      repo: z.string(),
      name: z.string(),
      targetBookmark: z.string().nullable(),
      /** plue's six statuses: pending, starting, running, suspended, stopped, failed. */
      status: z.enum(["pending", "starting", "running", "suspended", "stopped", "failed"]),
      provisioningStage: z.string().nullable(),
      /** When the workspace last suspended (DTO); optional so older cards parse. */
      suspendedAt: z.string().nullable().optional(),
      /** The target bookmark's head from the bookmarks call — the BOOKMARK head, never the workspace head. */
      bookmarkHead: z.object({
        changeId: z.string().nullable(),
        commitId: z.string().nullable()
      }).nullable(),
      snapshots: z.array(
        z.object({ id: z.string(), name: z.string(), createdAt: z.string().nullable() })
      ),
      sessions: z.array(
        z.object({ id: z.string(), status: z.string(), createdAt: z.string().nullable() })
      ),
      /** Which body tab the card shows; the terminal by default. */
      facet: z.enum(["terminal", "files", "services", "snapshots"]).optional(),
      /** The plue session the card's Terminal facet (and its tab) is attached to. */
      terminalSessionId: z.string().optional(),
      /** The last act's honest refusal, kept on the card. */
      error: z.string().optional()
    })
  }),
  /*
   * Lane citc: one workspace service's log (WORKBENCH-UX §3.1 Services
   * facet). The routes that would feed it do not exist yet (plue#449), so no
   * flow produces this card today — the schema lands with the workspace card
   * so the contract is one change, and the body renders what it is handed.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("service-log"),
    payload: z.object({
      workspaceId: z.string(),
      repo: z.string(),
      service: z.string(),
      lines: z.array(z.string()),
      follow: z.boolean()
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
   * target run.
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
      highlighted: z.string().optional(),
      /** The table's filter and selection (TargetsViewSchema). */
      view: TargetsViewSchema.optional(),
      /** The repository's recorded runs, read from /api/targets/runs; the table derives each row's last run. */
      runs: z.array(RunRecordSchema).optional(),
      /** Per-label facts the drawer read (declaration site, plan, deps/rdeps), keyed by label. */
      details: z.record(z.string(), TargetDetailSchema).optional(),
      /** The labels the repository's `smithers-ui.json` marks featured (LocalApp featuredLabels). */
      featured: z.array(z.string()).optional(),
      /** The labels this user starred for the repository (target.star), mirrored from app-starred-targets. */
      starred: z.array(z.string()).optional(),
      /** The manifest's featured pattern runs (`ci //packages/...`): the Featured view's run strip. */
      patternRuns: z.array(PatternRunEntrySchema).optional()
    })
  }),
  z.object({
    ...cardBaseShape,
    kind: z.literal("target-run"),
    /*
     * One execution: a single target (`label`) or a pattern run (`verb` +
     * `pattern`, e.g. `ci //packages/...`, the way "run everything" runs).
     * `nodes` fills as the executor reports each target, `summary` lands at
     * the end; `output` is the raw stream for the Raw output accordion, and
     * `nodeOutput` the chunks the backend attributed to one target.
     */
    payload: z.object({
      runId: z.string(),
      repoId: z.string(),
      label: z.string(),
      verb: z.string().optional(),
      pattern: z.string().optional(),
      status: z.enum(["running", "done", "failed"]),
      exitCode: z.number().nullable(),
      output: z.string(),
      startedAt: z.number().optional(),
      endedAt: z.number().optional(),
      nodes: z.array(NodeTimingSchema).optional(),
      summary: RunSummarySchema.optional(),
      nodeOutput: z.record(z.string(), z.string()).optional()
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
   * parsed `smithers-ui.json`, upserted ahead of the targets card when the
   * manifest is valid. Each entry's Run rides the existing `target.run` flow.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("repo-plugin"),
    payload: z.object({ repoId: z.string(), manifest: RepoPluginSchema })
  }),
  /*
   * An agent launched from the `+` menu as a subagent of the conversation
   * (LOCAL-APP.md "Tabs"): the harness runs in its own tab, and this card is
   * the conversation's record of it — which harness, where, whether it is
   * still running, and the way back to its tab.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("agent"),
    payload: z.object({
      harnessId: z.enum(HARNESS_IDS),
      displayName: z.string(),
      /** The named role the agent was launched as (AgentRoles.ts); absent for a raw harness. */
      roleId: AgentRoleIdSchema.optional(),
      /** The task it was delegated, when it was launched with one. */
      task: z.string().optional(),
      /** The tab the agent runs in; the tab id is the PTY session id. */
      tabId: z.string(),
      sessionId: z.string(),
      cwd: z.string(),
      phase: z.enum(["running", "exited"]),
      /** The process exit code once it has exited; null when unknown (the tab was closed). */
      exitCode: z.number().nullable()
    })
  }),
  /*
   * The explainer's answer (AgentRoles.ts "explainer"): `explain <what>` runs
   * a side turn that asks for the explainer role, and this card is where the
   * answer streams in — embedded in the conversation, never a takeover.
   */
  z.object({
    ...cardBaseShape,
    kind: z.literal("explain"),
    payload: z.object({
      question: z.string(),
      answer: z.string(),
      phase: z.enum(["asking", "answered", "failed"]),
      /**
       * What the serving side told us about who answered. The request names
       * the explainer role; a server that ignores the hint answers on its
       * default model, and the card says so rather than claiming Kimi.
       */
      answeredBy: z.string(),
      error: z.string().optional()
    })
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
