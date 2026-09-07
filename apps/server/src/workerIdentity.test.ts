import { describe, expect, test } from "bun:test"
import { FRAME_PATH_PREFIX } from "./appDocument"
import { ROUTED_OWNER_PREFIXES } from "./index"
import { readWranglerConfig, workerFirstPrefix } from "./wranglerConfig"

const config = readWranglerConfig()

/*
 * DEPLOY.md "Frozen identity": the Worker's name and its Durable Object
 * bindings are what its state is keyed to. A rename, a dropped binding, or a
 * rewritten migration tag deploys a fresh Worker with empty storage and
 * orphans the old one, so every one of those is pinned here and a change to
 * any of them is a deliberate decision recorded in DEPLOY.md, never a diff
 * that slips through with a deploy.
 */
describe("the Worker identity stays frozen", () => {
  test("the name and the entry module", () => {
    expect(config.name).toBe("smithers-mvp-web")
    expect(config.main).toBe("src/index.ts")
  })

  test("the canary custom domain stays attached", () => {
    expect(config.routes[0]).toEqual({ pattern: "canary.smithers.sh", custom_domain: true })
  })

  test("one zone route claims every apex path, so the app page and its /_astro chunks come from one build", () => {
    expect(config.routes.slice(1)).toEqual([{ pattern: "smithers.sh/*", zone_id: "8ebd98d2f0dc7d8db2e61f31ebc19c14" }])
  })

  test("the five Durable Object bindings and their classes", () => {
    expect(config.durable_objects.bindings).toEqual([
      { name: "TURN_CANCELS", class_name: "TurnCancelRegistry" },
      { name: "GATEWAY_SESSIONS", class_name: "GatewaySessionRegistry" },
      { name: "TURN_LIMITS", class_name: "TurnRateLimiter" },
      { name: "CLIENT_ERRORS", class_name: "ClientErrorLog" },
      { name: "RECOMMEND_LOG", class_name: "RecommendLog" }
    ])
  })

  test("the migration tags introduce exactly those classes, in order", () => {
    expect(config.migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["TurnCancelRegistry"] },
      { tag: "v2", new_sqlite_classes: ["GatewaySessionRegistry"] },
      { tag: "v3", new_sqlite_classes: ["TurnRateLimiter", "ClientErrorLog"] },
      { tag: "v4", new_sqlite_classes: ["RecommendLog"] }
    ])
    const migrated = config.migrations.flatMap((migration) => migration.new_sqlite_classes)
    expect(new Set(migrated)).toEqual(new Set(config.durable_objects.bindings.map((binding) => binding.class_name)))
  })

  test("the assets are the site build, served with its 404 page (the second deliberate identity change)", () => {
    expect(config.assets.directory).toBe("../site/dist")
    expect(config.assets.binding).toBe("ASSETS")
    expect(config.assets.not_found_handling).toBe("404-page")
  })
})

/*
 * `run_worker_first` is what lets src/index.ts see a path before the assets
 * layer answers it. A prefix the code routes but wrangler does not list is
 * dead code on Cloudflare: the assets layer serves a 404 page for the frame
 * path and the raw prerendered page, without isolation headers, for the
 * repository path.
 */
describe("run_worker_first covers every prefix the Worker routes", () => {
  const prefixes = config.assets.run_worker_first.map(workerFirstPrefix)

  test("every routed owner", () => {
    for (const owner of ROUTED_OWNER_PREFIXES) expect(prefixes).toContain(owner)
  })

  test("the frame path prefix", () => {
    expect(prefixes).toContain(FRAME_PATH_PREFIX)
  })

  test("the API prefix, so a redirect rule in the site build can never answer an API path", () => {
    expect(prefixes).toContain("/api/")
  })

  test("every entry is a prefix wildcard", () => {
    for (const entry of config.assets.run_worker_first) expect(entry).toMatch(/^\/[a-z0-9]+\/\*$/)
  })
})
