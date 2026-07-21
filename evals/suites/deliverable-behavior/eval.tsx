/** @jsxImportSource smithers-orchestrator */
// deliverable-behavior — does a weak model, grounded in our docs/skill, choose
// the right DELIVERABLE SHAPE without being told?
//
// Group A (judge verify): a bare user request — "put together a report",
// "write me a plan", "document the architecture" — should yield a polished,
// self-contained HTML page as the deliverable, not chat markdown.
//
// Group B (build verify): a workflow-UI situation that clearly calls for a
// shipped shared component (rich markdown editing, diff rendering, chat
// surfaces, run-status/KPI/empty states, gateway-ui widgets) should make the
// candidate reach for that component unprompted — never hand-rolling a
// <textarea> for markdown or re-deriving status badges.
//
// The before/after gate for the deliverable-shape doctrine in
// skills/smithers/SKILL.md; see NOTES.md for the results timeline.
import { createFluencyEval } from "../../lib/eval-kit";

export default createFluencyEval({ suite: "deliverable-behavior" });
