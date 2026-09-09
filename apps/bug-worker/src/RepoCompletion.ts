import type { BugWorkerEnv } from "./env.ts";

type Ready = { appUrl: string; completedAt: string };
interface Transaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}
interface State {
  storage: { transaction<T>(callback: (txn: Transaction) => Promise<T>): Promise<T> };
}

/** One Durable Object per normalized repository; storage outlives worker instances. */
export class RepoCompletion {
  constructor(private readonly ctx: State, private readonly env: BugWorkerEnv) {}

  async fetch(request: Request): Promise<Response> {
    const { name, candidate } = await request.json() as { name: string; candidate: Ready };
    // Adopt publications made before this coordinator existed. KV is only a
    // migration source; once committed, the transaction's record always wins.
    const legacy = await this.env.BUGS.get(`repo-ready:${name}`);
    const ready = await this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get<Ready>("ready");
      if (existing) return existing;
      const winner = legacy === null ? candidate : JSON.parse(legacy) as Ready;
      await txn.put("ready", winner);
      return winner;
    });
    return Response.json(ready);
  }
}
