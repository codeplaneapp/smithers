import pc from "picocolors";

/**
 * Format any agent stream text before the TUI wraps it. This keeps raw event
 * data intact and only changes presentation.
 *
 * @param {string} text
 * @returns {string}
 */
export function formatStreamText(text) {
    const raw = typeof text === "string" ? text : text == null ? "" : String(text);
    const codexLog = formatCodexLog(raw);
    if (codexLog !== null) return codexLog;
    if (/^\s*\[(?:tool|command)\]/i.test(raw)) return formatToolCall(raw);
    return normalizeStreamText(raw);
}

/**
 * Clean noisy agent tool-call stream text for the smithers TUI.
 *
 * The TUI renders raw text produced by `parseAgentEvent` (see chat.js), which
 * looks like:
 *   (a) "[tool] /bin/zsh -lc 'git diff HEAD~7..HEAD -- apps/cli/src/tui.js'"
 *   (b) "[tool] Bash: {\"command\":\"git show ...\",\"description\":\"...\"}"
 *   (c) "[tool] Bash -> commit 87d5892... (multiline output)"
 *
 * This collapses shell wrappers, surfaces the meaningful command/params from
 * JSON tool inputs, flattens whitespace, and renders completed lines as a
 * compact "✓ call" rather than dumping output. It is defensive: any parse
 * failure falls back to a minimally-cleaned version of the input.
 *
 * @param {string} text
 * @returns {string}
 */
export function formatToolCall(text) {
    try {
        if (typeof text !== "string") return text == null ? "" : String(text);
        const raw = text;

        // Empty / whitespace-only input has nothing to render.
        if (raw.trim() === "") return "";

        const markerMatch = raw.match(/^\s*(\[[^\]]+\])\s*([\s\S]*)$/);
        let body = markerMatch ? markerMatch[2] : raw;

        // Completed lines: "<call> -> <output>" (parseAgentEvent uses "→", but
        // also tolerate ascii "->"). Keep only the call side and append a
        // checkmark instead of dumping the (often multiline) output.
        //
        // A *started* JSON tool call ("<Tool>: {…}") may legitimately contain
        // "->"/"→" inside its arguments (e.g. a shell command); the completion
        // arrow that parseAgentEvent inserts only ever follows a bare title. So
        // only hunt for the arrow when the body is NOT a started JSON form,
        // otherwise we'd split mid-payload and mislabel a running call as done.
        let completed = false;
        if (!isStartedJsonForm(body)) {
            const arrowSplit = splitOnArrow(body);
            if (arrowSplit) {
                completed = true;
                body = arrowSplit;
            }
        }

        const parsed = parseToolBody(body);
        const flat = renderToolBody(parsed, completed);

        if (completed) {
            return flat ? `${pc.green("✓")} ${flat}` : pc.green("✓");
        }
        return flat;
    } catch {
        // Never throw: fall back to a minimally-cleaned version of the input.
        try {
            return collapse(typeof text === "string" ? text : String(text));
        } catch {
            return typeof text === "string" ? text : "";
        }
    }
}

/**
 * True when the body is a started JSON tool call ("<Tool>: {…}"). Such bodies
 * carry arbitrary JSON arguments that can contain "->"/"→", so they must not be
 * scanned for the completion arrow.
 * @param {string} body
 * @returns {boolean}
 */
