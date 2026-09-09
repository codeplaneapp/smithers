import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

/**
 * The page's behavior lives in one inline script, so `worker.test.ts` can only
 * assert on its source text. These tests run it: they load `index.html` into a
 * small in-memory DOM, inject `fetch` and a fixed UTC clock, and assert on what
 * the script actually renders. Dropping `.catch(renderError)` or calling a
 * missing day operational fails here rather than shipping.
 */
const homeHtml = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const script = /<script>([\s\S]*?)<\/script>/.exec(homeHtml)?.[1] ?? "";

/** Every id the markup defines. An id the script asks for and the page lacks reads as null. */
const PAGE_IDS = [...homeHtml.matchAll(/\sid="([^"]+)"/g)].map(([, id]) => id as string);

class El {
  readonly tag: string;
  readonly children: El[] = [];
  readonly style: Record<string, string> = {};
  className = "";
  title = "";
  href = "";
  disabled = false;
  removed = false;
  parent: El | null = null;
  #text = "";
  #listeners = new Map<string, Array<() => void>>();

  constructor(tag: string) {
    this.tag = tag;
  }

  set textContent(value: string) {
    this.#text = String(value);
    this.children.length = 0;
  }

  get textContent(): string {
    if (this.children.length === 0) return this.#text;
    return this.children.map((child) => child.textContent).join("");
  }

  appendChild(node: El): El {
    node.parent = this;
    this.children.push(node);
    return node;
  }

  addEventListener(type: string, handler: () => void): void {
    const handlers = this.#listeners.get(type) ?? [];
    handlers.push(handler);
    this.#listeners.set(type, handlers);
  }

  remove(): void {
    this.removed = true;
    const siblings = this.parent?.children;
    if (siblings) {
      const index = siblings.indexOf(this);
      if (index >= 0) siblings.splice(index, 1);
    }
    this.parent = null;
  }

  click(): void {
    for (const handler of this.#listeners.get("click") ?? []) handler();
  }
}

class Doc {
  readonly nodes = new Map<string, El>();

  constructor(ids: readonly string[]) {
    for (const id of ids) this.nodes.set(id, new El("div"));
  }

  getElementById(id: string): El | null {
    const node = this.nodes.get(id);
    return node && !node.removed ? node : null;
  }

  createElement(tag: string): El {
    return new El(tag);
  }

