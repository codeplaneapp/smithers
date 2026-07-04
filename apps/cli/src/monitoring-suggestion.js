import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { accountsRoot } from "@smithers-orchestrator/accounts";

/**
 * When a workflow starts in the background (a detached `up`/`run`, or an MCP
 * `run_workflow` background launch) the user has no window into its progress.
 * This is the #1 reason people churn wishing for a UI. The CLI can't render a UI
 * for them, but the agent that launched the run can. So on every background
 * start we hand the agent a ready-made prompt: offer the user one of three ways
 * to watch the run, then wire up whichever they pick.
 *
 * Everything here is pure and dependency-injected so it unit-tests without a
 * filesystem.
 */

/**
 * Derive a discovered-workflow id from a workflow file path. `.smithers/ui`
 * entries and seeded workflow ids are keyed by this basename.
 * @param {string} workflowPath
 * @returns {string}
 */
export function workflowIdFromPath(workflowPath) {
    return basename(String(workflowPath)).replace(/\.(tsx|mdx|jsx|ts|js)$/i, "");
}

/**
 * Does a custom `smithers ui` entry already exist for this workflow? Probes
 * the workspace pack (`<cwd>/.smithers/ui/`) and then the global pack
 * (`~/.smithers/ui/`, honoring SMITHERS_HOME), matching how the gateway
 * auto-mounts pack-relative `ui/<id>.tsx` files.
 * @param {string} workflowId
 * @param {string} cwd
 * @param {(p: string) => boolean} [exists]
 * @returns {boolean}
 */
export function hasCustomUi(workflowId, cwd, exists = existsSync) {
    if (!workflowId) return false;
    const candidates = [
        resolve(cwd, ".smithers", "ui", `${workflowId}.tsx`),
        resolve(accountsRoot(), "ui", `${workflowId}.tsx`),
    ];
    return candidates.some((path) => exists(path));
}

/**
 * The monitoring options the agent should offer the user, tailored to
 * whether a custom UI already exists for the workflow. The Smithers Monitor
 * leads: it is live and needs zero setup, so it should be the default pick.
 * @param {{ runId: string; workflowId: string; hasUi: boolean }} params
 * @returns {{ id: string; title: string; how: string }[]}
 */
export function buildMonitoringOptions({ runId, workflowId, hasUi }) {
    const uiStep = hasUi
        ? `run \`smithers ui ${runId}\` (a custom UI already exists for "${workflowId}")`
        : `author \`.smithers/ui/${workflowId}.tsx\` with the gateway-react hooks, then run \`smithers ui ${runId}\``;
    return [
        {
            id: "monitor-ui",
            title: "Smithers Monitor (live, zero setup)",
            how: `Run \`smithers monitor ${runId}\` — opens the gateway's live web UI focused on this run (status, execution tree, events, approvals), no code required.`,
        },
        {
            id: "cron-report",
            title: "Status-report cron (hands-off)",
            how: `Schedule a job that every 5 minutes reads \`smithers inspect ${runId} --format json\` and reports the run's status to the user.`,
        },
        {
            id: "live-ui",
            title: "Live custom UI (richest, most work)",
            how: `Open a real-time browser UI that updates as the run advances: ${uiStep}.`,
        },
        {
            id: "html-page",
            title: "Quick HTML page (fastest)",
            how: `Write a static HTML status page from \`smithers inspect ${runId}\`, open it in the browser, and refresh it about every 5 minutes.`,
        },
    ];
}

/**
 * Agent-directed guidance for a freshly started background run: the prose to
 * surface plus the structured options behind it.
 * @param {{ runId: string; workflowId: string; hasUi: boolean }} params
 * @returns {{ text: string; options: { id: string; title: string; how: string }[] }}
 */
export function buildMonitoringGuidance({ runId, workflowId, hasUi }) {
    const options = buildMonitoringOptions({ runId, workflowId, hasUi });
    const lines = [
        `Run ${runId} is now executing in the background, where the user has no view into its progress.`,
        `Offer the user one of these ways to watch it, then set up whichever they pick:`,
        ...options.map((o, i) => `  ${i + 1}. ${o.title}: ${o.how}`),
    ];
    return { text: lines.join("\n"), options };
}
