import { createScorer } from "./createScorer.js";

/** @typedef {import("./WorkflowUiComplianceOptions.ts").WorkflowUiComplianceOptions} WorkflowUiComplianceOptions */
/** @typedef {import("./WorkflowUiComplianceOptions.ts").WorkflowUiComplianceReport} WorkflowUiComplianceReport */
/** @typedef {import("./WorkflowUiComplianceOptions.ts").WorkflowUiViolation} WorkflowUiViolation */

/**
 * Static design-system compliance grader for generated workflow UIs
 * (`.smithers/ui/<key>.tsx`). Encodes the authoring contract the create-ui
 * agents keep drifting from: compose the shipped component libraries instead
 * of hand-rolling markup, and always surface live agent feedback.
 *
 * Rules (each violation carries its rule id):
 * - `imports`        — import only from react + `smithers-orchestrator/gateway-react`,
 *                      `.../gateway-ui`, `.../ui` (plus relative modules).
 * - `shell`          — page chrome comes from `WorkflowUiShell` (or
 *                      `SimpleWorkflowDashboard` for the stock layout).
 * - `mount`          — the file mounts via `createGatewayReactRoot`.
 * - `live-chat`      — when the workflow has agent tasks (or
 *                      `requireNodeChat` is set), the UI must render
 *                      `NodeChatStream` so humans see the agents' live chat.
 * - `hand-rolled-colors` — no raw hex color literals; tint through components
 *                      and theme tokens so light/dark both work.
 * - `hand-rolled-pills`  — no `borderRadius: 999` pill re-implementations;
 *                      that's `StatusPill` / `Badge`.
 * - `hand-rolled-table`  — no raw `<table>` markup; use `Table` / `FleetTable`.
 *
 * Pure and deterministic: feed it source text (no filesystem access) so it
 * runs identically in unit tests, create-ui gate tasks, and `smithers eval`
 * assertions.
 *
 * @param {string} uiSource The UI module's source text.
 * @param {WorkflowUiComplianceOptions} [options]
 * @returns {WorkflowUiComplianceReport}
 */
