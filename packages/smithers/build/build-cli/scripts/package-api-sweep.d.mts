/**
 * Types for the W4 sweep harness, consumed by the build-cli vitest suite.
 */

export type SweepClass = "executes-green" | "typed-refusal" | "heavy" | "service"

export type RefusalCode =
  | "host-bin-absent"
  | "missing-secret"
  | "approval-required"
  | "needs-input"
  | "memory-unavailable"
  | "script-precondition"

export type ExpectedShape = "green" | "refusal" | "red" | "ready"

export interface Refusal {
  readonly code: RefusalCode
  readonly substring: string
}

export interface Alternate {
  readonly expect: ExpectedShape
  readonly refusal?: Refusal
  readonly notes?: string
}

export interface ExpectationRow {
  readonly class: SweepClass
  readonly expect?: ExpectedShape
  readonly refusal?: Refusal
  readonly mutates?: boolean
  readonly network?: boolean
  readonly alternates?: ReadonlyArray<Alternate>
  readonly notes?: string
}

export interface Expectations {
  readonly version: number
  readonly labels: Record<string, ExpectationRow>
}

export interface Observation {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut?: boolean
  readonly sawReadiness?: boolean
}

export interface Classified {
  readonly outcome: "green" | "ready" | "timeout" | "not-implemented" | "failed"
  readonly detectedCodes: ReadonlyArray<string>
}

export interface Judged {
  readonly verdict: "pass" | "alternate" | "mismatch"
  readonly alternateIndex?: number
  readonly reason?: string
}

export declare const defaults: {
  readonly expectations: string
  readonly cli: string
  readonly invoke: string
  readonly timeoutSeconds: number
  readonly report: string
}
export declare const classes: ReadonlyArray<SweepClass>
export declare const refusalCodes: ReadonlyArray<RefusalCode>
export declare const refusalRecognizers: Record<string, RegExp>
export declare const loadExpectations: (path: string) => Promise<Expectations>
export declare const validateExpectations: (parsed: unknown) => ReadonlyArray<string>
export declare const expectedOutcome: (row: ExpectationRow) => ExpectedShape
export declare const parseCliJson: (stdoutText: string) => any
export declare const compareLabelSets: (
  expected: ReadonlyArray<string>,
  actual: ReadonlyArray<string>
) => { readonly missing: ReadonlyArray<string>; readonly extra: ReadonlyArray<string>; readonly equal: boolean }
export declare const classifyOutcome: (observation: Observation) => Classified
export declare const verdictFor: (
  row: ExpectationRow,
  observed: Observation & { readonly classified: Classified }
) => Judged
export declare const selectRows: (
  expectations: Expectations,
  options?: {
    readonly heavy?: boolean
    readonly services?: boolean
    readonly only?: ReadonlyArray<string>
  }
) => ReadonlyArray<{ readonly label: string; readonly row: ExpectationRow }>
export declare const resetCommands: (
  workspace: string
) => ReadonlyArray<readonly [string, ReadonlyArray<string>]>
export declare const graphCheck: (options: {
  readonly workspace: string
  readonly cli: string
  readonly expectationsPath: string
}) => Promise<any>
export declare const runSweep: (options: {
  readonly workspace: string
  readonly cli: string
  readonly expectationsPath: string
  readonly invoke: string
  readonly heavy?: boolean
  readonly services?: boolean
  readonly only?: ReadonlyArray<string>
  readonly timeoutSeconds: number
  readonly reset?: boolean
}) => Promise<any>
export declare const summarize: (report: any) => string
