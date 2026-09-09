import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { AppCard } from "../src/api.ts"
import { AppSession } from "../worker/AppSession.ts"
import type { Env } from "../worker/env.ts"

// Execute the production SQL on SQLite; only the workerd base class is stubbed.
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(protected ctx: DurableObjectState, protected env: Env) {}
  }
}))

const databases: Array<DatabaseSync> = []
const harness = () => {
  const db = new DatabaseSync(":memory:")
  databases.push(db)
  const ctx = {
    storage: {
      sql: {
        exec(query: string, ...bindings: Array<SQLInputValue>) {
          const rows = db.prepare(query).all(...bindings)
          return { toArray: () => rows }
        }
      },
      transactionSync<T>(body: () => T): T {
        db.exec("BEGIN")
        try {
          const result = body()
          db.exec("COMMIT")
          return result
        } catch (cause) {
          db.exec("ROLLBACK")
          throw cause
        }
      }
    }
  } as unknown as DurableObjectState
  return { db, open: () => new AppSession(ctx, {} as Env) }
}

const card: AppCard = { kind: "html", id: "z-card", html: "before" }

afterEach(() => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) db.close()
})

describe("durable transcript order", () => {
  test("same-tick messages reload in write order regardless of the timestamp index", () => {
    const { db, open } = harness()
    const session = open()
    // A valid query plan exposes the unspecified tie order of ORDER BY at.
    db.exec("CREATE INDEX messages_at_role ON messages(at, role, text, id)")
    vi.spyOn(Date, "now").mockReturnValue(10)
    const user = session.appendMessage("user", "question")
    const assistant = session.appendMessage("assistant", "answer")
    expect(open().state("s1").messages).toEqual([user, assistant])
  })

  test("same-tick cards reload in write order regardless of the timestamp index", () => {
    const { db, open } = harness()
    const session = open()
    db.exec("CREATE INDEX cards_at_id ON cards(at, id, json)")
    vi.spyOn(Date, "now").mockReturnValue(10)
    session.appendCard(card)
    const second = { ...card, id: "a-card" }
    session.appendCard(second)
    expect(open().state("s1").cards).toEqual([card, second])
  })

  test("card replacement preserves its timestamp and interleaved position after eviction", () => {
    const { db, open } = harness()
    const session = open()
    const now = vi.spyOn(Date, "now").mockReturnValue(10)
    const first = session.appendMessage("user", "question")
    session.appendCard(card)
    const last = session.appendMessage("assistant", "answer")
    now.mockReturnValue(20)
    session.appendCard({ ...card, html: "after" })
    expect(db.prepare("SELECT at FROM cards").get()).toEqual({ at: 10 })
    const state = open().state("s1")
    expect(state.entries).toEqual([
      { kind: "message", messageId: first.id },
      { kind: "card", cardId: card.id },
      { kind: "message", messageId: last.id }
    ])
    expect(state.cards).toEqual([{ ...card, html: "after" }])
  })

  test("migrates old rows once with deterministic timestamp ties and continues the sequence", () => {
    const { db, open } = harness()
    db.exec(`
      CREATE TABLE messages (id TEXT PRIMARY KEY, role TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE cards (id TEXT PRIMARY KEY, json TEXT NOT NULL, at INTEGER NOT NULL);
      INSERT INTO messages VALUES ('z', 'user', 'question', 1), ('a', 'assistant', 'answer', 1), ('last', 'assistant', 'later', 3);
    `)
    db.prepare("INSERT INTO cards VALUES (?, ?, ?)").run(card.id, JSON.stringify(card), 2)
    const session = open()
    const expected = [
      { kind: "message", messageId: "z" },
      { kind: "message", messageId: "a" },
      { kind: "card", cardId: card.id },
      { kind: "message", messageId: "last" }
    ]
    expect(session.state("s1").entries).toEqual(expected)
    // Wall clock rollback must not reorder new writes ahead of migrated ones.
    vi.spyOn(Date, "now").mockReturnValue(0)
    session.appendCard({ ...card, html: "updated" })
    const next = session.appendMessage("user", "next")
    expect(open().state("s1").entries).toEqual([...expected, { kind: "message", messageId: next.id }])
  })
})
