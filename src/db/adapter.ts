import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import {
  smithersRuns,
  smithersNodes,
  smithersAttempts,
  smithersFrames,
  smithersApprovals,
  smithersCache,
  smithersToolCalls,
  smithersEvents,
  smithersRalph,
} from "./internal-schema";

export class SmithersDb {
  constructor(private db: BunSQLiteDatabase<any>) {}

  async insertRun(row: any) {
    await this.db.insert(smithersRuns).values(row).onConflictDoNothing();
  }

  async updateRun(runId: string, patch: any) {
    await this.db.update(smithersRuns).set(patch).where(eq(smithersRuns.runId, runId));
  }

  async getRun(runId: string) {
    const rows = await this.db.select().from(smithersRuns).where(eq(smithersRuns.runId, runId)).limit(1);
    return rows[0];
  }

  async listRuns(limit = 50, status?: string) {
    const where = status ? eq(smithersRuns.status, status) : undefined;
    const query = this.db
      .select()
      .from(smithersRuns)
      .orderBy(desc(smithersRuns.createdAtMs))
      .limit(limit);
    if (where) {
      return query.where(where);
    }
    return query;
  }

  async insertNode(row: any) {
    await this.db.insert(smithersNodes).values(row).onConflictDoUpdate({
      target: [smithersNodes.runId, smithersNodes.nodeId, smithersNodes.iteration],
      set: row,
    });
  }

  async getNode(runId: string, nodeId: string, iteration: number) {
    const rows = await this.db
      .select()
      .from(smithersNodes)
      .where(
        and(
          eq(smithersNodes.runId, runId),
          eq(smithersNodes.nodeId, nodeId),
          eq(smithersNodes.iteration, iteration),
        ),
      )
      .limit(1);
    return rows[0];
  }

  async listNodes(runId: string) {
    return this.db.select().from(smithersNodes).where(eq(smithersNodes.runId, runId));
  }

  async insertAttempt(row: any) {
    await this.db.insert(smithersAttempts).values(row);
  }

  async updateAttempt(runId: string, nodeId: string, iteration: number, attempt: number, patch: any) {
    await this.db
      .update(smithersAttempts)
      .set(patch)
      .where(
        and(
          eq(smithersAttempts.runId, runId),
          eq(smithersAttempts.nodeId, nodeId),
          eq(smithersAttempts.iteration, iteration),
          eq(smithersAttempts.attempt, attempt),
        ),
      );
  }

  async listAttempts(runId: string, nodeId: string, iteration: number) {
    return this.db
      .select()
      .from(smithersAttempts)
      .where(
        and(
          eq(smithersAttempts.runId, runId),
          eq(smithersAttempts.nodeId, nodeId),
          eq(smithersAttempts.iteration, iteration),
        ),
      )
      .orderBy(desc(smithersAttempts.attempt));
  }

  async listInProgressAttempts(runId: string) {
    return this.db
      .select()
      .from(smithersAttempts)
      .where(and(eq(smithersAttempts.runId, runId), eq(smithersAttempts.state, "in-progress")));
  }

  async insertFrame(row: any) {
    await this.db.insert(smithersFrames).values(row);
  }

  async getLastFrame(runId: string) {
    const rows = await this.db
      .select()
      .from(smithersFrames)
      .where(eq(smithersFrames.runId, runId))
      .orderBy(desc(smithersFrames.frameNo))
      .limit(1);
    return rows[0];
  }

  async insertOrUpdateApproval(row: any) {
    await this.db.insert(smithersApprovals).values(row).onConflictDoUpdate({
      target: [smithersApprovals.runId, smithersApprovals.nodeId, smithersApprovals.iteration],
      set: row,
    });
  }

  async getApproval(runId: string, nodeId: string, iteration: number) {
    const rows = await this.db
      .select()
      .from(smithersApprovals)
      .where(
        and(
          eq(smithersApprovals.runId, runId),
          eq(smithersApprovals.nodeId, nodeId),
          eq(smithersApprovals.iteration, iteration),
        ),
      )
      .limit(1);
    return rows[0];
  }

  async insertToolCall(row: any) {
    await this.db.insert(smithersToolCalls).values(row);
  }

  async insertEvent(row: any) {
    await this.db.insert(smithersEvents).values(row);
  }

  async getLastEventSeq(runId: string) {
    const rows = await this.db
      .select()
      .from(smithersEvents)
      .where(eq(smithersEvents.runId, runId))
      .orderBy(desc(smithersEvents.seq))
      .limit(1);
    return rows[0]?.seq as number | undefined;
  }

  async listEvents(runId: string, afterSeq: number, limit = 200) {
    return this.db
      .select()
      .from(smithersEvents)
      .where(and(eq(smithersEvents.runId, runId), sql`${smithersEvents.seq} > ${afterSeq}`))
      .orderBy(smithersEvents.seq)
      .limit(limit);
  }

  async insertOrUpdateRalph(row: any) {
    await this.db.insert(smithersRalph).values(row).onConflictDoUpdate({
      target: [smithersRalph.runId, smithersRalph.ralphId],
      set: row,
    });
  }

  async listRalph(runId: string) {
    return this.db.select().from(smithersRalph).where(eq(smithersRalph.runId, runId));
  }

  async getRalph(runId: string, ralphId: string) {
    const rows = await this.db
      .select()
      .from(smithersRalph)
      .where(and(eq(smithersRalph.runId, runId), eq(smithersRalph.ralphId, ralphId)))
      .limit(1);
    return rows[0];
  }

  async insertCache(row: any) {
    await this.db.insert(smithersCache).values(row).onConflictDoNothing();
  }

  async getCache(cacheKey: string) {
    const rows = await this.db.select().from(smithersCache).where(eq(smithersCache.cacheKey, cacheKey)).limit(1);
    return rows[0];
  }

  async deleteFramesAfter(runId: string, frameNo: number) {
    await this.db
      .delete(smithersFrames)
      .where(and(eq(smithersFrames.runId, runId), sql`${smithersFrames.frameNo} > ${frameNo}`));
  }

  async listFrames(runId: string, limit: number, afterFrameNo?: number) {
    const where = afterFrameNo !== undefined
      ? and(eq(smithersFrames.runId, runId), sql`${smithersFrames.frameNo} > ${afterFrameNo}`)
      : eq(smithersFrames.runId, runId);
    return this.db
      .select()
      .from(smithersFrames)
      .where(where)
      .orderBy(desc(smithersFrames.frameNo))
      .limit(limit);
  }

  async countNodesByState(runId: string) {
    const rows = await this.db
      .select({ state: smithersNodes.state, count: sql<number>`count(*)` })
      .from(smithersNodes)
      .where(eq(smithersNodes.runId, runId))
      .groupBy(smithersNodes.state);
    return rows;
  }
}
