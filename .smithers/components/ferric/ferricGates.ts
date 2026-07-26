/**
 * Every human decision in the campaign, as data.
 *
 * Concentrating the gates here (and rendering them through the single
 * `CampaignGate` component) is what makes "no gate auto-approves" a property the
 * workflow can *check* at runtime rather than a promise in a comment.
 */
export const GATE_REGISTRY = {
  "gate-m0-exit": { title: "M0 exit / boundary-POC — proceed to M1?", onDeny: "continue" },
  "gate-m0-blocked": { title: "M0 BLOCKED — oracle/docs/POC red after fix loops. Kill or direct a fix?", onDeny: "continue" },
  "gate-m1-exit": { title: "M1 exit — trial machine proven on react-is + shared; flag codegen proven", onDeny: "continue" },
  "gate-m2-exit": { title: "M2 exit — scheduler 100%; whole suite green on Rust mock through the JS seam (D2)", onDeny: "continue" },
  "gate-m25-exit": { title: "M2.5 exit — one component rendered element-to-DOM through Rust", onDeny: "continue" },
  "gate-spend-m3": { title: "Budget gate at M3", onDeny: "continue" },
  "gate-m3-kill": { title: "KILL GATE #1 — boundary economics (≤1.5x within ≤2 protocol revisions)", onDeny: "continue" },
  "gate-spend-m4": { title: "Budget gate at 50% of M4", onDeny: "continue" },
  "gate-wk6": { title: "M4 week-6 go/no-go — ≥832/1,039 noop-oracle cases green?", onDeny: "continue" },
  "gate-ratchet-halt": { title: "Ratchet regression — landing queue halted. Clear after investigation?", onDeny: "fail" },
  "gate-budget-expand": { title: "Budget ≥90% of cap — expand envelope or stop and rescope?", onDeny: "continue" },
  "gate-m5m6-exit": { title: "M5/M6 exit — DOM within 10% on updates; SSR ≥0.95x floor; toggle demo ships", onDeny: "continue" },
  "gate-m7-exit": { title: "M7 exit — Flight webpack suite green + 10⁶ round-trip fuzz clean", onDeny: "continue" },
  "gate-rc": { title: "RC gate — four --build runs green; bench contract satisfied; leaks flat", onDeny: "continue" },
  "gate-ga": { title: "GA exit — 5 soaks green; 20 apps / 200 app-days / 99.95% crash-free; zero P0-P1", onDeny: "continue" },
  "gate-m9-freeze": { title: "M9 API freeze + budget envelope ($40k P50 / $62k cap)", onDeny: "continue" },
  "gate-publish-rc": { title: "Publish @ferric RC (npm, rc dist-tag)?", onDeny: "skip" },
  "gate-publish-ga": { title: "Publish @ferric GA (npm latest) + campaign post?", onDeny: "skip" },
  "gate-publish-m9": { title: "Publish ferric-react* (cargo) + M9 release?", onDeny: "skip" },
  "gate-publish-closeout": { title: "Publish the signed campaign closeout?", onDeny: "skip" },
} satisfies Record<string, { title: string; onDeny: "fail" | "continue" | "skip" }>;

/**
 * A literal union of the registry's keys, NOT `string`.
 *
 * Annotating GATE_REGISTRY as `Record<string, …>` widened `keyof` to `string`,
 * so a typo at any CampaignGate call site typechecked and left `onDeny`
 * undefined at runtime — exactly the drift the registry exists to prevent, and
 * invisible to the compiler once the campaign was split across files. `satisfies`
 * keeps the shape check without erasing the keys.
 */
export type FerricGateId = keyof typeof GATE_REGISTRY;

export const APPROVAL_SLA =
  "Decision windows 09:00/14:00/20:00 ET (report-sol §1.8); evidence in this request; " +
  "backup paged at 60min; 95% of decisions <2h. Humans may deny, tighten, or de-scope — " +
  "no human decision converts a deterministic red to green.";
