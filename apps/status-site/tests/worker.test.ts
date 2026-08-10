import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createStatusSiteWorker, type StatusSiteEnv } from "../src/worker.ts";

const homeHtml = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const statusRaw = readFileSync(new URL("../site/status.json", import.meta.url), "utf8");
const status = JSON.parse(statusRaw) as {
  updatedAt: string;
  monitoringSince: string;
  overall: string;
  components: Array<{ name: string; description?: string; status: string }>;
  history: Record<string, { status: string; note?: string }>;
  incidents: unknown[];
};

const BANNERS: Record<string, string> = {
  operational: "All systems operational",
  degraded: "Degraded performance",
  outage: "Outage",
  maintenance: "Under maintenance",
};
const LABELS: Record<string, string> = {
  operational: "Operational",
  degraded: "Degraded",
  outage: "Outage",
  maintenance: "Maintenance",
};

function makeEnv(): StatusSiteEnv {
  return {
    ASSETS: {
      async fetch(request: Request) {
        const url = new URL(request.url);
        if (url.pathname === "/" || url.pathname === "/index.html") {
          return new Response(homeHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
        }
        if (url.pathname === "/status.json") {
          return new Response(statusRaw, { headers: { "content-type": "application/json" } });
        }
        return new Response("not found", { status: 404 });
      },
    },
  };
}

describe("status feed", () => {
  test("only records history on or after monitoring began", () => {
    expect(status.monitoringSince).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const day of Object.keys(status.history)) {
      expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(day >= status.monitoringSince).toBe(true);
    }
  });

  test("uses only the states the page knows how to render", () => {
    const known = Object.keys(LABELS);
    expect(known).toContain(status.overall);
    for (const component of status.components) expect(known).toContain(component.status);
    for (const day of Object.values(status.history)) expect(known).toContain(day.status);
  });

  test("lists no component we have not shipped", () => {
    const names = status.components.map((component) => component.name);
    expect(names.join(" ")).not.toContain("docs");
    expect(JSON.stringify(status.components)).not.toContain("docs.smithers.sh");
  });
});

describe("status page copy", () => {
  test("renders the committed overall state as the static banner", () => {
    expect(homeHtml).toContain(BANNERS[status.overall] as string);
    expect(homeHtml).toContain(`<div class="banner ${status.overall}" id="banner"`);
  });

  test("static component rows agree with the feed", () => {
    const rows = [
      ...homeHtml.matchAll(
        /<span class="name">([^<]+)<\/span>\s*<span class="desc">([^<]*)<\/span>\s*<span class="state (\w+)"/g,
      ),
    ].map(([, name, desc, state]) => ({ name, desc, state }));
    expect(rows).toEqual(
      status.components.map((component) => ({
        name: component.name,
        desc: component.description ?? "",
        state: component.status,
      })),
    );
  });

  test("promises no SLA, uptime percentage, or round-the-clock support", () => {
    expect(homeHtml).toContain("Best-effort incident response during the alpha. No SLA is implied.");
    const text = homeHtml.toLowerCase();
    expect(text).not.toContain("99.9");
    expect(text).not.toContain("uptime guarantee");
    expect(text).not.toContain("guaranteed uptime");
    expect(text).not.toContain("24/7");
    expect(text).not.toMatch(/\d+(\.\d+)?\s*% uptime/);
  });

  test("offers no subscribe affordance, because none is wired up", () => {
    const text = homeHtml.toLowerCase();
    expect(text).not.toContain("subscribe");
    expect(text).not.toContain("notify me");
    expect(text).not.toContain("<form");
  });

  test("labels missing days as no data rather than as healthy", () => {
    expect(homeHtml).toContain("No data &mdash; not monitored that day");
    expect(homeHtml).toContain("no data (before monitoring began)");
  });

  test("says so plainly when it cannot load the feed", () => {
    expect(homeHtml).toContain("Status feed unavailable");
    expect(homeHtml).toContain("It is not a statement that everything is fine.");
  });

  test("gives the calendar prev/next month navigation and a legend", () => {
    expect(homeHtml).toContain('id="cal-prev"');
    expect(homeHtml).toContain('id="cal-next"');
    expect(homeHtml).toContain('class="legend"');
  });

  test("ships an inline script that at least parses", () => {
    // A syntax error here kills every rendered section silently, so guard it.
    const script = /<script>([\s\S]*?)<\/script>/.exec(homeHtml)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script as string)).not.toThrow();
  });

  test("shows an empty incident history honestly", () => {
    if (status.incidents.length === 0) expect(homeHtml).toContain("No incidents reported.");
  });
});

describe("status site worker", () => {
  test("serves the status page", async () => {
    const response = await createStatusSiteWorker().fetch(new Request("https://status.smithers.sh/"), makeEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await response.text()).toContain(BANNERS[status.overall] as string);
  });

  test("serves the status feed with a short TTL", async () => {
    const response = await createStatusSiteWorker().fetch(
      new Request("https://status.smithers.sh/status.json"),
      makeEnv(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60, must-revalidate");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(((await response.json()) as { overall: string }).overall).toBe(status.overall);
  });

  test("404s the feed instead of serving HTML when it is missing", async () => {
    const env: StatusSiteEnv = {
      ASSETS: {
        async fetch() {
          return new Response("not found", { status: 404 });
        },
      },
    };
    const response = await createStatusSiteWorker().fetch(new Request("https://status.smithers.sh/status.json"), env);
    expect(response.status).toBe(404);
  });

  test("404s the feed when the SPA fallback serves the page in its place", async () => {
    // This, not a 404, is what the real assets binding does for a missing file:
    // not_found_handling is single-page-application, so it returns index.html
    // with a 200. Serving that as the feed would be HTML pretending to be status.
    const env: StatusSiteEnv = {
      ASSETS: {
        async fetch() {
          return new Response(homeHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
        },
      },
    };
    const response = await createStatusSiteWorker().fetch(new Request("https://status.smithers.sh/status.json"), env);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("json");
  });

  test("falls back to the status page for unknown paths", async () => {
    const response = await createStatusSiteWorker().fetch(
      new Request("https://status.smithers.sh/incidents"),
      makeEnv(),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Incident history");
  });

  test("reports health without touching static assets", async () => {
    const response = await createStatusSiteWorker().fetch(new Request("https://status.smithers.sh/healthz"), makeEnv());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "status-site" });
  });

  test("rejects non-GET/HEAD methods with 405", async () => {
    const response = await createStatusSiteWorker().fetch(
      new Request("https://status.smithers.sh/", { method: "POST" }),
      makeEnv(),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(await response.text()).toBe("method not allowed");
  });

  test("serves static assets with an immutable cache header", async () => {
    const env: StatusSiteEnv = {
      ASSETS: {
        async fetch(request: Request) {
          if (new URL(request.url).pathname === "/assets/app.js") {
            return new Response("console.log('hi')", {
              headers: { "content-type": "text/javascript; charset=utf-8" },
            });
          }
          return new Response("not found", { status: 404 });
        },
      },
    };
    const response = await createStatusSiteWorker().fetch(new Request("https://status.smithers.sh/assets/app.js"), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
