import { Prompt } from "@clack/core";
import pc from "picocolors";

// Clack glyphs, mirrored from @clack/prompts so the picker is visually identical
// to a native `select()`. The TUI already assumes a unicode-capable terminal
// (the existing run-card renderer hardcodes ◆ │ └ ● ○ too), so we use the
// unicode forms directly rather than re-deriving clack's ASCII fallback.
const S_BAR = "│";
const S_BAR_END = "└";
const S_RADIO_ACTIVE = "●";
const S_RADIO_INACTIVE = "○";
const S_STEP_ACTIVE = "◆";
const S_STEP_CANCEL = "■";
const S_STEP_ERROR = "▲";
const S_STEP_SUBMIT = "◇";

/** Clack's state → leading status symbol (cyan ◆ / green ◇ / red ■ / yellow ▲). */
function symbol(state) {
    switch (state) {
        case "initial":
        case "active":
            return pc.cyan(S_STEP_ACTIVE);
        case "cancel":
            return pc.red(S_STEP_CANCEL);
        case "error":
            return pc.yellow(S_STEP_ERROR);
        case "submit":
            return pc.green(S_STEP_SUBMIT);
        default:
            return pc.cyan(S_STEP_ACTIVE);
    }
}

const WORD_BOUNDARY = new Set([" ", "-", "_", "/", ".", ":"]);
const BACKSPACE_SEQUENCES = new Set(["\x7f", "\b"]);

/**
 * Score how well `query` fuzzy-matches `text` (case-insensitive subsequence).
 *
 * Lower score = better, so callers sort ascending. Pure: no I/O, no mutation.
 *
 * Scoring (deterministic so tests can assert exact ordering):
 *  - empty query → every text matches with score 0 (preserves input order).
 *  - subsequence test: each query char must appear in `text`, left-to-right, in
 *    order (not necessarily contiguous). If not, `matched` is false.
 *  - gaps between consecutive matches add to the score (tighter = lower).
 *  - start-of-word / camelCase matches subtract 1 (rank higher).
 *  - the index of the first matched char is added (earlier match = lower).
 *
 * @param {string} query
 * @param {string} text
 * @returns {{ matched: boolean; score: number }}
 */
export function fuzzyScore(query, text) {
    const q = String(query ?? "").toLowerCase();
    const original = String(text ?? "");
    const t = original.toLowerCase();
    if (q.length === 0) return { matched: true, score: 0 };

    let score = 0;
    let qi = 0;
    let prevMatchIndex = -1;
    let firstMatchIndex = -1;
    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
        if (t[ti] !== q[qi]) continue;
        if (firstMatchIndex === -1) firstMatchIndex = ti;
        const gap = ti - prevMatchIndex - 1;
        score += gap;
        const atStart = ti === 0;
        const afterBoundary = ti > 0 && WORD_BOUNDARY.has(t[ti - 1]);
        const isCamel = ti > 0 && original[ti] >= "A" && original[ti] <= "Z" && original[ti - 1] >= "a" && original[ti - 1] <= "z";
        if (atStart || afterBoundary || isCamel) score -= 1;
        prevMatchIndex = ti;
        qi += 1;
    }
    if (qi < q.length) return { matched: false, score: Number.POSITIVE_INFINITY };
    score += firstMatchIndex;
    return { matched: true, score };
}

/**
 * Filter + rank `options` by how well their `label` fuzzy-matches `query`.
 *
 * Referentially pure: same inputs → same output, no mutation of inputs, no I/O.
 * Returns a NEW array of the SAME option objects, best match first. An empty
 * query returns all options in original order (so an empty box looks like a
 * plain select). Matching is case-insensitive against `option.label` only.
 *
 * @template {{ value: unknown; label: string; hint?: string }} O
 * @param {string} query
 * @param {O[]} options
 * @returns {O[]}
 */