  createTextNode(text: string): El {
    const node = new El("#text");
    node.textContent = text;
    return node;
  }
}

/** `new Date()` reads the given instant; every other Date behavior is the real one. */
function clock(nowIso: string): DateConstructor {
  const now = Date.parse(nowIso);
  const Clock = function (...args: unknown[]): Date {
    return args.length === 0 ? new Date(now) : (Reflect.construct(Date, args) as Date);
  };
  Object.assign(Clock, { parse: Date.parse, UTC: Date.UTC, now: () => now });
  return Clock as unknown as DateConstructor;
}

interface FeedResponse {
  readonly ok: boolean;
  readonly status?: number;
  readonly json: () => Promise<unknown>;
}

/** Runs the page script against one feed response and returns the rendered document. */
async function loadPage(now: string, respond: () => Promise<FeedResponse>): Promise<Doc> {
  const document = new Doc(PAGE_IDS);
  runInNewContext(script, { document, fetch: respond, Date: clock(now) });
  // The render runs in the fetch continuation, one macrotask is enough to settle it.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return document;
}

const NOW = "2026-09-09T12:00:00Z";

function loadFeed(data: unknown, now: string = NOW): Promise<Doc> {
  return loadPage(now, async () => ({ ok: true, json: async () => data }));
}

function node(document: Doc, id: string): El {
  const found = document.getElementById(id);
  if (!found) throw new Error(`the page has no #${id}`);
  return found;
}

/** The calendar cell for a day of the displayed month, skipping the leading blanks. */
function cell(document: Doc, day: number): El {
  const found = node(document, "cal-grid").children.find(
    (child) => !child.className.includes("blank") && child.textContent === String(day),
  );
  if (!found) throw new Error(`the calendar has no cell for day ${day}`);
  return found;
}

function incidentCards(document: Doc): El[] {
  const host = node(document, "incidents");
  const list = host.children.find((child) => child.className === "incidents");
  return list ? list.children : [];
}

function updateBodies(card: El): string[] {
  const updates = card.children.find((child) => child.className === "updates");
  return (updates?.children ?? []).map((li) => li.children[1]?.textContent ?? "");
}

const FEED = {
  updatedAt: "2026-09-09T11:30:00Z",
  monitoringSince: "2026-08-07",
  overall: "operational",
  overallNote: "Alpha, best effort.",
  components: [
    { id: "site", name: "smithers.sh", url: "https://smithers.sh", description: "Marketing site", status: "operational" },
    { id: "api", name: "API", description: "Control plane", status: "degraded" },
    { id: "runs", name: "Runs", status: "outage" },
    { id: "cloud", name: "Cloud", status: "maintenance" },
    { id: "future", name: "Future", status: "sunny" },
  ],
  history: {
    "2026-09-01": { status: "operational" },
    "2026-09-02": { status: "degraded", note: "Slow reads" },
    "2026-09-03": { status: "outage" },
    "2026-09-04": { status: "maintenance" },
    "2026-09-05": { status: "sunny" },
  },
  incidents: [] as unknown[],
};

describe("status page banner", () => {
  test("names every state it knows and falls back to unknown", async () => {
    const banners: Record<string, string> = {
      operational: "All systems operational",
      degraded: "Degraded performance",
      outage: "Outage",
      maintenance: "Under maintenance",
    };
    for (const [state, text] of Object.entries(banners)) {
      const document = await loadFeed({ ...FEED, overall: state });
      expect(node(document, "banner").className).toBe(`banner ${state}`);
      expect(node(document, "banner-text").textContent).toBe(text);
    }
    const unknown = await loadFeed({ ...FEED, overall: "sunny" });
    expect(node(unknown, "banner").className).toBe("banner unknown");
    expect(node(unknown, "banner-text").textContent).toBe("Status unknown");
  });

  test("stamps the feed time in UTC and drops the note when the feed has none", async () => {
    const stamped = await loadFeed(FEED);
    expect(node(stamped, "stamp").textContent).toBe("Last updated 2026-09-09 11:30:00 UTC");
    expect(node(stamped, "note").textContent).toBe("Alpha, best effort.");

    const bare = await loadFeed({ ...FEED, overallNote: undefined });
    expect(bare.getElementById("note")).toBeNull();
  });
});

describe("status page components", () => {
  test("renders a row per component, linking only the ones with a url", async () => {
    const document = await loadFeed(FEED);
    const rows = node(document, "components").children;
    expect(rows.map((row) => row.children[0]?.textContent)).toEqual([
      "smithers.sh",
      "API",
      "Runs",
      "Cloud",
      "Future",
    ]);
    expect(rows[0]?.children[0]?.tag).toBe("a");
    expect(rows[0]?.children[0]?.href).toBe("https://smithers.sh");
    expect(rows[1]?.children[0]?.tag).toBe("span");
    const badge = (row: El): El => row.children[row.children.length - 1] as El;
    expect(rows.map((row) => badge(row).textContent)).toEqual([
      "Operational",
      "Degraded",
      "Outage",
      "Maintenance",
      "Unknown",
    ]);
    expect(rows.map((row) => badge(row).className)).toEqual([
      "state operational",
      "state degraded",
      "state outage",
      "state maintenance",
      "state ",
    ]);
  });

  test("keeps the static rows when the feed lists no components", async () => {
    const document = await loadFeed({ ...FEED, components: [] });
    expect(node(document, "components").children).toEqual([]);
  });
});

describe("status page calendar", () => {
  test("colors known days and calls every other day no data, never operational", async () => {
    const document = await loadFeed(FEED);
    expect(node(document, "cal-month").textContent).toBe("September 2026");
    expect(cell(document, 1).className).toBe("day operational");
    expect(cell(document, 2).className).toBe("day degraded");
    expect(cell(document, 2).title).toBe("2026-09-02 — Degraded: Slow reads");
    expect(cell(document, 3).className).toBe("day outage");
    expect(cell(document, 4).className).toBe("day maintenance");
    // An unknown status is not a healthy day.
    expect(cell(document, 5).className).toBe("day nodata");
    expect(cell(document, 6).className).toBe("day nodata");
    expect(cell(document, 6).title).toBe("2026-09-06 — no data");
  });

  test("marks today, the future, and the days before monitoring began", async () => {
    const document = await loadFeed(FEED);
    expect(cell(document, 9).className).toBe("day nodata today");
    expect(cell(document, 10).className).toBe("day future");
    expect(cell(document, 10).title).toBe("2026-09-10 — in the future");

    const august = await loadFeed(FEED, "2026-08-09T12:00:00Z");
    expect(node(august, "cal-month").textContent).toBe("August 2026");
    expect(cell(august, 6).title).toBe("2026-08-06 — no data (before monitoring began)");
    expect(cell(august, 7).title).toBe("2026-08-07 — no data");
  });

  test("walks back to the month monitoring began and no further", async () => {
    const document = await loadFeed(FEED);
    const prev = node(document, "cal-prev");
    const next = node(document, "cal-next");
    expect(prev.disabled).toBe(false);
    expect(next.disabled).toBe(true);

    prev.click();
    expect(node(document, "cal-month").textContent).toBe("August 2026");
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);

    prev.click();
    expect(node(document, "cal-month").textContent).toBe("August 2026");

    next.click();
    expect(node(document, "cal-month").textContent).toBe("September 2026");
  });

  test("rolls over the year when stepping back past January", async () => {
    const document = await loadFeed(
      { ...FEED, monitoringSince: "2025-11-02", history: {} },
      "2026-01-15T12:00:00Z",
    );
    const prev = node(document, "cal-prev");
    expect(node(document, "cal-month").textContent).toBe("January 2026");
    // 2026-01-01 is a Thursday, so a Monday-first grid needs three blanks.
    expect(node(document, "cal-grid").children.filter((day) => day.className === "day blank")).toHaveLength(3);

    prev.click();
    expect(node(document, "cal-month").textContent).toBe("December 2025");
    expect(cell(document, 31).className).toBe("day nodata");

    prev.click();
    expect(node(document, "cal-month").textContent).toBe("November 2025");
    expect(cell(document, 1).title).toBe("2025-11-01 — no data (before monitoring began)");
    expect(cell(document, 2).title).toBe("2025-11-02 — no data");
    expect(prev.disabled).toBe(true);
  });

  test("falls back to today when the feed does not say when monitoring began", async () => {
    const document = await loadFeed({ ...FEED, monitoringSince: undefined, history: {} });
    expect(node(document, "cal-prev").disabled).toBe(true);
    expect(cell(document, 8).title).toBe("2026-09-08 — no data (before monitoring began)");
  });
});

