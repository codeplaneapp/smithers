import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    CHANGELOG_INDEX_URL,
    CHANGELOG_RAW_BASE_URL,
    SMITHERS_PACKAGE,
    SOTA_REGISTRY_URL,
    UPDATE_CHECK_INTERVAL_MS,
    buildUpdatePlan,
    compareVersions,
    detectInstallMethod,
    ensureUpdateCheck,
    extractChangelogVersions,
    fetchLatestVersion,
    fetchChangelogsSince,
    fetchRemoteSotaVersion,
    filterChangelogVersionsSince,
    formatUpdateNotice,
    globalUpdateCommand,
    isUpdateAvailable,
    parseVersion,
} from "../src/update-check.js";

/**
 * ensureUpdateCheck hits two endpoints per daily window: the npm registry (a
 * version string) and the SOTA model registry JSON (an integer version). This
 * fake serves both and counts a "check" as one npm hit.
 */
function fakeFetch({ npmVersion = "0.27.0", sotaVersion = null, counter = { npm: 0, sota: 0 } } = {}) {
    const fetchImpl = async (url) => {
        if (String(url) === SOTA_REGISTRY_URL) {
            counter.sota++;
            if (sotaVersion == null) return { ok: false };
            return { ok: true, json: async () => ({ version: sotaVersion }) };
        }
        counter.npm++;
        return { ok: true, json: async () => ({ version: npmVersion }) };
    };
    return { fetchImpl, counter };
}

describe("parseVersion", () => {
    test("parses release numbers and drops pre-release / build metadata", () => {
        expect(parseVersion("0.26.1")).toEqual([0, 26, 1]);
        expect(parseVersion("v0.26.1")).toEqual([0, 26, 1]);
        expect(parseVersion("1.2.0-beta.3")).toEqual([1, 2, 0]);
        expect(parseVersion("1.2.0+build.7")).toEqual([1, 2, 0]);
    });

    test("returns null for unparseable input", () => {
        expect(parseVersion("unknown")).toBeNull();
        expect(parseVersion("")).toBeNull();
        expect(parseVersion("1.x.0")).toBeNull();
        expect(parseVersion(undefined)).toBeNull();
    });
});

describe("compareVersions / isUpdateAvailable", () => {
    test("orders by release components", () => {
        expect(compareVersions("0.26.2", "0.26.1")).toBeGreaterThan(0);
        expect(compareVersions("0.26.1", "0.27.0")).toBeLessThan(0);
        expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
        expect(compareVersions("0.26.1", "0.26.1-rc.1")).toBe(0);
    });

    test("uncomparable versions never claim an update", () => {
        expect(compareVersions("unknown", "0.26.1")).toBe(0);
        expect(isUpdateAvailable("unknown", "0.26.1")).toBe(false);
    });

    test("isUpdateAvailable is true only for a strictly newer release", () => {
        expect(isUpdateAvailable("0.27.0", "0.26.1")).toBe(true);
        expect(isUpdateAvailable("0.26.1", "0.26.1")).toBe(false);
        expect(isUpdateAvailable("0.26.0", "0.26.1")).toBe(false);
    });
});