export function fuzzyFilter(query, options) {
    const list = Array.isArray(options) ? options : [];
    // Empty query → return all options in ORIGINAL order. We special-case this
    // (rather than relying on the score=0 tie-break) so the length tie-break
    // below never reorders an unfiltered list: an empty box must look exactly
    // like a plain select.
    if (String(query ?? "").length === 0) return list.slice();
    return list
        .map((option, index) => ({ option, index, ...fuzzyScore(query, option.label ?? "") }))
        .filter((x) => x.matched)
        .sort((a, b) => {
            if (a.score !== b.score) return a.score - b.score;
            const la = (a.option.label ?? "").length;
            const lb = (b.option.label ?? "").length;
            if (la !== lb) return la - lb;
            return a.index - b.index;
        })
        .map((x) => x.option);
}

function removeBackspaceSequences(value) {
    let result = "";
    for (const char of String(value ?? "")) {
        if (BACKSPACE_SEQUENCES.has(char)) {
            result = result.slice(0, -1);
        } else {
            result += char;
        }
    }
    return result;
}

function isBackspace(text, key) {
    return key?.name === "backspace" || BACKSPACE_SEQUENCES.has(key?.sequence) || BACKSPACE_SEQUENCES.has(text);
}

function isDelete(key) {
    return key?.name === "delete";
}

/**
 * Reimplements clack's `limitOptions` windowing EXACTLY (offset slide + "..."
 * sentinels) so the rendered list never overflows the terminal or ghosts on a
 * small viewport. Bounded by `maxItems` AND `rows - 4`.
 *
 * @template T
 * @param {{ cursor: number; options: T[]; maxItems?: number; rows: number; style: (opt: T, active: boolean) => string }} args
 * @returns {string[]}
 */
function limitOptions({ cursor, options, maxItems, rows, style }) {
    const limit = maxItems ?? Number.POSITIVE_INFINITY;
    const paneHeight = Math.max(rows - 4, 0);
    const windowSize = Math.min(paneHeight, Math.max(limit, 5));
    let slidingOffset = 0;
    if (cursor >= slidingOffset + windowSize - 3) {
        slidingOffset = Math.max(Math.min(cursor - windowSize + 3, options.length - windowSize), 0);
    } else if (cursor < slidingOffset + 2) {
        slidingOffset = Math.max(cursor - 2, 0);
    }
    const shouldRenderTopEllipsis = windowSize < options.length && slidingOffset > 0;
    const shouldRenderBottomEllipsis = windowSize < options.length && slidingOffset + windowSize < options.length;
    return options.slice(slidingOffset, slidingOffset + windowSize).map((option, i, arr) => {
        const isTopLimit = i === 0 && shouldRenderTopEllipsis;
        const isBottomLimit = i === arr.length - 1 && shouldRenderBottomEllipsis;
        return isTopLimit || isBottomLimit ? pc.dim("...") : style(option, i + slidingOffset === cursor);
    });
}

/** process.stdout.rows is undefined when not a TTY (CI/piped); fall back to 24. */
function terminalRows() {
    return process.stdout.rows || 24;
}

/**
 * A type-to-filter picker built on clack's `Prompt` base class. We subclass
 * `Prompt` directly (NOT `SelectPrompt`) with `trackValue=true` so the base
 * pipes readline and keeps `this.value` in sync with the typed query — letters
 * (including j/k/h/l) become filter text, while arrow keys still move the cursor.
 *
 * Instance fields we own (separate from base `this.value`/`this._cursor`):
 *  - `query`        live filter text, mirrored from base `this.value`.
 *  - `allOptions`   immutable input options.
 *  - `filtered`     current fuzzyFilter(query, allOptions) result.
 *  - `optionCursor` index into `filtered` (clamped), NOT into allOptions.
 *      We deliberately do NOT reuse the base's `_cursor`: @clack/core's
 *      `Prompt.onKeypress` runs `this._cursor = this.rl?.cursor ?? 0` on every
 *      tracked keypress (before it emits our "cursor" event), so the base's
 *      readline text cursor can clobber our option index, leaving arrow-down
 *      near the top and Enter able to return a lower-ranked match. Owning
 *      `optionCursor` keeps the highlight independent of readline.
 *  - `maxItems`     windowing budget.
 *
 * Enter, ctrl-c and escape flow to the base: Enter sets state="submit" and we
 * override `this.value` to the highlighted option's value in a `finalize`
 * handler; ctrl-c/escape set state="cancel" so `prompt()` resolves the clack
 * cancel symbol and the caller's `isCancel()` works with zero extra code.
 */
