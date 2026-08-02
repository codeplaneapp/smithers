/** @jsxImportSource smthrs */
// Orchestration-behavior fluency: does a weak model, grounded in our docs/skill,
// exhibit the long-lived-orchestrator disciplines? — protect its own context by
// fanning big reads out to disposable sub-agents (the "lifeline" rule), fan out
// candidate JUDGING to a fresh verifier instead of adjudicating in its own
// context, and periodically RE-READ its own instructions to catch drift.
//
// These start RED against the current docs (the lifeline pattern and the
// anti-drift re-read doctrine are unnamed / absent) and are the before/after gate
// for the doctrine we add to docs/guides/context-engineering.mdx + SKILL.md.
import { createFluencyEval } from "../../lib/eval-kit";

export default createFluencyEval({ suite: "orchestration-behavior" });
