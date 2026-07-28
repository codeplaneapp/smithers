export const dddFeature = {
  id: "docs-fixture",
  title: "Docs fixture",
  summary: "A deterministic fixture feature.",
  status: "broken",
  priority: "p0",
  owner: "fixture",
  tier: "feature",
  group: "Create",
  userValue: "A deterministic fixture.",
  capabilities: [],
  endpoints: [],
  links: [],
  tests: [],
  observability: [],
  debug: [],
  architecture: [],
  changes: [],
  diffHints: [],
  missing: ["implementation"],
} as const;

export const dddAuditBroken = {
  generatedSiteBuilds: true,
  featureIds: ["docs-fixture"],
  broken: ["docs-fixture"],
  partial: [],
  missingE2E: [],
  missingDocs: [],
  notes: ["the feature is broken"],
} as const;

export const dddAuditClean = {
  generatedSiteBuilds: true,
  featureIds: ["docs-fixture"],
  broken: [],
  partial: [],
  missingE2E: [],
  missingDocs: [],
  notes: ["clean"],
} as const;

export const evalSuite = {
  suiteId: "curated-suite",
  name: "Curated suite",
  workflowKey: "fixture",
  workflowPath: ".smithers/workflows/fixture.tsx",
  workflowRoot: ".",
  cases: [
    { id: "pass", name: "pass", input: { value: 1 }, expected: { output: { ok: true } } },
    { id: "fail", name: "fail", input: { value: 2 }, expected: { output: { ok: false } } },
  ],
} as const;

export const caseRows = {
  pass: {
    caseId: "pass",
    status: "ok",
    assertions: [{ description: "output", passed: true }],
    passed: true,
    inconclusive: false,
    error: null,
  },
  fail: {
    caseId: "fail",
    status: "failed",
    assertions: [{ description: "output", passed: false }],
    passed: false,
    inconclusive: false,
    error: "mismatch",
  },
  passedFail: {
    caseId: "fail",
    status: "ok",
    assertions: [{ description: "output", passed: true }],
    passed: true,
    inconclusive: false,
    error: null,
  },
  failedPass: {
    caseId: "pass",
    status: "failed",
    assertions: [{ description: "output", passed: false }],
    passed: false,
    inconclusive: false,
    error: "mismatch",
  },
  // A harness/environment death: not passed, but not evidence about the
  // workflow either, so the verdict must name it rather than count it as red.
  inconclusiveFail: {
    caseId: "fail",
    status: "failed",
    assertions: [],
    passed: false,
    inconclusive: true,
    error: "connect ECONNREFUSED",
  },
} as const;