class FuzzySelectPrompt extends Prompt {
    constructor(opts) {
        // Second arg `true` → trackValue (TextPrompt behavior): @clack/core v1
        // defaults it to false when omitted, so we pass it explicitly. With it
        // the base tracks typed input into `userInput` and emits "cursor" for
        // arrow keys. We intentionally do NOT forward `initialValue`: the base
        // treats it as query text. We start the query empty and use
        // initialValue only to position the initial cursor (below).
        // `validate` is passed via options because v1 made `opts` private.
        super(
            {
                render: opts.render,
                signal: opts.signal,
                input: opts.input,
                output: opts.output,
                validate: () => (this.filtered.length === 0 ? "No matches." : undefined),
            },
            true,
        );

        this.allOptions = Array.isArray(opts.options) ? opts.options : [];
        this.maxItems = opts.maxItems;
        this.query = "";
        this.previousQuery = "";
        this.filtered = fuzzyFilter("", this.allOptions);

        // Position the cursor on the option matching initialValue (default 0).
        this.optionCursor = 0;
        if (opts.initialValue !== undefined) {
            const i = this.filtered.findIndex((o) => o.value === opts.initialValue);
            if (i >= 0) this.optionCursor = i;
        }

        // Re-filter on every tracked text update from readline.
        this.on("userInput", () => {
            this.previousQuery = this.query;
            this.setQuery(this.userInput ?? "");
        });

        // Some synthetic TTY streams leave raw delete markers in rl.line. Normalize
        // those while preserving terminals where readline already applied the edit.
        this.on("key", (text, key) => {
            const current = this.userInput ?? "";
            const normalized = removeBackspaceSequences(current);
            if (normalized !== current) {
                this.replaceTrackedInput(normalized, normalized.length);
                return;
            }
            if (isBackspace(text, key) && current === this.previousQuery && current.length > 0) {
                const cursor = Math.max(0, Math.min(this.rl?.cursor ?? current.length, current.length));
                this.replaceTrackedInput(current.slice(0, Math.max(0, cursor - 1)) + current.slice(cursor), Math.max(0, cursor - 1));
                return;
            }
            if (isDelete(key) && current === this.previousQuery && current.length > 0) {
                const cursor = Math.max(0, Math.min(this.rl?.cursor ?? current.length, current.length));
                this.replaceTrackedInput(current.slice(0, cursor) + current.slice(cursor + 1), cursor);
            }
        });

        // Arrow keys (and only arrow keys, since trackValue=true) emit "cursor".
        // Wrap within the FILTERED array; guard the empty list.
        this.on("cursor", (key) => {
            if (this.filtered.length === 0) return;
            switch (key) {
                case "up":
                case "left":
                    this.optionCursor = this.optionCursor === 0 ? this.filtered.length - 1 : this.optionCursor - 1;
                    break;
                case "down":
                case "right":
                    this.optionCursor = this.optionCursor === this.filtered.length - 1 ? 0 : this.optionCursor + 1;
                    break;
            }
        });

        // CRITICAL: the base resolves prompt() with `this.value`, which under
        // trackValue is the typed QUERY. finalize fires before close()→emit, and
        // for submit (not cancel) we overwrite it with the highlighted option's
        // value so the caller receives the selection, not the query string.
        this.on("finalize", () => {
            if (this.state === "submit") {
                const selected = this.filtered[this.optionCursor];
                this.value = selected ? selected.value : undefined;
            }
        });
    }

    setQuery(query) {
        this.query = query ?? "";
        this.filtered = fuzzyFilter(this.query, this.allOptions);
        if (this.optionCursor > this.filtered.length - 1) {
            this.optionCursor = Math.max(0, this.filtered.length - 1);
        }
    }

