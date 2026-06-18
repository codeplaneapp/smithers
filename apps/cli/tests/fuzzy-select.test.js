import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { isCancel } from "@clack/core";
import { fuzzyFilter, fuzzyScore, fuzzySelect } from "../src/fuzzy-select.js";

const opts = (...labels) => labels.map((label) => ({ value: label, label }));
const labelsOf = (result) => result.map((o) => o.label);

describe("fuzzyScore", () => {
    test("empty query matches everything with score 0", () => {
        expect(fuzzyScore("", "anything")).toEqual({ matched: true, score: 0 });
    });

    test("matches a contiguous prefix", () => {
        expect(fuzzyScore("rev", "review").matched).toBe(true);
    });

    test("matches a scattered subsequence (chars in order, gaps allowed)", () => {
        // r..e..v all appear in order inside "rebase-verify"
        expect(fuzzyScore("rev", "rebase-verify").matched).toBe(true);
    });

    test("rejects when a query char is missing", () => {
        const r = fuzzyScore("xyz", "review");
        expect(r.matched).toBe(false);
        expect(r.score).toBe(Number.POSITIVE_INFINITY);
    });

    test("rejects when chars are present but out of order", () => {
        // "ba" cannot be matched in "ab" (b comes after a, no second a)
        expect(fuzzyScore("ba", "ab").matched).toBe(false);
    });

    test("is case-insensitive", () => {
        expect(fuzzyScore("REV", "review").matched).toBe(true);
        expect(fuzzyScore("rev", "REVIEW").matched).toBe(true);
    });

    test("a tighter (contiguous) match scores lower than a scattered one", () => {
        const tight = fuzzyScore("rev", "review");
        const scattered = fuzzyScore("rev", "rebase-verify");
        expect(tight.matched && scattered.matched).toBe(true);
        expect(tight.score).toBeLessThan(scattered.score);
    });

    test("start-of-word match outranks a mid-word match", () => {
        const startOfWord = fuzzyScore("c", "code"); // c at index 0
        const midWord = fuzzyScore("c", "abcd"); // c at index 2
        expect(startOfWord.score).toBeLessThan(midWord.score);
    });

    test("camelCase boundary earns the start-of-word bonus", () => {
        // The 'S' in "openSelect" is a camelCase boundary.
        const camel = fuzzyScore("s", "openSelect");
        const plain = fuzzyScore("s", "openselect"); // 's' mid-word, no boundary
        expect(camel.score).toBeLessThan(plain.score);
    });
});

describe("fuzzyFilter", () => {
    test("empty query returns ALL options in original order", () => {
        const o = opts("review", "rebase", "commit");
        expect(fuzzyFilter("", o)).toEqual(o);
        // same object identity, not a copy of the option contents
        expect(fuzzyFilter("", o)[0]).toBe(o[0]);
    });

    test("keeps only labels containing the query chars in order", () => {
        const result = fuzzyFilter("rev", opts("review", "rebase-verify", "commit", "deploy"));
        expect(labelsOf(result)).toContain("review");
        expect(labelsOf(result)).toContain("rebase-verify");
        expect(labelsOf(result)).not.toContain("commit");
        expect(labelsOf(result)).not.toContain("deploy");
    });

    test("ranks a contiguous/prefix match above a scattered match", () => {
        const result = fuzzyFilter("rev", opts("rebase-verify", "review"));
        // "review" (contiguous) should rank first even though it came second.
        expect(labelsOf(result)).toEqual(["review", "rebase-verify"]);
    });

    test("is case-insensitive end to end", () => {
        const result = fuzzyFilter("REV", opts("Review", "Deploy"));
        expect(labelsOf(result)).toEqual(["Review"]);
    });

    test("no match returns an empty array", () => {
        expect(fuzzyFilter("zzz", opts("review", "commit"))).toEqual([]);
    });

    test("camelCase boundary outranks a plain match at the same depth", () => {
        // Both match 's' at index 1, isolating the boundary bonus: "aSb" earns
        // the camelCase bonus (-1), "asb" does not, so "aSb" ranks first.
        const result = fuzzyFilter("s", opts("asb", "aSb"));
        expect(labelsOf(result)[0]).toBe("aSb");
    });

    test("does not mutate the input array or its options", () => {
        const o = opts("b", "a");
        const snapshot = JSON.parse(JSON.stringify(o));
        fuzzyFilter("a", o);
        expect(JSON.parse(JSON.stringify(o))).toEqual(snapshot);
    });

    test("empty query preserves original order exactly", () => {
        const o = opts("alpha", "beta", "gamma");
        expect(labelsOf(fuzzyFilter("", o))).toEqual(["alpha", "beta", "gamma"]);
    });

    test("equal-score matches break ties by shorter label, then original index", () => {
        // Both labels match "a" as a start-of-word char at index 0 → identical
        // score. The shorter label ("ax") must sort before the longer one.
        const result = fuzzyFilter("a", opts("axxxx", "ax"));
        expect(labelsOf(result)).toEqual(["ax", "axxxx"]);
    });

    test("tolerates a non-array input", () => {
        expect(fuzzyFilter("x", undefined)).toEqual([]);
    });
});

// --- Interactive prompt integration (real Prompt base class, fake streams) ---

