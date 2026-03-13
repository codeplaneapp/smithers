import { LinearWebhookClient } from "@linear/sdk/webhooks";
import type { LinearWebhookHandler } from "@linear/sdk/webhooks";
import { Effect } from "effect";
import { getLinearClient } from "./client";
import React from "react";
import { fromPromise } from "../effect/interop";
import { logError, logInfo, logWarning } from "../effect/logging";
import { runPromise } from "../effect/runtime";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type WebhookServerOptions = {
  /** Port for the local webhook server (default: 3456) */
  port?: number;
  /** Public URL that Linear will POST to (e.g. ngrok tunnel URL) */
  publicUrl: string;
  /** Scope webhook to a specific team ID */
  teamId?: string;
  /** Resource types to subscribe to (default: ["Issue"]) */
  resourceTypes?: string[];
  /** Display name in Linear webhook settings */
  label?: string;
  /** AbortSignal for external shutdown */
  signal?: AbortSignal;
};

export type WebhookServer = {
  /** The webhook handler — call `.on("Issue", ...)` to register listeners */
  handler: LinearWebhookHandler;
  /** The Linear webhook ID (for reference) */
  webhookId: string;
  /** Gracefully deregister webhook from Linear and stop the server */
  shutdown: () => Promise<void>;
};

export type WebhookIssueEvent = {
  action: string;
  issueId: string;
  identifier: string;
  title: string;
  teamId: string;
  labelIds: string[];
  labels: { id: string; name: string; color: string }[];
  description: string | null;
  url: string;
  updatedFrom: Record<string, unknown> | undefined;
};

export type UseLinearWebhookOptions = {
  /** Port for the local webhook server (default: 3456) */
  port?: number;
  /** Public URL that Linear will POST to */
  publicUrl: string;
  /** Scope webhook to a specific team ID */
  teamId?: string;
  /** Label name that triggers processing */
  triggerLabel: string;
  /** Display name in Linear webhook settings */
  label?: string;
};

export type UseLinearWebhookResult = {
  /** Issues that have been triggered (trigger label newly added) */
  issues: WebhookIssueEvent[];
  /** Whether the webhook server is ready */
  ready: boolean;
  /** The webhook ID (for debugging) */
  webhookId: string | null;
  /** Dismiss an issue from the queue after processing starts */
  dismiss: (issueId: string) => void;
  /** Shutdown function for cleanup */
  shutdown: (() => Promise<void>) | null;
};

// ---------------------------------------------------------------------------
// Imperative API — startWebhookServer
// ---------------------------------------------------------------------------

/**
 * Start a Bun.serve webhook server and register it with Linear.
 */
export async function startWebhookServer(
  opts: WebhookServerOptions,
): Promise<WebhookServer> {
  return runPromise(startWebhookServerEffect(opts));
}

