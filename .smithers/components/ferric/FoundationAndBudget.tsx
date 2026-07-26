/** @jsxImportSource smithers-orchestrator */
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Sequence } from "smithers-orchestrator";
import { Task, outputs } from "./ferricSmithers";
import { CampaignGate, gateRow } from "./CampaignGate";
import { Closeout } from "./Closeout";
import { LAUNCH_ROOT, MODEL_CAP_CENTS, PRE_M8_STOP_CENTS, type FerricConfig } from "./ferricConfig";
import { SCRIPTS } from "./ferricShell";
import { RefreshAccountUsage } from "../accounts/RefreshAccountUsage";

/** The workflow's own source, for the runtime self-audit. */
const WORKFLOW_SOURCE = join(LAUNCH_ROOT, ".smithers/workflows/react-rust-port.tsx");
const COMPONENT_DIR = join(LAUNCH_ROOT, ".smithers/components/ferric");

/**
 * Every campaign source file the self-audit must read.
 *
 * Auditing only the workflow and CampaignGate covered 2 of 19 JSX-bearing files:
 * a second `<Approval>` dropped into any Phase*.tsx, Slice.tsx or
 * PublishPipeline.tsx passed undetected while the audit still reported
 * selfAuditOk. Splitting the campaign across files created that blind spot, so
 * the audit enumerates the directory rather than a hand-listed pair.
 */
function campaignSources(): string[] {
  const files = [WORKFLOW_SOURCE];
  try {
    for (const f of readdirSync(COMPONENT_DIR)) {
      if (f.endsWith(".tsx") || f.endsWith(".ts")) files.push(join(COMPONENT_DIR, f));
    }
  } catch {
    /* directory missing is caught by the existence checks below */
  }
  return files;
}

/**
 * Everything that must be true before a single token is spent, plus the budget
 * admission decision for this run.
 *
 * The identity checks exist because three independent blind implementations of
 * this workflow died on the same two bugs: worktree lanes forking one repository
 * while landings merged into another, and a "deterministic" layer that called
 * scripts nothing ever created.
 */