export function gradeWorkflowUiSource(uiSource, options = {}) {
    /** @type {WorkflowUiViolation[]} */
    const violations = [];
    const code = stripComments(uiSource);
    const syntax = maskStringsAndComments(uiSource);

    const allowedSpecifier = /^(react(\/.*)?|smithers-orchestrator\/(gateway-react|gateway-ui|ui)(\/.*)?|@smithers-orchestrator\/(gateway-react|gateway-ui|ui)(\/.*)?|\.\.?\/.*)$/;
    for (const { index, specifier } of moduleSpecifiers(uiSource)) {
        if (syntax[index] !== "i" && syntax[index] !== "e") continue;
        if (!allowedSpecifier.test(specifier)) {
            violations.push({
                rule: "imports",
                detail: `Import from "${specifier}" — workflow UIs may only import react and the smithers-orchestrator gateway-react/gateway-ui/ui subpaths.`,
            });
        }
    }

    const shellBindings = importedBindings(code, ["WorkflowUiShell", "SimpleWorkflowDashboard"]);
    if (!shellBindings.some((binding) => jsxElementIsRendered(syntax, binding))) {
        violations.push({
            rule: "shell",
            detail: "No WorkflowUiShell (or SimpleWorkflowDashboard) — page chrome, theme css, and the header slots must come from the shipped shell.",
        });
    }

    const mountBindings = importedBindings(code, ["createGatewayReactRoot"]);
    if (!mountBindings.some((binding) => callExpressionExists(syntax, binding))) {
        violations.push({
            rule: "mount",
            detail: "Missing createGatewayReactRoot(<App />) mount.",
        });
    }

    const requireNodeChat = options.requireNodeChat ??
        (options.workflowSource !== undefined ? workflowHasAgentTasks(options.workflowSource) : false);
    const chatBindings = importedBindings(code, ["NodeChatStream"]);
    if (requireNodeChat && !chatBindings.some((binding) => jsxElementIsRendered(syntax, binding))) {
        violations.push({
            rule: "live-chat",
            detail: "The workflow runs agent tasks but the UI never renders NodeChatStream — humans must be able to watch each agent's live chat.",
        });
    }

    for (const match of code.matchAll(/#(?:[0-9a-fA-F]{3}\b|[0-9a-fA-F]{6}\b|[0-9a-fA-F]{8}\b)/g)) {
        violations.push({
            rule: "hand-rolled-colors",
            detail: `Raw hex color ${match[0]} — use the shipped components/theme tokens so light and dark themes both work.`,
        });
    }

    if (/borderRadius:\s*999\b/.test(code)) {
        violations.push({
            rule: "hand-rolled-pills",
            detail: "borderRadius: 999 pill re-implementation — use StatusPill / Badge.",
        });
    }

    if (/<table\b/.test(code)) {
        violations.push({
            rule: "hand-rolled-table",
            detail: "Raw <table> markup — use Table (smithers-orchestrator/ui) or FleetTable (gateway-ui).",
        });
    }

    const rules = 7;
    const failedRules = new Set(violations.map((violation) => violation.rule)).size;
    return {
        passed: violations.length === 0,
        score: (rules - failedRules) / rules,
        violations,
    };
}

/**
 * Heuristic: does a workflow module run agent tasks? Agent tasks carry a
 * `prompt` (or `agent`/`codexGoal`-style helper) while deterministic tasks use
 * `computeFn`/`staticPayload` only.
 *
 * @param {string} workflowSource
 * @returns {boolean}
 */
export function workflowHasAgentTasks(workflowSource) {
    const code = maskWorkflowSyntax(workflowSource);
    for (const task of jsxOpeningElements(code, "Task")) {
        if (/\b(?:agent|prompt)\s*=/.test(task) || /\b(?:codexGoal|claudeGoal|agentGoal)\b/.test(task)) {
            return true;
        }
    }
    return /\b(?:codexGoal|claudeGoal|agentGoal)\s*\(/.test(code);
}

/** Mask quoted text/comments first, then regex literals without confusing JSX closing tags. */
function maskWorkflowSyntax(source) {
    const quoted = stripComments(source).replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/gs, (literal) => literal.replace(/[^\n]/g, " "));
    const result = quoted;
    return result.replace(/(^|[=(:,!&|?{};\n]|\breturn\s+)\/(?:\\.|[^/\\\n\[]|\[[^\]]*\])+\/[dgimsuvy]*/gm, (literal, prefix) => prefix + literal.slice(prefix.length).replace(/[^\n]/g, " "));
}

/** @param {string} source @param {string[]} names @returns {Array<{local: string, member?: string}>} */
function importedBindings(source, names) {
    const bindings = [];
    const syntax = maskStringsAndComments(source);
    const modulesFor = (name) => name === "createGatewayReactRoot"
        ? ["smithers-orchestrator/gateway-react", "@smithers-orchestrator/gateway-react"]
        : ["smithers-orchestrator/gateway-ui", "@smithers-orchestrator/gateway-ui"];
    for (const match of source.matchAll(/\bimport\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']/g)) {
        if (!names.some((name) => modulesFor(name).includes(match[2]))) continue;
        for (const specifier of match[1].split(",")) {
            const parts = specifier.trim().split(/\s+as\s+/);
            if (names.includes(parts[0])) bindings.push({ local: parts[1] || parts[0] });
        }
    }
    for (const match of source.matchAll(/\bimport\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*["']([^"']+)["']/g)) {
        for (const name of names) {
            if (modulesFor(name).includes(match[2])) bindings.push({ local: match[1], member: name });
        }
    }
    return bindings;
}

/** @param {string} source @returns {Array<{index: number, specifier: string}>} */
function moduleSpecifiers(source) {
    const matches = [];
    const trivia = "(?:\\s|/\\*[\\s\\S]*?\\*/)*";
    const fromPattern = new RegExp(`\\b(?:import|export)${trivia}(?!\\()([^"']*?)${trivia}from${trivia}["']([^"']+)["']`, "g");
    const sideEffectPattern = new RegExp(`\\bimport${trivia}["']([^"']+)["']`, "g");
    for (const match of source.matchAll(fromPattern)) matches.push({ index: match.index ?? 0, specifier: match[2] ?? "" });
    for (const match of source.matchAll(sideEffectPattern)) matches.push({ index: match.index ?? 0, specifier: match[1] ?? "" });
    return matches.sort((left, right) => left.index - right.index);
}

/** @param {string} source @param {string} name @returns {boolean} */
function jsxElementIsRendered(source, binding) {
    return jsxOpeningElements(source, binding).length > 0;
}

/** @param {string} source @param {string|{local: string, member?: string}} binding @returns {string[]} */
function jsxOpeningElements(source, binding) {
    const elements = [];
    const resolved = typeof binding === "string" ? { local: binding } : binding;
    const name = resolved.member ? `${escapeRegex(resolved.local)}\\.${escapeRegex(resolved.member)}` : escapeRegex(resolved.local);
    const openingTag = new RegExp(`<${name}(?=[\\s/>])`, "g");
    for (const match of source.matchAll(openingTag)) {
        if (isShadowedAt(source, resolved.local, match.index ?? 0)) continue;
        const start = (match.index ?? 0) + match[0].length;
        const end = jsxOpeningTagEnd(source, start);
        if (end !== -1) elements.push(source.slice(start, end));
    }
    return elements;
}

/**
 * Find the end of a JSX opening element. `>` is only a tag terminator outside
 * quoted attributes and JSX expression containers, so arrows and comparisons
 * inside `{...}` cannot truncate the attribute list.
 *
 * @param {string} source
 * @param {number} start
 * @returns {number}
 */
function jsxOpeningTagEnd(source, start) {
    let braces = 0;
    let quote = null;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
        const char = source[index];
        if (quote) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === quote) quote = null;
            continue;
        }
        if (char === "\"" || char === "'") {
            quote = char;
        } else if (char === "{") {
            braces += 1;
        } else if (char === "}") {
            braces = Math.max(0, braces - 1);
        } else if (char === ">" && braces === 0) {
            return index;
        }
    }
    return -1;
}