export function startWebhookServerEffect(
  opts: WebhookServerOptions,
) {
  const {
    port = 3456,
    publicUrl,
    teamId,
    resourceTypes = ["Issue"],
    label = "smithers-webhook",
    signal,
  } = opts;

  const secret = crypto.randomUUID();
  const webhookClient = new LinearWebhookClient(secret);
  const handler = webhookClient.createHandler();

  return Effect.gen(function* () {
    const server = Bun.serve({
      port,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname === "/webhook") {
          return handler(req);
        }
        if (req.method === "GET" && url.pathname === "/health") {
          return new Response("ok");
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    logInfo("started linear webhook server", {
      port,
      publicUrl,
      teamId: teamId ?? null,
      resourceTypes: resourceTypes.join(","),
      label,
    }, "linear:webhook");

    const linearClient = getLinearClient();
    const webhookUrl = `${publicUrl.replace(/\/$/, "")}/webhook`;

    const result = yield* fromPromise("create linear webhook", () =>
      linearClient.createWebhook({
        url: webhookUrl,
        resourceTypes,
        secret,
        teamId: teamId ?? undefined,
        label,
        enabled: true,
      }),
    );

    const webhookRef = result.webhook;
    const webhook = webhookRef
      ? yield* fromPromise("resolve created linear webhook", () => webhookRef)
      : undefined;
    if (!webhook) {
      server.stop();
      throw new Error("Failed to create Linear webhook — no webhook returned");
    }

    const webhookId = webhook.id;
    logInfo("registered linear webhook", {
      webhookId,
      webhookUrl,
      teamId: teamId ?? null,
    }, "linear:webhook");

    let shutdownCalled = false;

    const shutdownEffect = Effect.gen(function* () {
      if (shutdownCalled) return;
      shutdownCalled = true;
      logInfo("shutting down linear webhook server", {
        webhookId,
      }, "linear:webhook");
      const deleted = yield* Effect.either(
        fromPromise("delete linear webhook", () =>
          linearClient.deleteWebhook(webhookId),
        ),
      );
      if (deleted._tag === "Left") {
        logWarning("failed to deregister linear webhook", {
          webhookId,
          error:
            deleted.left instanceof Error
              ? deleted.left.message
              : String(deleted.left),
        }, "linear:webhook");
      } else {
        logInfo("deregistered linear webhook", {
          webhookId,
        }, "linear:webhook");
      }
      yield* Effect.sync(() => {
        server.stop();
      });
      logInfo("stopped linear webhook server", {
        webhookId,
      }, "linear:webhook");
    }).pipe(
      Effect.annotateLogs({
        port,
        webhookId,
      }),
      Effect.withLogSpan("linear:webhook-shutdown"),
    );

    const shutdown = () => runPromise(shutdownEffect);

    if (signal) {
      if (signal.aborted) {
        yield* shutdownEffect;
      } else {
        signal.addEventListener("abort", () => {
          void runPromise(shutdownEffect).catch((error) => {
            logError("failed to shutdown linear webhook server after abort", {
              webhookId,
              error:
                error instanceof Error ? error.message : String(error),
            }, "linear:webhook");
          });
        }, { once: true });
      }
    }

    return { handler, webhookId, shutdown };
  }).pipe(
    Effect.annotateLogs({
      port,
      publicUrl,
      teamId: teamId ?? "",
      label,
    }),
    Effect.withLogSpan("linear:webhook-start"),
  );
}

// ---------------------------------------------------------------------------
// React Hook — useLinearWebhook
// ---------------------------------------------------------------------------

/**
 * React hook that starts a Linear webhook server and accumulates triggered issues.
 *
 * When a Linear issue gets the trigger label added, it appears in the returned
 * `issues` array. Call `dismiss(issueId)` to remove it after processing starts.
 *
 * The webhook server is started once on mount and cleaned up on unmount.
 */
export function useLinearWebhook(
  opts: UseLinearWebhookOptions,
): UseLinearWebhookResult {
  const [issues, setIssues] = React.useState<WebhookIssueEvent[]>([]);
  const [ready, setReady] = React.useState(false);
  const [webhookId, setWebhookId] = React.useState<string | null>(null);
  const shutdownRef = React.useRef<(() => Promise<void>) | null>(null);
  const seenRef = React.useRef(new Set<string>());

  // Stable refs for opts to avoid re-running effect on every render
  const optsRef = React.useRef(opts);
  optsRef.current = opts;

  React.useEffect(() => {
    let cancelled = false;

    (async () => {
      const { port, publicUrl, teamId, triggerLabel, label } = optsRef.current;

      const server = await startWebhookServer({
        port,
        publicUrl,
        teamId,
        resourceTypes: ["Issue"],
        label: label ?? "smithers-webhook",
      });

      if (cancelled) {
        await server.shutdown();
        return;
      }

      shutdownRef.current = server.shutdown;
      setWebhookId(server.webhookId);
      setReady(true);

      server.handler.on("Issue", (payload) => {
        if (cancelled) return;

        const { action, data, updatedFrom } = payload;
        if (action !== "update") return;

        // Check team if scoped
        if (teamId && data.teamId !== teamId) return;

        // Check trigger label is present
        const triggerLower = triggerLabel.toLowerCase();
        const hasLabel = data.labels.some(
          (l) => l.name.toLowerCase() === triggerLower,
        );
        if (!hasLabel) return;

        // Check it was newly added
        const prevLabelIds: string[] =
          ((updatedFrom as Record<string, unknown> | undefined)
            ?.labelIds as string[]) ?? [];
        const triggerLabelObj = data.labels.find(
          (l) => l.name.toLowerCase() === triggerLower,
        );
        if (triggerLabelObj && prevLabelIds.includes(triggerLabelObj.id)) {
          return; // was already present
        }

        // Deduplicate
        if (seenRef.current.has(data.id)) return;
        seenRef.current.add(data.id);

        const event: WebhookIssueEvent = {
          action,
          issueId: data.id,
          identifier: data.identifier,
          title: data.title,
          teamId: data.teamId,
          labelIds: data.labelIds,
          labels: data.labels.map((l) => ({
            id: l.id,
            name: l.name,
            color: l.color,
          })),
          description: data.description ?? null,
          url: data.url,
          updatedFrom: updatedFrom as Record<string, unknown> | undefined,
        };

        setIssues((prev) => [...prev, event]);
      });
    })();

    return () => {
      cancelled = true;
      if (shutdownRef.current) {
        void shutdownRef.current();
      }
    };
  }, []); // run once on mount

  const dismiss = React.useCallback((issueId: string) => {
    setIssues((prev) => prev.filter((i) => i.issueId !== issueId));
  }, []);

  return {
    issues,
    ready,
    webhookId,
    dismiss,
    shutdown: shutdownRef.current,
  };
}

// ---------------------------------------------------------------------------
// React Component — LinearWebhookListener
// ---------------------------------------------------------------------------

export type LinearWebhookListenerProps = UseLinearWebhookOptions & {
  /** Called when a new issue is triggered by the webhook */
  onIssue: (event: WebhookIssueEvent) => void;
  /** Called when the webhook server is ready */
  onReady?: (info: { webhookId: string; shutdown: () => Promise<void> }) => void;
};

/**
 * React component that listens for Linear webhook events.
 * Uses useLinearWebhook internally — all hooks run inside smithers' React.
 *
 * Renders nothing (returns null). Calls onIssue for each triggered issue.
 */
export function LinearWebhookListener(props: LinearWebhookListenerProps) {
  const { onIssue, onReady, ...hookOpts } = props;
  const { issues, ready, webhookId, dismiss, shutdown } =
    useLinearWebhook(hookOpts);

  // Notify parent when ready
  React.useEffect(() => {
    if (ready && webhookId && shutdown && onReady) {
      onReady({ webhookId, shutdown });
    }
  }, [ready, webhookId]);

  // Dispatch new issues to callback and dismiss them
  React.useEffect(() => {
    for (const event of issues) {
      onIssue(event);
      dismiss(event.issueId);
    }
  }, [issues]);

  return null;
}