/** Minimal TTY-ish readable that the clack readline pipeline can consume. */
class FakeInput extends EventEmitter {
    constructor() {
        super();
        this.isTTY = true;
        this.readable = true;
    }
    setRawMode() {}
    setEncoding() {}
    resume() {}
    pause() {}
    pipe(dest) {
        this._dest = dest;
        return dest;
    }
    unpipe() {
        this._dest = undefined;
    }
    write() {
        return true;
    }
    on(event, cb) {
        return super.on(event, cb);
    }
    /** Drive the prompt's onKeypress directly, mirroring readline keypress events. */
    keypress(seq, key) {
        this.emit("keypress", seq, key);
    }
}

class FakeOutput extends EventEmitter {
    constructor() {
        super();
        this.isTTY = true;
        this.columns = 80;
        this.rows = 24;
        this.buffer = "";
    }
    write(chunk) {
        this.buffer += String(chunk);
        return true;
    }
}

/** Start a fuzzySelect against fake streams; returns the prompt promise + input. */
function startPicker(options, extra = {}) {
    const input = new FakeInput();
    const output = new FakeOutput();
    const promise = fuzzySelect({
        message: "Pick one",
        options,
        input,
        output,
        ...extra,
    });
    return { promise, input, output };
}

describe("fuzzySelect (interactive)", () => {
    test("typing letters filters and Enter returns the highlighted option's value", async () => {
        const { promise, input } = startPicker([
            { value: "a", label: "review" },
            { value: "b", label: "rebase" },
            { value: "c", label: "commit" },
        ]);
        // Type "co" → only "commit" matches.
        input.keypress("c", { name: "c" });
        input.keypress("o", { name: "o" });
        input.keypress("\r", { name: "return" });
        const result = await promise;
        expect(result).toBe("c");
    });

    test("typing 'j' appends to the query instead of moving the cursor", async () => {
        const { promise, input } = startPicker([
            { value: "x", label: "jot" },
            { value: "y", label: "alpha" },
        ]);
        // With trackValue=true, 'j' is query text (not a vim-down alias).
        input.keypress("j", { name: "j" });
        // Only "jot" survives the filter, so Enter must resolve "x".
        input.keypress("\r", { name: "return" });
        const result = await promise;
        expect(result).toBe("x");
    });

    test("backspace widens the filter again", async () => {
        const { promise, input } = startPicker([
            { value: "a", label: "review" },
            { value: "b", label: "deploy" },
        ]);
        // Type "rev" (narrows to review), then delete back to "" (all visible),
        // then arrow down to the second option and submit it.
        input.keypress("r", { name: "r" });
        input.keypress("e", { name: "e" });
        input.keypress("v", { name: "v" });
        input.keypress("\x7f", { name: "backspace" });
        input.keypress("\x7f", { name: "backspace" });
        input.keypress("\x7f", { name: "backspace" });
        input.keypress(undefined, { name: "down" });
        input.keypress("\r", { name: "return" });
        const result = await promise;
        expect(result).toBe("b");
    });

    test("arrow keys move the highlight within the filtered list (with wrap)", async () => {
        const { promise, input } = startPicker([
            { value: "1", label: "one" },
            { value: "2", label: "two" },
            { value: "3", label: "three" },
        ]);
        // Empty query → all three. Up from index 0 wraps to the last option.
        input.keypress(undefined, { name: "up" });
        input.keypress("\r", { name: "return" });
        const result = await promise;
        expect(result).toBe("3");
    });

    test("ctrl-c resolves the clack cancel symbol", async () => {
        const { promise, input } = startPicker([{ value: "a", label: "review" }]);
        input.keypress("\x03", { name: "c" });
        const result = await promise;
        expect(isCancel(result)).toBe(true);
    });

    test("escape resolves the clack cancel symbol", async () => {
        const { promise, input } = startPicker([{ value: "a", label: "review" }]);
        input.keypress("\x1b", { name: "escape" });
        const result = await promise;
        expect(isCancel(result)).toBe(true);
    });

    test("initialValue positions the initial cursor", async () => {
        const { promise, input } = startPicker(
            [
                { value: "1", label: "one" },
                { value: "2", label: "two" },
                { value: "3", label: "three" },
            ],
            { initialValue: "2" },
        );
        // Cursor starts on "two"; Enter with no movement returns it.
        input.keypress("\r", { name: "return" });
        const result = await promise;
        expect(result).toBe("2");
    });

    test("renders a 'No matches' empty state without crashing", async () => {
        const { promise, input, output } = startPicker([{ value: "a", label: "review" }]);
        input.keypress("z", { name: "z" }); // nothing matches "z"
        // Cursor handling is a no-op on an empty list; ensure no throw.
        input.keypress(undefined, { name: "down" });
        expect(output.buffer).toContain("No matches");
        // Clean up the pending prompt so the test runner can exit.
        input.keypress("\x03", { name: "c" });
        await promise;
    });

    test("Enter on no matches reasks instead of resolving undefined", async () => {
        const { promise, input, output } = startPicker([
            { value: "a", label: "review" },
            { value: "b", label: "deploy" },
        ]);

        input.keypress("z", { name: "z" });
        input.keypress("\r", { name: "return" });
        expect(output.buffer).toContain("No matches.");

        input.keypress("\x7f", { name: "backspace" });
        input.keypress("d", { name: "d" });
        input.keypress("\r", { name: "return" });

        await expect(promise).resolves.toBe("b");
    });
});