/** @param {string} source @param {string} name @returns {boolean} */
function callExpressionExists(source, name) {
    const pattern = name.member
        ? `${escapeRegex(name.local)}\\.${escapeRegex(name.member)}`
        : escapeRegex(name.local);
    const expression = new RegExp(`(?<![A-Za-z0-9_$])${pattern}(?=\\s*\\()`, "g");
    return [...source.matchAll(expression)].some((match) => {
        const position = match.index ?? 0;
        if (!name.member && /(?:\.|\?\.)\s*$/.test(source.slice(0, position))) return false;
        return !isShadowedAt(source, name.local, position);
    });
}

/** @param {string} value */
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Exclude references inside function/arrow scopes that redeclare an import. */
function isShadowedAt(source, name, position) {
    return lexicalScopes(source).some((scope) => position > scope.start && position < scope.end && scope.names.has(name)); /*
    const functionPattern = /(?:function\s+[A-Za-z_$][\w$]*\s*\(|\()([^()]*)\)\s*=>?\s*\{/g;
    for (const match of syntax.matchAll(functionPattern)) {
        if (!match[1].split(",").some((parameter) => new RegExp(`^\\s*(?:\.\.\\.)?${escapeRegex(name)}\\s*$`).test(parameter))) continue;
        const bodyStart = (match.index ?? 0) + match[0].length - 1;
        const bodyEnd = matchingBrace(syntax, bodyStart);
        if (bodyEnd > position) return position > bodyStart;
    }
    */ return false;
}

