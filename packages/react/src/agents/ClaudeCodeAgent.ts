export class ClaudeCodeAgent {
  readonly opts: Record<string, unknown>;

  constructor(opts: Record<string, unknown> = {}) {
    this.opts = opts;
  }
}
