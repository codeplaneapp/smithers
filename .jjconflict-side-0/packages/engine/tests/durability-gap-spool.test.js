import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { appendGap, drainGaps, defaultGapSpoolPath } from "../src/durabilityGapSpool.js";

function tmpSpool() {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gap-spool-")), "x.gaps.ndjson");
}

describe("durabilityGapSpool", () => {
    test("append then drain round-trips records and clears the spool", () => {
        const spool = tmpSpool();
        appendGap(spool, { runId: "r1", reason: "snapshot-failed", ts: 1 });
        appendGap(spool, { runId: "r1", reason: "snapshot-error", ts: 2 });
        const gaps = drainGaps(spool);
        expect(gaps.map((g) => g.reason)).toEqual(["snapshot-failed", "snapshot-error"]);
        // Draining clears it.
        expect(drainGaps(spool)).toEqual([]);
        expect(fs.existsSync(spool)).toBe(false);
    });

    test("drain skips a torn/partial line without throwing", () => {
        const spool = tmpSpool();
        fs.mkdirSync(path.dirname(spool), { recursive: true });
        fs.writeFileSync(spool, '{"reason":"ok"}\n{not json\n{"reason":"ok2"}\n');
        expect(drainGaps(spool).map((g) => g.reason)).toEqual(["ok", "ok2"]);
    });

    test("drain on a missing file returns [] and never throws", () => {
        expect(drainGaps(path.join(os.tmpdir(), "definitely-missing", "x.ndjson"))).toEqual([]);
    });

    test("default spool path is outside any worktree, under the temp dir", () => {
        const p = defaultGapSpoolPath("run-abc/../weird");
        expect(p.startsWith(os.tmpdir())).toBe(true);
        expect(p).not.toContain("..");
    });
});