function lexicalScopes(source) {
    const tokens = [...source.matchAll(/[A-Za-z_$][\w$]*|=>|[{}(),.;]/g)].map((match) => ({ text: match[0], start: match.index ?? 0, end: (match.index ?? 0) + match[0].length }));
    const pairs = new Map();
    const stack = [];
    for (let index = 0; index < tokens.length; index += 1) {
        if (tokens[index].text === "{") stack.push(index);
        else if (tokens[index].text === "}" && stack.length) pairs.set(stack.pop(), index);
    }
    const scopes = [];
    for (const [open, close] of pairs) {
        const names = new Set();
        const previous = tokens[open - 1];
        if (previous?.text === ")") {
            let depth = 1;
            let paren = open - 1;
            while (--paren >= 0) {
                if (tokens[paren].text === ")") depth += 1;
                else if (tokens[paren].text === "(" && --depth === 0) break;
            }
            for (let index = paren + 1; index < open - 1; index += 1) if (/^[A-Za-z_$]/.test(tokens[index].text)) names.add(tokens[index].text);
        } else if (previous?.text === "=>") {
            if (tokens[open - 2] && /^[A-Za-z_$]/.test(tokens[open - 2].text)) names.add(tokens[open - 2].text);
            else if (tokens[open - 2]?.text === ")") {
                let paren = open - 2;
                let depth = 1;
                while (--paren >= 0) {
                    if (tokens[paren].text === ")") depth += 1;
                    else if (tokens[paren].text === "(" && --depth === 0) break;
                }
                for (let index = paren + 1; index < open - 2; index += 1) if (/^[A-Za-z_$]/.test(tokens[index].text)) names.add(tokens[index].text);
            }
        }
        let nested = 0;
        for (let index = open + 1; index < close; index += 1) {
            if (tokens[index].text === "{") nested += 1;
            else if (tokens[index].text === "}") nested -= 1;
            else if (nested === 0 && ["const", "let", "var", "function", "class"].includes(tokens[index].text) && tokens[index + 1] && /^[A-Za-z_$]/.test(tokens[index + 1].text)) names.add(tokens[index + 1].text);
        }
        if (names.size) scopes.push({ start: tokens[open].start, end: tokens[close].end, names });
    }
    for (let index = 0; index < tokens.length; index += 1) {
        if (tokens[index].text !== "=>") continue;
        const names = new Set();
        if (tokens[index - 1]?.text === ")") {
            let paren = index - 1;
            let depth = 1;
            while (--paren >= 0) {
                if (tokens[paren].text === ")") depth += 1;
                else if (tokens[paren].text === "(" && --depth === 0) break;
            }
            for (let cursor = paren + 1; cursor < index - 1; cursor += 1) if (/^[A-Za-z_$]/.test(tokens[cursor].text)) names.add(tokens[cursor].text);
        } else if (tokens[index - 1] && /^[A-Za-z_$]/.test(tokens[index - 1].text)) names.add(tokens[index - 1].text);
        if (names.size) {
            const end = tokens.slice(index + 1).find((token) => token.text === ";")?.start ?? source.length;
            scopes.push({ start: tokens[index].end, end, names });
        }
    }
    return scopes;
}

/** @param {string} source @param {number} start */
function matchingBrace(source, start) {
    let depth = 0;
    for (let index = start; index < source.length; index += 1) {
        if (source[index] === "{") depth += 1;
        else if (source[index] === "}" && --depth === 0) return index;
    }
    return source.length;
}

/**
 * Strip line/block comments so commented-out code and prose (which may
 * legitimately mention hex colors or `<table>`) never trip the rules.
 *
 * @param {string} source
 */
function stripComments(source) {
    let result = "";
    let state = "code";
    let regexClass = false;
    let escaped = false;
    for (let index = 0; index < source.length; index += 1) {
        const char = source[index];
        const next = source[index + 1];
        if (state === "\"" || state === "'" || state === "`") {
            result += char;
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === state) state = "code";
            continue;
        }
        if (state === "regex") {
            result += char;
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === "[") regexClass = true;
            else if (char === "]") regexClass = false;
            else if (char === "/" && !regexClass) state = "code";
            continue;
        }
        if (state === "code" && char === "/" && next === "*") { state = "block"; result += "  "; index += 1; continue; }
        if (state === "code" && char === "/" && next === "/") { state = "line"; result += "  "; index += 1; continue; }
        if (state === "block") { result += char === "\n" ? "\n" : " "; if (char === "*" && next === "/") { result += " "; index += 1; state = "code"; } continue; }
        if (state === "line") { if (char === "\n") { result += "\n"; state = "code"; } else result += " "; continue; }
        result += char;
        if (char === "\"" || char === "'" || char === "`") state = char;
        else if (char === "/" && isRegexStart(result.slice(0, -1))) {
            state = "regex";
            regexClass = false;
            escaped = false;
        }
    }
    return result;
}