    replaceTrackedInput(query, cursor) {
        this.userInput = query ?? "";
        if (this.rl) {
            this.rl.line = this.userInput;
            this.rl.cursor = Math.max(0, Math.min(cursor ?? this.userInput.length, this.userInput.length));
        }
        this.setQuery(this.userInput);
    }
}

/**
 * One-line option styling matching clack's `select()`:
 *  - active:   `● label (hint)`  (green marker, dim hint in parens)
 *  - inactive: `○ label`         (both dim)
 *
 * @param {{ label: string; hint?: string }} option
 * @param {boolean} active
 */
function styleOption(option, active) {
    const label = option.label ?? String(option.value ?? "");
    if (active) {
        return `${pc.green(S_RADIO_ACTIVE)} ${label} ${option.hint ? pc.dim(`(${option.hint})`) : ""}`;
    }
    return `${pc.dim(S_RADIO_INACTIVE)} ${pc.dim(label)}`;
}

/**
 * Render the picker as a single string, matching clack's `select()` look with
 * one addition: a cyan query row showing the live filter text + block cursor.
 *
 * @param {FuzzySelectPrompt} self
 * @param {string} message
 */
function renderPrompt(self, message) {
    const header = `${pc.gray(S_BAR)}\n${symbol(self.state)}  ${message}\n`;
    const selectedLabel = self.filtered[self.optionCursor]?.label;

    switch (self.state) {
        case "submit":
            // Collapse to the selected label, dim, no list.
            return `${header}${pc.gray(S_BAR)}  ${pc.dim(selectedLabel ?? "")}`;
        case "cancel": {
            // Strikethrough the pending selection (or the query if no match).
            const cancelled = selectedLabel ?? self.query ?? "";
            return `${header}${pc.gray(S_BAR)}  ${pc.strikethrough(pc.dim(cancelled))}\n${pc.gray(S_BAR)}`;
        }
        default: {
            // The body gutter is cyan normally, yellow in the error state — pick
            // the color once so every row (query, list, footer) stays consistent.
            const bar = self.state === "error" ? pc.yellow : pc.cyan;
            const gutter = bar(S_BAR);
            const queryRow = self.query.length > 0 ? `${self.query}█` : pc.dim("Type to filter…");
            const lines = [`${gutter}  ${queryRow}`];

            if (self.filtered.length === 0) {
                lines.push(`${gutter}  ${pc.dim("No matches")}`);
            } else {
                const windowed = limitOptions({
                    cursor: self.optionCursor,
                    options: self.filtered,
                    maxItems: self.maxItems,
                    rows: terminalRows(),
                    style: styleOption,
                });
                lines.push(`${gutter}  ${windowed.join(`\n${gutter}  `)}`);
            }

            const footer = self.state === "error"
                ? `${pc.yellow(S_BAR_END)}  ${pc.yellow(self.error)}`
                : `${pc.cyan(S_BAR_END)}`;
            return `${header}${lines.join("\n")}\n${footer}\n`;
        }
    }
}

/**
 * Interactive fuzzy-filter picker. Type to narrow a long list; arrow keys move
 * the highlight within the filtered results; Enter returns the highlighted
 * option's `value`; ctrl-c / escape return clack's cancel symbol (detect with
 * `isCancel` from `@clack/core` or `@clack/prompts`).
 *
 * Empty query shows all options. No matches shows a clean empty state and Enter
 * reasks instead of resolving an undefined selection.
 *
 * @template {{ value: unknown; label: string; hint?: string }} O
 * @param {{ message: string; options: O[]; initialValue?: O["value"]; maxItems?: number; input?: NodeJS.ReadStream; output?: NodeJS.WriteStream; signal?: AbortSignal }} args
 * @returns {Promise<O["value"] | symbol>}
 */
export function fuzzySelect({ message, options, initialValue, maxItems = 10, input, output, signal }) {
    const prompt = new FuzzySelectPrompt({
        options,
        initialValue,
        maxItems,
        input,
        output,
        signal,
        render() {
            return renderPrompt(this, message);
        },
    });
    return prompt.prompt();
}
