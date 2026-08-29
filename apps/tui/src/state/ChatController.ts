import type { StartAgentTurnResult } from "smithers-shared/NativeAgent"
import type { AgentTurnFrame } from "smithers-shared/NativeAgent"
import { builtinCommands } from "./BuiltinCommands"
import { CommandRegistry, parseSubmit } from "./CommandRegistry"
import { applyFrame, TranscriptStore } from "./Transcript"
import { buildTurnRequest } from "./TurnRequest"

/*
 * The chat controller: owns the turn lifecycle against the store. Components
 * call submit/cancel; frames arrive through the transport's publish callback
 * and fold into the store. The store is the only state; this class is wiring.
 */
export interface TuiTransport {
  readonly start: (request: import("smithers-shared/NativeAgent").StartAgentTurnRequest) =>
    | StartAgentTurnResult
    | Promise<StartAgentTurnResult>
  readonly cancel: (runId: string) => unknown
}

export class ChatController {
  private turnCounter = 0
  private activeRunId: string | null = null

  constructor(
    readonly store: TranscriptStore,
    private readonly transport: TuiTransport,
    readonly commands: CommandRegistry = new CommandRegistry(builtinCommands(store)),
    private readonly quit: () => void = () => process.exit(0)
  ) {}

  // TODO(shared): move to a shared package (derived from frame filtering in apps/ui/src/mainview/state/AppController.ts)
  readonly publish = (frame: AgentTurnFrame): void => {
    // A cancelled or superseded transport may still deliver a buffered frame.
    // Never let it mutate the settled transcript for another turn.
    if (frame.runId !== this.activeRunId) return
    applyFrame(this.store, frame)
    if (frame.type === "done") {
      this.activeRunId = null
      this.store.setPhase("idle")
    }
  }

  readonly isResponding = (): boolean => this.activeRunId !== null

  /**
   * Composer submit: a "/name args" draft dispatches through the command
   * registry and never reaches the agent; anything else is a prompt and
   * follows the turn-building path below, unchanged.
   */
  readonly submit = async (draft: string): Promise<void> => {
    if (this.activeRunId !== null) return
    const parsed = parseSubmit(draft, this.commands.all())
    if (parsed.kind === "empty") return
    if (parsed.kind === "command" || parsed.kind === "unknown-command") {
      this.store.clearDraft()
      if (parsed.kind === "unknown-command") {
        this.store.appendEvent(`Unknown command: /${parsed.name}`)
        return
      }
      const outcome = this.commands.run(parsed.name, parsed.args, { quit: this.quit })
      if (outcome.status === "failed") this.store.appendEvent(`/${parsed.name} failed: ${outcome.error}`)
      else if (outcome.status === "unknown-command") this.store.appendEvent(`Unknown command: /${parsed.name}`)
      else if (outcome.value !== undefined) this.store.appendEvent(outcome.value)
      return
    }
    this.turnCounter += 1
    const runId = `tui-${Date.now()}-${this.turnCounter}`
    const built = buildTurnRequest(runId, this.store.entries(), draft)
    if (built.status !== "ok") {
      if (built.status === "oversized") {
        this.store.appendEvent(
          `That message is too large for one turn (${built.bytes} bytes; the limit is 64 KiB on the boundary).`
        )
      }
      return
    }
    this.store.appendUserMessage(runId, draft.trim())
    this.store.clearDraft()
    this.activeRunId = runId
    this.store.setPhase("responding")
    const result = await this.transport.start(built.request)
    // Esc can cancel while the Worker POST is still connecting. In that
    // case cancelActive already settled the turn; the late start result is
    // stale and must not overwrite the interrupted state.
    if (this.activeRunId !== runId) return
    if (result.status === "error") {
      this.store.settleAssistant(runId, "failed", `That turn failed. ${result.message}`)
      this.activeRunId = null
      this.store.setPhase("idle")
    }
  }

  /** Esc: cancel the in-flight turn through the transport's cancel contract. */
  readonly cancelActive = (): void => {
    const runId = this.activeRunId
    if (runId === null) return
    void this.transport.cancel(runId)
    // The local abort means no terminal frame may ever arrive; settle
    // honestly now rather than leaving the turn visibly streaming.
    this.store.settleAssistant(runId, "interrupted", "Stopped the current response.")
    this.activeRunId = null
    this.store.setPhase("idle")
  }
}