describe("detectInstallMethod", () => {
    const cases = [
        ["bunx cache", "/home/u/.bun/install/cache/smithers-orchestrator@0.26.1/src/bin/smithers.js", { kind: "bunx", manager: "bun" }],
        ["npx cache", "/home/u/.npm/_npx/abc123/node_modules/smithers-orchestrator/src/bin/smithers.js", { kind: "bunx", manager: "npm" }],
        ["global bun", "/home/u/.bun/bin/smithers", { kind: "global", manager: "bun" }],
        ["global pnpm", "/home/u/Library/pnpm/global/5/node_modules/smithers-orchestrator/src/bin/smithers.js", { kind: "global", manager: "pnpm" }],
        ["global yarn", "/home/u/.config/yarn/global/node_modules/smithers-orchestrator/src/bin/smithers.js", { kind: "global", manager: "yarn" }],
        ["global npm", "/usr/local/lib/node_modules/smithers-orchestrator/src/bin/smithers.js", { kind: "global", manager: "npm" }],
        ["nvm npm", "/home/u/.nvm/versions/node/v22.0.0/lib/node_modules/smithers-orchestrator/src/bin/smithers.js", { kind: "global", manager: "npm" }],
    ];
    for (const [name, path, expected] of cases) {
        test(`classifies ${name}`, () => {
            const got = detectInstallMethod({ execPath: path, runtimeIsBun: true });
            expect(got.kind).toBe(expected.kind);
            expect(got.manager).toBe(expected.manager);
        });
    }

    test("project-local node_modules is local", () => {
        const got = detectInstallMethod({ execPath: "/work/proj/node_modules/.bin/smithers", runtimeIsBun: true });
        expect(got.kind).toBe("local");
    });

    test("falls back on an unrecognised path", () => {
        const got = detectInstallMethod({ execPath: "/opt/custom/smithers", runtimeIsBun: false });
        expect(got.kind).toBe("unknown");
        expect(got.manager).toBe("npm");
    });
});

describe("globalUpdateCommand / buildUpdatePlan", () => {
    test("builds the right global command per manager", () => {
        expect(globalUpdateCommand("bun")).toBe(`bun add -g ${SMITHERS_PACKAGE}@latest`);
        expect(globalUpdateCommand("npm")).toBe(`npm install -g ${SMITHERS_PACKAGE}@latest`);
        expect(globalUpdateCommand("pnpm")).toBe(`pnpm add -g ${SMITHERS_PACKAGE}@latest`);
        expect(globalUpdateCommand("yarn")).toBe(`yarn global add ${SMITHERS_PACKAGE}@latest`);
    });

    test("a global install yields a runnable plan", () => {
        const plan = buildUpdatePlan({ kind: "global", manager: "bun", path: "" });
        expect(plan.runnable).toBe(true);
        expect(plan.command).toBe(`bun add -g ${SMITHERS_PACKAGE}@latest`);
    });

    test("a bunx run is not upgradeable in place", () => {
        const plan = buildUpdatePlan({ kind: "bunx", manager: "bun", path: "" });
        expect(plan.runnable).toBe(false);
        expect(plan.command).toBeNull();
        expect(plan.explanation).toContain("bunx");
    });

    test("a local install prints a project dependency bump but does not auto-run", () => {
        const plan = buildUpdatePlan({ kind: "local", manager: "bun", path: "" });
        expect(plan.runnable).toBe(false);
        expect(plan.command).toContain(`${SMITHERS_PACKAGE}@latest`);
    });
});

describe("formatUpdateNotice", () => {
    test("nudges toward `smithers update` for an upgradeable install", () => {
        const notice = formatUpdateNotice(
            { current: "0.26.1", latest: "0.27.0", updateAvailable: true },
            { kind: "global", manager: "bun", path: "" },
        );
        expect(notice).toContain("0.27.0");
        expect(notice).toContain("smithers update");
    });

    test("points bunx users at the next @latest run", () => {
        const notice = formatUpdateNotice(
            { current: "0.26.1", latest: "0.27.0", updateAvailable: true },
            { kind: "bunx", manager: "bun", path: "" },
        );
        expect(notice).toContain("bunx");
        expect(notice).not.toContain("smithers update");
    });

    test("returns null when no update is available", () => {
        expect(formatUpdateNotice({ current: "0.26.1", latest: "0.26.1", updateAvailable: false })).toBeNull();
        expect(formatUpdateNotice(null)).toBeNull();
    });

    test("mentions new SOTA models and `smithers init` when the registry moved with the release", () => {
        const notice = formatUpdateNotice(
            { current: "0.26.1", latest: "0.27.0", updateAvailable: true, sotaUpdateAvailable: true },
            { kind: "global", manager: "bun", path: "" },
        );
        expect(notice).toContain("SOTA models");
        expect(notice).toContain("smithers init");
    });

    test("a newer registry alone (no release yet) stays silent", () => {
        expect(
            formatUpdateNotice(
                { current: "0.27.0", latest: "0.27.0", updateAvailable: false, sotaUpdateAvailable: true },
                { kind: "global", manager: "bun", path: "" },
            ),
        ).toBeNull();
    });
});