describe("status page incidents", () => {
  test("says so plainly when there are none", async () => {
    const document = await loadFeed(FEED);
    const host = node(document, "incidents");
    expect(host.children).toHaveLength(1);
    expect(host.children[0]?.className).toBe("empty");
    expect(host.children[0]?.textContent).toBe("No incidents reported.");
  });

  test("orders incidents and updates by instant, not by text", async () => {
    // Same second, different precision: only an instant comparison gets this right.
    const earlier = "2026-09-06T10:00:00Z";
    const later = "2026-09-06T10:00:00.500Z";
    const document = await loadFeed({
      ...FEED,
      incidents: [
        {
          title: "Earlier",
          startedAt: earlier,
          updates: [
            { status: "Investigating", at: earlier, body: "Earlier update" },
            { status: "Monitoring", at: later, body: "Later update" },
          ],
        },
        { title: "Later", startedAt: later, updates: [] },
      ],
    });
    const cards = incidentCards(document);
    expect(cards.map((card) => card.children[0]?.textContent)).toEqual(["Later", "Earlier"]);
    expect(updateBodies(cards[1] as El)).toEqual(["Later update", "Earlier update"]);
  });

  test("sorts incidents without a usable start last, in feed order", async () => {
    const document = await loadFeed({
      ...FEED,
      incidents: [
        { title: "Undated first" },
        { title: "Not a date", startedAt: "soon" },
        { title: "Dated", startedAt: "2026-09-06T10:00:00Z" },
      ],
    });
    expect(incidentCards(document).map((card) => card.children[0]?.textContent)).toEqual([
      "Dated",
      "Undated first",
      "Not a date",
    ]);
  });

  test("renders the meta line and the updates of an incident", async () => {
    const document = await loadFeed({
      ...FEED,
      incidents: [
        {
          title: "Runs stalled",
          startedAt: "2026-09-06T10:00:00Z",
          resolvedAt: "2026-09-06T11:30:00.250Z",
          status: "resolved",
          components: ["Runs", "API"],
          updates: [{ status: "Resolved", at: "2026-09-06T11:30:00.250Z", body: "Back to normal." }],
        },
      ],
    });
    const card = incidentCards(document)[0] as El;
    expect(card.children[0]?.textContent).toBe("Runs stalled");
    expect(card.children[1]?.textContent).toBe(
      "Started 2026-09-06 10:00:00 UTC  ·  Resolved 2026-09-06 11:30:00 UTC  ·  resolved  ·  Runs, API",
    );
    const head = card.children[2]?.children[0]?.children[0];
    expect(head?.textContent).toBe("Resolved · 2026-09-06 11:30:00 UTC");
    expect(updateBodies(card)).toEqual(["Back to normal."]);
  });
});

describe("status page failure", () => {
  const errorCases: Array<[string, () => Promise<FeedResponse>]> = [
    ["the request fails", async () => Promise.reject(new Error("offline"))],
    ["the feed answers 503", async () => ({ ok: false, status: 503, json: async () => ({}) })],
    [
      "the body is not JSON",
      async () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError("Unexpected token <");
        },
      }),
    ],
  ];

  for (const [name, respond] of errorCases) {
    test(`says the feed is unavailable when ${name}`, async () => {
      const document = await loadPage(NOW, respond);
      expect(node(document, "banner").className).toBe("banner unknown");
      expect(node(document, "banner-text").textContent).toBe("Status feed unavailable");
      expect(node(document, "note").textContent).toContain("It is not a statement that everything is fine.");
      const grid = node(document, "cal-grid");
      expect(grid.children).toHaveLength(1);
      expect(grid.children[0]?.textContent).toBe("No history to show: the feed did not load.");
      expect(node(document, "cal-prev").disabled).toBe(true);
      expect(node(document, "cal-next").disabled).toBe(true);
    });
  }
});
