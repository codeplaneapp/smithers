export class PiAgent {
  readonly opts: Record<string, unknown>;

  constructor(opts: Record<string, unknown> = {}) {
    this.opts = opts;
  }
}
