import type { SmithersDb } from "@smthrs/db/adapter";

/**
 * A parity fixture: one workflow, one way of driving it, and the fault (if
 * any) injected while it runs. Fixtures are engine-agnostic by construction —
 * they build a `smithers()` workflow and nothing else — so the same fixture
 * feeds the legacy engine today and the flows engine from stage 1.3 on.
 */

/** Which process a fixture body is being built in. */
export type ParityFixtureMode = "initial" | "resume";

/**
 * How the suite executes a fixture.
 *
 * - `in-process`: run it in the test process and drive it from a second
 *   database connection, the way the product's control verbs do.
 * - `crash-resume`: run it in a real child process, SIGKILL that process at
 *   the fixture's declared marker, then resume the same run id in a fresh
 *   process. This is the durability contract ported from the `e2e/faults`
 *   kill/resume cases.
 */
export type ParityExecution = "in-process" | "crash-resume";

export type ParityFixtureBuildOptions = {
  /** On-disk sqlite file. Always a real file so a fresh process can reopen it. */
  readonly dbPath: string;
  readonly runId: string;
  readonly mode: ParityFixtureMode;
  /** Directory the fixture may write markers and ledgers into. */
  readonly scratchDir: string;
};

export type ParityFixtureBuild = {
  /** The workflow handed to the engine under test. */
  readonly workflow: unknown;
  /** Live drizzle handle from `createSmithers`, used to bootstrap tables. */
  readonly db: unknown;
  /** Run input. */
  readonly input: Record<string, unknown>;
  /** Release the database handle. */
  readonly close: () => void;
};

export type ParityDriveContext = {
  readonly runId: string;
  /**
   * A SECOND connection to the same on-disk database, standing in for an
   * operator or the gateway acting on a live run. Fixtures use it to approve,
   * signal, cancel, or observe — never to fabricate engine state.
   */
  readonly adapter: SmithersDb;
  readonly scratchDir: string;
};

export type ParityFixture = {
  readonly id: string;
  readonly title: string;
  /**
   * Ids from `e2e/fault-matrix.json` whose engine-observable behaviour this
   * fixture carries into the parity suite. `e2e/parity/fault-coverage.json`
   * is checked against this and against the matrix.
   */
  readonly portsFaultCases: readonly string[];
  readonly execution: ParityExecution;
  readonly build: (options: ParityFixtureBuildOptions) => ParityFixtureBuild;
  /**
   * Out-of-band interaction performed while the run is in flight: approving a
   * gate, delivering a signal, requesting a cancel.
   *
   * For an `in-process` fixture this runs concurrently with the engine and
   * must settle before the run does. For a `crash-resume` fixture it runs
   * between the SIGKILL and the resume, which is the real sequence when an
   * operator decides a gate on a run whose engine has died.
   */
  readonly drive?: (context: ParityDriveContext) => Promise<void>;
  /**
   * For `crash-resume` fixtures: the marker file, relative to the scratch
   * directory, whose appearance means the child is at the point where the
   * SIGKILL is interesting. Mutually exclusive with `killWhen`.
   */
  readonly killAfterMarker?: string;
  /**
   * For `crash-resume` fixtures whose interesting moment is a durable state
   * rather than a file: resolves when the child should be killed. Used by the
   * restart-while-waiting fixtures, where the moment to kill is the instant
   * the RUN parks.
   *
   * The contract is "durably parked", not "the node says it is waiting". The
   * engine parks a run in several writes, and a kill landing between them
   * leaves a half-written park that replays differently on resume — a
   * fixture that killed there would diff against its own oracle at random.
   * Resolve only once every write the park consists of is on disk.
   *
   * Because the engine releases the run at that same moment, the child may
   * exit on its own before the kill lands. The harness accepts that: the
   * durable state, and therefore the observation, is identical.
   */
  readonly killWhen?: (context: ParityDriveContext) => Promise<void>;
  /**
   * Output columns whose value is real but not reproducible — a decision
   * timestamp, for instance. Keyed by output table; each listed column is
   * replaced with a sentinel in the observation so the row's presence and its
   * other columns still gate, while the volatile value does not.
   */
  readonly redactOutputColumns?: Readonly<Record<string, readonly string[]>>;
  /**
   * Non-database evidence folded into the observation — the execution ledger
   * a crash/resume fixture keeps, for instance. Must be deterministic.
   */
  readonly sideEffects?: (scratchDir: string) => Record<string, unknown>;
  /** Wall-clock ceiling for one execution of this fixture. */
  readonly timeoutMs?: number;
};