/** JavaScript's slash is a regex after an expression-starting token. */
function isRegexStart(prefix) {
    const trimmed = prefix.trimEnd();
    if (!trimmed) return true;
    const last = trimmed.at(-1);
    if (/[([{=,:;!?&|+*%^~\-]/.test(last)) return true;
    const word = trimmed.match(/[A-Za-z_$][\w$]*$/)?.[0];
    return ["return", "case", "throw", "else", "do", "in", "of", "typeof", "void", "delete", "new", "yield", "await"].includes(word);
}

/** Replace strings and comments with whitespace while preserving syntax layout. */
function maskStringsAndComments(source) {
    let result = "";
    let state = "code";
    let regexClass = false;
    let escaped = false;
    let quote = "\"";
    for (let index = 0; index < source.length; index += 1) {
        const char = source[index];
        const next = source[index + 1];
        if (state === "line") {
            result += char === "\n" ? "\n" : " ";
            if (char === "\n") state = "code";
        } else if (state === "block") {
            result += char === "\n" ? "\n" : " ";
            if (char === "*" && next === "/") { result += " "; index += 1; state = "code"; }
        } else if (state === "regex") {
            if (escaped) { escaped = false; result += " "; }
            else if (char === "\\") { escaped = true; result += " "; }
            else if (char === "[") { regexClass = true; result += " "; }
            else if (char === "]") { regexClass = false; result += " "; }
            else if (char === "/" && !regexClass) { result += "/"; state = "code"; }
            else result += char === "\n" ? "\n" : " ";
        } else if (state === "string" || state === "template") {
            // Keep the closing delimiter in the mask: a later `/` must see the
            // quote (an expression end), not whatever preceded the literal, or
            // it gets mis-lexed as a regex start (e.g. after `title="x"` in JSX).
            if (escaped) { escaped = false; result += " "; }
            else if (char === "\\") { escaped = true; result += " "; }
            else if ((state === "string" && char === quote) || (state === "template" && char === "`")) { result += char; state = "code"; }
            else result += char === "\n" ? "\n" : " ";
        } else if (char === "/" && next === "*") {
            result += "  "; index += 1; state = "block";
        } else if (char === "/" && next === "/") {
            result += "  "; index += 1; state = "line";
        } else if (char === "\"" || char === "'") {
            result += char;
            quote = char;
            state = "string";
        } else if (char === "`") {
            result += char;
            state = "template";
        } else if (char === "/" && next !== ">" && isRegexStart(result)) {
            state = "regex";
            regexClass = false;
            escaped = false;
            result += "/";
        } else result += char;
    }
    return result;
}

/**
 * Scorer wrapper: expects `output` to be the generated UI source text (string
 * or `{ uiSource, workflowSource? }`), grades it with
 * {@link gradeWorkflowUiSource}, and reports the violations as the reason.
 */
export const workflowUiComplianceScorer = createScorer({
    id: "workflow-ui-compliance",
    name: "Workflow UI compliance",
    description: "Generated workflow UI composes the shipped design system (shell, pills, tables) and surfaces live agent chat via NodeChatStream.",
    score: async ({ output }) => {
        const payload = typeof output === "string" ? { uiSource: output } : /** @type {{ uiSource?: unknown, workflowSource?: unknown }} */ (output ?? {});
        const uiSource = typeof payload.uiSource === "string" ? payload.uiSource : "";
        if (!uiSource) {
            return { score: 0, reason: "No UI source to grade." };
        }
        const report = gradeWorkflowUiSource(uiSource, {
            ...(typeof payload.workflowSource === "string" ? { workflowSource: payload.workflowSource } : {}),
        });
        return {
            score: report.score,
            reason: report.passed
                ? "UI composes the shipped design system."
                : report.violations.map((violation) => `[${violation.rule}] ${violation.detail}`).join(" "),
            meta: { violations: report.violations },
        };
    },
});