function isStartedJsonForm(body) {
    return /^[A-Za-z_][\w.-]*\s*:\s*\{/.test(body.trim());
}

/**
 * Split a completed line on the first " -> " / " → " separator and return the
 * call side. Returns null when there is no arrow separator.
 * @param {string} body
 * @returns {string | null}
 */
function splitOnArrow(body) {
    const idx = body.search(/\s(?:->|→)\s/);
    if (idx === -1) return null;
    return body.slice(0, idx);
}

/**
 * Parse a tool-call body: strip shell wrappers and surface JSON tool inputs.
 * @param {string} body
 * @returns {{ kind: "shell" | "tool"; tool: string | null; text: string }}
 */
function parseToolBody(body) {
    const trimmed = body.trim();

    // Form (b): "<Tool>: {json}" — surface the command (or compact params).
    const jsonForm = parseJsonToolForm(trimmed);
    if (jsonForm !== null) return jsonForm;

    // Form (a): a bare shell wrapper — unwrap to just the inner command.
    const commandCandidate = unquote(trimmed);
    const unwrapped = stripShellWrapper(commandCandidate);
    if (unwrapped !== commandCandidate || looksLikeShellCommand(unwrapped)) {
        return { kind: "shell", tool: null, text: compactHomePath(unwrapped) };
    }

    if (/^[A-Za-z_][\w.-]*$/.test(trimmed)) {
        return { kind: "tool", tool: trimmed, text: "" };
    }

    const [tool, ...rest] = trimmed.split(/\s+/);
    if (tool && /^[A-Za-z_][\w.-]*$/.test(tool)) {
        return { kind: "tool", tool, text: compactHomePath(rest.join(" ")) };
    }

    return { kind: "tool", tool: null, text: compactHomePath(trimmed) };
}

/**
 * Parse a "<Tool>: {json}" body. Returns the formatted string, or null when the
 * body is not in that shape (so the caller can fall through to other handling).
 * @param {string} body
 * @returns {{ kind: "shell" | "tool"; tool: string | null; text: string } | null}
 */
function parseJsonToolForm(body) {
    const sep = body.indexOf(":");
    if (sep === -1) return null;
    const toolName = body.slice(0, sep).trim();
    const rest = body.slice(sep + 1).trim();
    // Tool name must be a simple identifier and the rest must look like JSON.
    if (!toolName || !/^[A-Za-z_][\w.-]*$/.test(toolName)) return null;
    if (!rest.startsWith("{")) return null;

    let parsed;
    try {
        parsed = JSON.parse(rest);
    } catch {
        // Malformed JSON: keep the tool name + the raw (collapsed) payload so
        // the user still sees something useful, minimally cleaned.
        return { kind: "tool", tool: toolName, text: rest };
    }
    if (!parsed || typeof parsed !== "object") return { kind: "tool", tool: toolName, text: rest };

    // If there is a command field, show the (unwrapped) command, optionally with
    // a dimmed description in parens.
    const command = pickString(parsed, ["command", "cmd"]);
    if (command) {
        const cmd = compactHomePath(stripShellWrapper(command.trim()));
        const description = pickString(parsed, ["description", "desc"]);
        if (description) {
            return { kind: "shell", tool: toolName, text: `${cmd} ${pc.dim(`(${collapse(description)})`)}` };
        }
        return { kind: "shell", tool: toolName, text: cmd };
    }

    // Otherwise: tool name + a compact key=value of the most relevant params.
    const kv = compactParams(parsed);
    return { kind: "tool", tool: toolName, text: kv };
}

/**
 * @param {{ kind: "shell" | "tool"; tool: string | null; text: string }} parsed
 * @param {boolean} [completed]
 * @returns {string}
 */
function renderToolBody(parsed, completed = false) {
    const text = collapse(parsed.text);
    if (parsed.kind === "shell") {
        if (completed) return text;
        return text ? `${pc.dim("$")} ${text}` : pc.dim("$");
    }
    const tool = parsed.tool ? parsed.tool.toLowerCase() : "tool";
    return text ? `${pc.cyan(tool)} ${text}` : pc.cyan(tool);
}

/**
 * Pick the first string value present for any of the given keys.
 * @param {Record<string, unknown>} obj
 * @param {string[]} keys
 * @returns {string | null}
 */
function pickString(obj, keys) {
    for (const key of keys) {
        const value = obj[key];
        if (typeof value === "string" && value.length > 0) return value;
    }
    return null;
}

/**
 * Render the most relevant params of a tool input as compact key=value pairs.
 * Prefers a small set of common keys, falls back to the first few primitives.
 * @param {Record<string, unknown>} obj
 * @returns {string}
 */
function compactParams(obj) {
    const PREFERRED = [
        "file_path",
        "filePath",
        "path",
        "file",
        "pattern",
        "query",
        "url",
        "limit",
        "offset",
        "line",
        "start",
        "end",
        "name",
        "id",
        "prompt",
    ];
    const pairs = [];
    const seen = new Set();
    for (const key of PREFERRED) {
        if (key in obj && isPrimitive(obj[key])) {
            pairs.push(formatParam(key, obj[key]));
            seen.add(key);
            if (pairs.length >= 3) break;
        }
    }
    if (pairs.length === 0) {
        for (const key of Object.keys(obj)) {
            if (seen.has(key)) continue;
            if (!isPrimitive(obj[key])) continue;
            pairs.push(formatParam(key, obj[key]));
            if (pairs.length >= 3) break;
        }
    }
    return pairs.join(" ");
}

/**
 * @param {string} key
 * @param {unknown} value
 * @returns {string}
 */
function formatParam(key, value) {
    const pathKeys = new Set(["file_path", "filePath", "path", "file"]);
    const formatted = formatValue(value);
    return pathKeys.has(key) ? formatted : `${key}=${formatted}`;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPrimitive(value) {
    return (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
    );
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function formatValue(value) {
    const str = compactHomePath(collapse(String(value)));
    return str.length > 60 ? `${str.slice(0, 60)}…` : str;
}

/**
 * @param {string} input
 * @returns {boolean}
 */
function looksLikeShellCommand(input) {
    const command = input.trim().split(/\s+/, 1)[0] ?? "";
    return /^(?:bun|cat|cd|chmod|cp|curl|find|git|grep|head|jq|ls|mkdir|mv|nl|npm|pnpm|pwd|rg|rm|sed|tail|test|touch|yarn)$/i.test(command);
}

/**
 * Strip a shell wrapper (e.g. `/bin/zsh -lc 'CMD'`, `/bin/sh -c "CMD"`,
 * `bash -lc 'CMD'`, `zsh -c CMD`) down to just CMD. Returns the input unchanged
 * when it is not a recognized wrapper.
 * @param {string} input
 * @returns {string}
 */
function stripShellWrapper(input) {
    const str = input.trim();
    // Match: optional path to a shell binary, the shell name, a flag bundle that
    // includes -c (e.g. -c, -lc, -ic), then the command (quoted or bare).
    const wrapper = str.match(
        /^(?:\S*\/)?(?:ba|z|da|k|a)?sh\s+-[a-z]*c[a-z]*\s+([\s\S]+)$/i,
    );
    if (!wrapper) return str;
    return unquote(wrapper[1].trim());
}

/**
 * Remove a single matched pair of surrounding quotes, if present.
 * @param {string} input
 * @returns {string}
 */
function unquote(input) {
    const str = input.trim();
    if (str.length >= 2) {
        const first = str[0];
        const last = str[str.length - 1];
        if ((first === "'" || first === '"') && last === first) {
            return str.slice(1, -1);
        }
        if (first === "'" || first === '"') {
            return str.slice(1);
        }
        if (last === "'" || last === '"') {
            return str.slice(0, -1);
        }
    }
    return str;
}

/**
 * Collapse all whitespace (including newlines) to single spaces and trim.
 * @param {string} input
 * @returns {string}
 */
function collapse(input) {
    return String(input).replace(/\s+/g, " ").trim();
}

/**
 * Keep ordinary stream output to one visual line so it cannot corrupt the
 * status-card layout around it.
 * @param {string} input
 */
function normalizeStreamText(input) {
    return String(input)
        .replace(/\s+$/g, "")
        .replace(/[\r\n]+/g, " ↵ ")
        .replace(/\t/g, "    ");
}

/**
 * Compact Rust tracing-style Codex logs:
 *   2026-...Z ERROR
 *   codex_core::session::session: failed to load skill ...
 *
 * @param {string} text
 * @returns {string | null}
 */
function formatCodexLog(text) {
    const normalized = normalizeStreamText(text);
    const parts = normalized.split(/\s+↵\s+/).map((part) => part.trim()).filter(Boolean);
    const joined = parts.join(" ");
    const match = joined.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\s+(TRACE|DEBUG|INFO|WARN|WARNING|ERROR)\b\s*(.*)$/i);
    if (!match) return null;
    const level = match[2];
    const body = compactHomePath(match[3]
        .replace(/^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)+:\s+/, "")
        .trim());
    return body ? `${styleStreamLevel(level)} ${body}` : styleStreamLevel(level).trimEnd();
}

/**
 * @param {string} level
 */
function styleStreamLevel(level) {
    const label = level.toLowerCase() === "warning" ? "warn" : level.toLowerCase();
    switch (label) {
        case "error":
            return pc.red("error");
        case "warn":
            return pc.yellow("warn ");
        case "info":
            return pc.cyan("info ");
        case "debug":
        case "trace":
            return pc.dim(label.padEnd(5));
        default:
            return pc.dim(label.padEnd(5));
    }
}

/**
 * @param {string} text
 */
function compactHomePath(text) {
    const home = process.env.HOME;
    if (!home) return text;
    return text.split(home).join("~");
}
