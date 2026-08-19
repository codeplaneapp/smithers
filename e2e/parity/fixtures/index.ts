import type { ParityFixture } from "../ParityFixture.ts";
import { branchSelectionFixture } from "./branchSelection.ts";
import { crashResumeFixture } from "./crashResume.ts";
import { linearSequenceFixture } from "./linearSequence.ts";
import { loopIterationsFixture } from "./loopIterations.ts";
import { parallelFanoutFixture } from "./parallelFanout.ts";
import { retryThenSucceedFixture } from "./retryThenSucceed.ts";
import { terminalFailureFixture } from "./terminalFailure.ts";
import { waitingEventFixture } from "./waitingEvent.ts";
import { waitingTimerFixture } from "./waitingTimer.ts";
import {
  restartWaitingApprovalFixture,
  waitingApprovalDeniedFixture,
  waitingApprovalGrantedFixture,
} from "./waitingApproval.ts";

/**
 * Every parity fixture, in the order the suite runs them.
 *
 * Adding a fixture means adding it here and recording its oracle with
 * `bun e2e/parity/recordOracles.ts`. The suite fails on a fixture with no
 * committed oracle, so a fixture cannot land without one.
 */
export const PARITY_FIXTURES: readonly ParityFixture[] = [
  linearSequenceFixture,
  parallelFanoutFixture,
  retryThenSucceedFixture,
  terminalFailureFixture,
  waitingApprovalGrantedFixture,
  waitingApprovalDeniedFixture,
  waitingEventFixture,
  waitingTimerFixture,
  branchSelectionFixture,
  loopIterationsFixture,
  crashResumeFixture,
  restartWaitingApprovalFixture,
];

export function getParityFixture(id: string): ParityFixture {
  const fixture = PARITY_FIXTURES.find((candidate) => candidate.id === id);
  if (!fixture) throw new Error(`parity: no fixture registered for ${id}`);
  return fixture;
}