export function FoundationAndBudget({ ctx, c }: { ctx: any; c: FerricConfig }) {
  const budget = ctx.outputMaybe(outputs.frcBudget, { nodeId: "budget" });
  const expansionApproved = gateRow(ctx, "gate-budget-expand")?.approved === true;
  // Depends on the level alone, never on admitNewWork: an audited version gated
  // this on the very flag that goes false when the gate becomes necessary, so
  // the campaign stalled at 90% with no gate and no lifeline.
  const needExpansion = budget != null && budget.levelPctX100 >= 9000 && !expansionApproved;
  // A blocked budget must TERMINATE, not stall. When admission is off and no
  // expansion decision can still change that (hard cap, the pre-M8 stop line, or
  // an expansion the operator denied), the campaign publishes its signed closeout
  // instead of rendering nothing forever with no gate and no lifeline.
  const budgetTerminal =
    budget != null &&
    budget.admitNewWork === false &&
    (budget.levelPctX100 >= 10000 ||
      budget.spentCents >= PRE_M8_STOP_CENTS ||
      gateRow(ctx, "gate-budget-expand")?.approved === false);

  return (
    <Sequence label="foundation">
      {/* Snapshot live per-account headroom BEFORE any seat is chosen. Render is
          synchronous and cannot probe the network, so selection reads this
          task's file; without it the fleet ordering is whatever was true when
          the snapshot was last written. */}
      <RefreshAccountUsage output={outputs.frcAccounts} />
      <Task id="foundation" output={outputs.frcFoundation} retries={0}>
        {async () => {
          const problems: string[] = [];

          const launchRootOk = realpathSync(LAUNCH_ROOT) === realpathSync(c.repo);
          if (!launchRootOk) {
            problems.push(
              `launch root ${LAUNCH_ROOT} != campaign repo ${c.repo} — worktree lanes would fork the wrong repository. Launch from the campaign repo root.`,
            );
          }
          if (!existsSync(join(c.repo, ".jj")) && !existsSync(join(c.repo, ".git"))) {
            problems.push(`${c.repo} is not a jj/git repository`);
          }

          const scriptsOk = SCRIPTS.every((s) => existsSync(join(c.repo, s)));
          if (c.milestone !== "M0" && !scriptsOk) {
            problems.push(`missing deterministic scripts (${SCRIPTS.join(", ")}) — M0 authors them; do not skip M0`);
          }

          const queueOk = existsSync(c.queuePath);
          if (!queueOk) problems.push(`MODULE_QUEUE.tsv not found at ${c.queuePath}`);

          // Self-audit: exactly one Approval mount in the campaign, and no
          // auto-approve anywhere. Makes "every gate is human" checkable.
          let selfAuditOk = true;
          const auditFiles = campaignSources().filter((f) => existsSync(f));
          if (auditFiles.length > 1) {
            // Count real JSX mounts, not prose: a comment mentioning the
            // component (including the one above) must not trip the audit, or
            // the check becomes a game of avoiding words in documentation.
            const codeLines = auditFiles
              .flatMap((f) => readFileSync(f, "utf8").split("\n"))
              .filter((line) => {
                const t = line.trim();
                return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
              });
            const approvalMounts = codeLines.filter((l) => /<Approval(\s|\/|>|$)/.test(l)).length;
            const autoApprovals = codeLines.filter((l) => /autoApprove\s*=/.test(l)).length;
            selfAuditOk = approvalMounts === 1 && autoApprovals === 0;
            if (!selfAuditOk) {
              problems.push(
                `self-audit failed across ${auditFiles.length} campaign files: ${approvalMounts} Approval mounts (want exactly 1, inside CampaignGate), ${autoApprovals} autoApprove props (want 0)`,
              );
            }
          }

          if (problems.length > 0) {
            throw new Error(`FOUNDATION GATE RED:\n- ${problems.join("\n- ")}`);
          }
          return { launchRootOk, scriptsOk, queueOk, selfAuditOk, detail: `ok @ ${c.milestone}` };
        }}
      </Task>

      <Task id="budget" output={outputs.frcBudget}>
        {() => {
          // Graduation: warn at 80%, human gate at 90%, stop admitting at 100%
          // or at the pre-M8 stop line. Spend itself is operator-attested; what
          // is mechanical is the consequence.
          const cap = MODEL_CAP_CENTS;
          const level = Math.floor((c.spentCents / cap) * 10000);
          const admitNewWork = level < 10000 && (level < 9000 || expansionApproved) && c.spentCents < PRE_M8_STOP_CENTS;
          const note =
            level >= 10000
              ? "HARD CAP: no new work admitted"
              : level >= 9000
                ? expansionApproved
                  ? "≥90%: expansion approved"
                  : "≥90%: awaiting budget-expansion gate"
                : level >= 8000
                  ? "≥80%: warn"
                  : "within envelope";
          return {
            spentCents: c.spentCents,
            capCents: cap,
            levelPctX100: level,
            admitNewWork,
            note,
          };
        }}
      </Task>

      {budgetTerminal ? (
        <Closeout
          ctx={ctx}
          c={c}
          reason={`Budget stop: ${budget.note} (attested $${(budget.spentCents / 100).toFixed(0)} against a $${(MODEL_CAP_CENTS / 100).toFixed(0)} cap, level ${(budget.levelPctX100 / 100).toFixed(1)}%). No further work is admitted; the campaign closes out rather than stalling silently.`}
        />
      ) : needExpansion ? (
        <CampaignGate
          id="gate-budget-expand"
          summary={`Model spend is at ${(budget.levelPctX100 / 100).toFixed(1)}% of the $${(MODEL_CAP_CENTS / 100 / 1000).toFixed(0)}k cap ($${(budget.spentCents / 100).toFixed(0)} attested). Approve to keep working toward the cap; deny to stop and rescope. Cut order: App Router/edge promotion, then extra beta seats, then the M9 long tail, then native platform breadth. Never cut: the oracle, the backend assertion, byte-identical errors, security response, the release train, rollback, or the owned GA fixtures.`}
        />
      ) : null}
    </Sequence>
  );
}