describe("fetchLatestVersion", () => {
    test("reads the version from the registry payload", async () => {
        const fetchImpl = async () => ({ ok: true, json: async () => ({ version: "9.9.9" }) });
        expect(await fetchLatestVersion({ fetchImpl })).toBe("9.9.9");
    });

    test("returns null on a non-ok response or a throw", async () => {
        expect(await fetchLatestVersion({ fetchImpl: async () => ({ ok: false }) })).toBeNull();
        expect(await fetchLatestVersion({ fetchImpl: async () => { throw new Error("offline"); } })).toBeNull();
    });
});

describe("changelog helpers", () => {
    test("extracts changelog versions from docs sidebar data oldest-first", () => {
        const versions = extractChangelogVersions({
            navigation: [
                "quickstart",
                {
                    group: "Changelog",
                    pages: ["changelogs/0.27.0", "changelogs/0.26.1", "changelogs/0.26.0"],
                },
            ],
        });
        expect(versions).toEqual(["0.26.0", "0.26.1", "0.27.0"]);
    });

    test("filters changelogs newer than current and not newer than latest", () => {
        expect(
            filterChangelogVersionsSince(
                ["0.25.4", "0.26.0", "0.26.1", "0.27.0", "0.28.0"],
                "0.26.0",
                "0.27.0",
            ),
        ).toEqual(["0.26.1", "0.27.0"]);
    });

    test("fetchChangelogsSince reads docs index and fetches matching MDX pages", async () => {
        const seen = [];
        const fetchImpl = async (url) => {
            seen.push(String(url));
            if (String(url) === CHANGELOG_INDEX_URL) {
                return {
                    ok: true,
                    json: async () => ({
                        navigation: [{ pages: ["changelogs/0.26.0", "changelogs/0.26.1", "changelogs/0.27.0"] }],
                    }),
                };
            }
            return {
                ok: true,
                text: async () => `# ${String(url).split("/").pop()?.replace(".mdx", "")}`,
            };
        };

        const result = await fetchChangelogsSince({
            currentVersion: "0.26.0",
            latestVersion: "0.27.0",
            fetchImpl,
        });

        expect(result.versions).toEqual(["0.26.1", "0.27.0"]);
        expect(result.entries.map((entry) => entry.content)).toEqual(["# 0.26.1", "# 0.27.0"]);
        expect(seen).toEqual([
            CHANGELOG_INDEX_URL,
            `${CHANGELOG_RAW_BASE_URL}/0.26.1.mdx`,
            `${CHANGELOG_RAW_BASE_URL}/0.27.0.mdx`,
        ]);
    });
});

