import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    SMITHERS_PACKAGE,
    UPDATE_CHECK_INTERVAL_MS,
    buildUpdatePlan,
    compareVersions,
    detectInstallMethod,
    ensureUpdateCheck,
    fetchLatestVersion,
    formatUpdateNotice,
    globalUpdateCommand,
    isUpdateAvailable,
    parseVersion,
} from "../src/update-check.js";

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
            let calls = 0;
            const fetchImpl = async () => {
                calls++;
                return { ok: true, json: async () => ({ version: "0.27.0" }) };
            };
            const res = await ensureUpdateCheck({ currentVersion: "0.26.1", homeDir: home, env: {}, now: 1000, fetchImpl });
            expect(res).toEqual({ current: "0.26.1", latest: "0.27.0", updateAvailable: true, checkedNow: true });
            expect(calls).toBe(1);
            const marker = JSON.parse(readFileSync(join(home, ".smithers", "update-check.json"), "utf8"));
            expect(marker.latest).toBe("0.27.0");
            expect(marker.lastCheckMs).toBe(1000);
        });
    });

    test("reuses the cached version inside the throttle window without a network call", async () => {
        await withHome(async (home) => {
            let calls = 0;
            const fetchImpl = async () => {
                calls++;
                return { ok: true, json: async () => ({ version: "0.27.0" }) };
            };
            await ensureUpdateCheck({ currentVersion: "0.26.1", homeDir: home, env: {}, now: 1000, fetchImpl });
            const res = await ensureUpdateCheck({ currentVersion: "0.26.1", homeDir: home, env: {}, now: 1000 + 60_000, fetchImpl });
            expect(calls).toBe(1);
            expect(res.checkedNow).toBe(false);
            expect(res.updateAvailable).toBe(true);
        });
    });

    test("re-checks once the throttle window elapses", async () => {
        await withHome(async (home) => {
            let calls = 0;
            const fetchImpl = async () => {
                calls++;
                return { ok: true, json: async () => ({ version: "0.27.0" }) };
            };
            await ensureUpdateCheck({ currentVersion: "0.26.1", homeDir: home, env: {}, now: 1000, fetchImpl });
            await ensureUpdateCheck({ currentVersion: "0.26.1", homeDir: home, env: {}, now: 1000 + UPDATE_CHECK_INTERVAL_MS, fetchImpl });
            expect(calls).toBe(2);
        });
    });

    test("is disabled by SMITHERS_NO_UPDATE_CHECK and skips an unknown version", async () => {
        await withHome(async (home) => {
            const fetchImpl = async () => { throw new Error("should not be called"); };
            expect(await ensureUpdateCheck({ currentVersion: "0.26.1", homeDir: home, env: { SMITHERS_NO_UPDATE_CHECK: "1" }, now: 1, fetchImpl })).toBeNull();
            expect(await ensureUpdateCheck({ currentVersion: "unknown", homeDir: home, env: {}, now: 1, fetchImpl })).toBeNull();
        });
    });
});