describe("ensureUpdateCheck", () => {
    function withHome(fn) {
        const home = mkdtempSync(join(tmpdir(), "smithers-update-check-"));
        try {
            return fn(home);
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    }

    test("fetches on a cold marker, reports an available update, and caches it", async () => {
        await withHome(async (home) => {
            const { fetchImpl, counter } = fakeFetch({ npmVersion: "0.27.0" });
            const res = await ensureUpdateCheck({ currentVersion: "0.26.1", homeDir: home, env: {}, now: 1000, fetchImpl, currentSotaVersion: 1 });
            expect(res).toEqual({
                current: "0.26.1",
                latest: "0.27.0",
                updateAvailable: true,
                checkedNow: true,
                sotaVersion: null,
                sotaUpdateAvailable: false,
            });
            expect(counter.npm).toBe(1);
            const marker = JSON.parse(readFileSync(join(home, ".smithers", "update-check.json"), "utf8"));
            expect(marker.latest).toBe("0.27.0");
            expect(marker.lastCheckMs).toBe(1000);
        });
    });

    test("reuses the cached version inside the throttle window without a network call", async () => {
        await withHome(async (home) => {
            const { fetchImpl, counter } = fakeFetch({ npmVersion: "0.27.0" });
            await ensureUpdateCheck({ currentVersion: "0.26.1", homeDir: home, env: {}, now: 1000, fetchImpl, currentSotaVersion: 1 });
            const res = await ensureUpdateCheck({ currentVersion: "0.26.1", homeDir: home, env: {}, now: 1000 + 60_000, fetchImpl, currentSotaVersion: 1 });
            expect(counter.npm).toBe(1);
            expect(counter.sota).toBe(1);
            expect(res.checkedNow).toBe(false);
            expect(res.updateAvailable).toBe(true);
        });
    });

    test("re-checks once the throttle window elapses", async () => {
        await withHome(async (home) => {
            const { fetchImpl, counter } = fakeFetch({ npmVersion: "0.27.0" });
            await ensureUpdateCheck({ currentVersion: "0.26.1", homeDir: home, env: {}, now: 1000, fetchImpl, currentSotaVersion: 1 });
            await ensureUpdateCheck({ currentVersion: "0.26.1", homeDir: home, env: {}, now: 1000 + UPDATE_CHECK_INTERVAL_MS, fetchImpl, currentSotaVersion: 1 });
            expect(counter.npm).toBe(2);
        });
    });

    test("is disabled by SMITHERS_NO_UPDATE_CHECK and skips an unknown version", async () => {
        await withHome(async (home) => {
            const fetchImpl = async () => { throw new Error("should not be called"); };
            expect(await ensureUpdateCheck({ currentVersion: "0.26.1", homeDir: home, env: { SMITHERS_NO_UPDATE_CHECK: "1" }, now: 1, fetchImpl })).toBeNull();
            expect(await ensureUpdateCheck({ currentVersion: "unknown", homeDir: home, env: {}, now: 1, fetchImpl })).toBeNull();
        });
    });

    test("reports a newer SOTA registry and caches it in the marker", async () => {
        await withHome(async (home) => {
            const { fetchImpl } = fakeFetch({ npmVersion: "0.27.0", sotaVersion: 3 });
            const res = await ensureUpdateCheck({ currentVersion: "0.26.1", homeDir: home, env: {}, now: 1000, fetchImpl, currentSotaVersion: 1 });
            expect(res.sotaVersion).toBe(3);
            expect(res.sotaUpdateAvailable).toBe(true);
            const marker = JSON.parse(readFileSync(join(home, ".smithers", "update-check.json"), "utf8"));
            expect(marker.sotaVersion).toBe(3);
            // The cached registry version survives the throttle window too.
            const cached = await ensureUpdateCheck({ currentVersion: "0.26.1", homeDir: home, env: {}, now: 2000, fetchImpl, currentSotaVersion: 1 });
            expect(cached.checkedNow).toBe(false);
            expect(cached.sotaUpdateAvailable).toBe(true);
        });
    });

    test("an equal or older remote registry is not an update", async () => {
        await withHome(async (home) => {
            const { fetchImpl } = fakeFetch({ npmVersion: "0.27.0", sotaVersion: 2 });
            const res = await ensureUpdateCheck({ currentVersion: "0.26.1", homeDir: home, env: {}, now: 1000, fetchImpl, currentSotaVersion: 2 });
            expect(res.sotaUpdateAvailable).toBe(false);
        });
    });
});

describe("fetchRemoteSotaVersion", () => {
    test("reads an integer version from the registry JSON", async () => {
        const fetchImpl = async () => ({ ok: true, json: async () => ({ version: 4 }) });
        expect(await fetchRemoteSotaVersion({ fetchImpl })).toBe(4);
    });

    test("rejects non-integer versions, bad responses, and throws", async () => {
        expect(await fetchRemoteSotaVersion({ fetchImpl: async () => ({ ok: true, json: async () => ({ version: "4" }) }) })).toBeNull();
        expect(await fetchRemoteSotaVersion({ fetchImpl: async () => ({ ok: false }) })).toBeNull();
        expect(await fetchRemoteSotaVersion({ fetchImpl: async () => { throw new Error("offline"); } })).toBeNull();
    });
});
