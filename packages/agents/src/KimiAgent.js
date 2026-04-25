import { mkdtempSync, cpSync, existsSync, readFileSync, writeFileSync, readdirSync, rmSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { BaseCliAgent, pushFlag, pushList, isRecord, asString, toolKindFromName, createSyntheticIdGenerator, } from "./BaseCliAgent/index.js";
import { normalizeCapabilityStringList, } from "./capability-registry/index.js";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";

/**
 * The kimi CLI's OAuth refresh endpoint, mirroring the Python implementation
 * in `kimi_cli.auth.oauth.refresh_token`. Honour the same env-var override
 * the CLI uses (KIMI_OAUTH_HOST) so test/staging overrides keep working.
 */
function kimiOAuthHost() {
    return process.env.KIMI_OAUTH_HOST?.replace(/\/+$/, "") || "https://auth.kimi.com";
}

/**
 * Process-level dedup map: if multiple parallel KimiAgent invocations land in
 * the refresh path concurrently, share one in-flight Promise so we issue a
 * single POST instead of racing (kimi rotates refresh tokens — only one
 * refresh wins, the other gets invalid_grant and would be wrongly classified
 * as expired).
 *
 * @type {Map<string, Promise<void>>}
 */
const inflightRefreshes = new Map();

async function refreshKimiTokenIfNeeded(credsDir, fileName) {
    const path = join(credsDir, fileName);
    /** @type {{access_token?: string, refresh_token?: string, expires_at?: number, token_type?: string, scope?: string} | null} */
    let data = null;
    try {
        data = JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        return { ok: false, reason: "unreadable", expiredAt: null };
    }
    if (!data || typeof data.expires_at !== "number") {
        // Not an OAuth file — leave alone, kimi will handle.
        return { ok: true, refreshed: false };
    }
    // Refresh proactively a bit before expiry to avoid races (matches the
    // CLI's _refresh_threshold behaviour, simplified to a fixed 60s window).
    const nowSec = Date.now() / 1000;
    if (data.expires_at - 60 > nowSec) {
        return { ok: true, refreshed: false };
    }
    if (typeof data.refresh_token !== "string" || data.refresh_token.length === 0) {
        return { ok: false, reason: "no-refresh-token", expiredAt: new Date(data.expires_at * 1000).toISOString() };
    }
    // Dedupe concurrent refreshes per-credential-file within this process.
    const flightKey = path;
    const inflight = inflightRefreshes.get(flightKey);
    if (inflight) {
        try {
            await inflight;
            return { ok: true, refreshed: true, deduped: true };
        }
        catch (err) {
            return { ok: false, reason: err?.message ?? "refresh-failed", expiredAt: new Date(data.expires_at * 1000).toISOString() };
        }
    }
    const refresher = (async () => {
        const tokenUrl = `${kimiOAuthHost()}/api/oauth/token`;
        // client_id matches kimi_cli.auth.oauth.KIMI_CODE_CLIENT_ID. Without it the
        // /api/oauth/token endpoint returns 400 invalid_request.
        const body = new URLSearchParams({
            client_id: "17e5f671-d194-4dfb-9706-5516cb48c098",
            grant_type: "refresh_token",
            refresh_token: data.refresh_token,
        });
        // Mirror kimi-cli's `_common_headers()` so the auth service treats this
        // refresh as coming from a legitimate kimi-cli install. Some of these
        // (notably X-Msh-Device-Id) appear to gate refresh acceptance.
        const headers = {
            "Content-Type": "application/x-www-form-urlencoded",
            "X-Msh-Platform": "kimi_cli",
            "X-Msh-Version": "1.37.0",
            "X-Msh-Device-Name": "smithers-orchestrator",
            "X-Msh-Device-Model": "smithers-orchestrator",
            "X-Msh-Os-Version": process.platform,
        };
        try {
            const deviceIdPath = join(credsDir, "..", "device_id");
            if (existsSync(deviceIdPath)) {
                const deviceId = readFileSync(deviceIdPath, "utf8").trim();
                if (deviceId)
                    headers["X-Msh-Device-Id"] = deviceId;
            }
        }
        catch { /* device-id is optional */ }
        const resp = await fetch(tokenUrl, {
            method: "POST",
            headers,
            body,
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => "");
            const tag = resp.status === 401 ? "invalid_grant" : `http-${resp.status}`;
            throw new Error(`kimi oauth refresh failed (${tag}): ${text.slice(0, 200)}`);
        }
        /** @type {any} */
        const fresh = await resp.json();
        if (typeof fresh?.access_token !== "string") {
            throw new Error("kimi oauth refresh: missing access_token in response");
        }
        const expiresIn = typeof fresh.expires_in === "number"
            ? fresh.expires_in
            : 3600;
        const merged = {
            ...data,
            access_token: fresh.access_token,
            refresh_token: typeof fresh.refresh_token === "string" ? fresh.refresh_token : data.refresh_token,
            token_type: typeof fresh.token_type === "string" ? fresh.token_type : data.token_type,
            scope: typeof fresh.scope === "string" ? fresh.scope : data.scope,
            expires_in: expiresIn,
            expires_at: Math.floor(Date.now() / 1000) + expiresIn,
        };
        // Write atomically so kimi-cli reading concurrently never sees a torn file.
        const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
        writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
        renameSync(tmp, path);
    })();
    inflightRefreshes.set(flightKey, refresher);
    try {
        await refresher;
        return { ok: true, refreshed: true };
    }
    catch (err) {
        return { ok: false, reason: err?.message ?? "refresh-failed", expiredAt: new Date(data.expires_at * 1000).toISOString() };
    }
    finally {
        inflightRefreshes.delete(flightKey);
    }
}

/**
 * Inspect the kimi CLI's on-disk OAuth credentials and, if any are expired,
 * attempt a non-interactive refresh against `${KIMI_OAUTH_HOST or
 * https://auth.kimi.com}/api/oauth/token` using the stored refresh_token.
 * Only if refresh fails do we surface a clear, non-retryable
 * AGENT_CONFIG_INVALID error.
 *
 * @param {string} shareDir
 * @param {string} agentId
 * @param {string} agentModel
 */
async function ensureKimiCredentialsUsable(shareDir, agentId, agentModel) {
    const credsDir = join(shareDir, "credentials");
    if (!existsSync(credsDir))
        return; // No creds dir → kimi will print "LLM not set" which the BaseCliAgent classifier handles.
    let entries;
    try {
        entries = readdirSync(credsDir);
    }
    catch {
        return;
    }
    const tokenFiles = entries.filter((n) => n.endsWith(".json"));
    if (tokenFiles.length === 0)
        return;
    let lastFailure = null;
    let anyUsable = false;
    for (const name of tokenFiles) {
        const result = await refreshKimiTokenIfNeeded(credsDir, name);
        if (result.ok) {
            anyUsable = true;
        }
        else {
            lastFailure = result;
        }
    }
    if (!anyUsable && lastFailure) {
        const reason = lastFailure.reason === "no-refresh-token"
            ? `OAuth token expired at ${lastFailure.expiredAt} and no refresh_token is stored`
            : `OAuth token expired at ${lastFailure.expiredAt}; auto-refresh failed: ${lastFailure.reason}`;
        throw new SmithersError("AGENT_CONFIG_INVALID", `${reason}. Run \`kimi login\` to re-authenticate, then resume the run. (agent="${agentId}", model="${agentModel}", credentials="${credsDir}")`, {
            failureRetryable: false,
            agentId,
            agentEngine: "kimi",
            agentModel,
            command: "kimi",
            underlying: reason,
        });
    }
}
/** @typedef {import("./BaseCliAgent/BaseCliAgentOptions.ts").BaseCliAgentOptions} BaseCliAgentOptions */
/** @typedef {import("./capability-registry/AgentCapabilityRegistry.ts").AgentCapabilityRegistry} AgentCapabilityRegistry */
/** @typedef {import("./BaseCliAgent/CliOutputInterpreter.ts").CliOutputInterpreter} CliOutputInterpreter */
/** @typedef {import("./KimiAgentOptions.ts").KimiAgentOptions} KimiAgentOptions */

function resolveKimiBuiltIns() {
    return ["default"];
}
/**
 * @param {KimiAgentOptions} [opts]
 * @returns {AgentCapabilityRegistry}
 */
export function createKimiCapabilityRegistry(opts = {}) {
    return {
        version: 1,
        engine: "kimi",
        runtimeTools: {},
        mcp: {
            bootstrap: "project-config",
            supportsProjectScope: true,
            supportsUserScope: true,
        },
        skills: {
            supportsSkills: true,
            installMode: "dir",
            smithersSkillIds: normalizeCapabilityStringList(opts.skillsDir ? [`dir:${opts.skillsDir}`] : []),
        },
        humanInteraction: {
            supportsUiRequests: false,
            methods: [],
        },
        builtIns: resolveKimiBuiltIns(),
    };
}
export class KimiAgent extends BaseCliAgent {
    opts;
    capabilities;
    cliEngine = "kimi";
    issuedSessionId;
    /**
   * @param {KimiAgentOptions} [opts]
   */
    constructor(opts = {}) {
        super(opts);
        this.opts = opts;
        this.capabilities = createKimiCapabilityRegistry(opts);
    }
    /**
   * @returns {CliOutputInterpreter}
   */
    createOutputInterpreter() {
        let emittedStarted = false;
        let didEmitCompleted = false;
        let finalAnswer = "";
        const nextSyntheticId = createSyntheticIdGenerator();
        /**
     * @param {string} line
     * @returns {AgentCliEvent[]}
     */
        const parseLine = (line) => {
            const trimmed = line.trim();
            if (!trimmed)
                return [];
            let payload;
            try {
                payload = JSON.parse(trimmed);
            }
            catch {
                return [];
            }
            if (!isRecord(payload))
                return [];
            const role = asString(payload.role);
            const events = [];
            if (!emittedStarted) {
                emittedStarted = true;
                events.push({
                    type: "started",
                    engine: this.cliEngine,
                    title: "Kimi",
                    resume: this.issuedSessionId,
                });
            }
            if (role === "assistant") {
                const content = asString(payload.content);
                if (content) {
                    finalAnswer = content;
                }
                const toolCalls = Array.isArray(payload.tool_calls) ? payload.tool_calls : [];
                for (const toolCall of toolCalls) {
                    if (!isRecord(toolCall))
                        continue;
                    const fn = isRecord(toolCall.function) ? toolCall.function : undefined;
                    const name = asString(fn?.name) ?? "tool";
                    const id = asString(toolCall.id) ?? nextSyntheticId("kimi-tool");
                    events.push({
                        type: "action",
                        engine: this.cliEngine,
                        phase: "started",
                        entryType: "thought",
                        action: {
                            id,
                            kind: toolKindFromName(name),
                            title: name,
                            detail: {
                                arguments: asString(fn?.arguments),
                            },
                        },
                        message: `Running ${name}`,
                        level: "info",
                    });
                }
            }
            if (role === "tool") {
                const id = asString(payload.tool_call_id) ?? nextSyntheticId("kimi-tool");
                events.push({
                    type: "action",
                    engine: this.cliEngine,
                    phase: "completed",
                    entryType: "thought",
                    action: {
                        id,
                        kind: "tool",
                        title: "tool result",
                        detail: {},
                    },
                    message: asString(payload.content),
                    ok: true,
                    level: "info",
                });
            }
            return events;
        };
        return {
            onStdoutLine: parseLine,
            onExit: (result) => {
                if (didEmitCompleted)
                    return [];
                didEmitCompleted = true;
                return [{
                        type: "completed",
                        engine: this.cliEngine,
                        ok: !result.exitCode || result.exitCode === 0,
                        answer: finalAnswer || undefined,
                        error: result.exitCode && result.exitCode !== 0
                            ? result.stderr.trim() || `Kimi exited with code ${result.exitCode}`
                            : undefined,
                        resume: this.issuedSessionId,
                    }];
            },
        };
    }
    /**
   * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any; }} params
   */
    async buildCommand(params) {
        const args = [];
        let commandEnv;
        let cleanup;
        // Isolate kimi metadata per invocation to avoid concurrent writes to
        // ~/.kimi/kimi.json across parallel tasks. If caller explicitly provides
        // KIMI_SHARE_DIR in opts.env, preserve that override.
        const sourceShareDir = this.opts.env?.KIMI_SHARE_DIR ?? process.env.KIMI_SHARE_DIR ?? join(homedir(), ".kimi");
        // Refresh expired OAuth credentials in place using the stored refresh_token,
        // and only fail fast (non-retryable) if the refresh itself fails. This avoids
        // forcing the user to run `kimi login` every time their access_token rotates.
        await ensureKimiCredentialsUsable(sourceShareDir, this.id ?? "<anonymous>", this.opts.model ?? this.model ?? "<unset>");
        if (!this.opts.env?.KIMI_SHARE_DIR) {
            const isolatedShareDir = mkdtempSync(join(tmpdir(), "kimi-share-"));
            if (existsSync(sourceShareDir)) {
                for (const name of ["config.toml", "credentials", "device_id", "latest_version.txt"]) {
                    const src = join(sourceShareDir, name);
                    if (existsSync(src)) {
                        try {
                            cpSync(src, join(isolatedShareDir, name), { recursive: true });
                        }
                        catch {
                            // Best-effort seed only; missing copy should not prevent execution.
                        }
                    }
                }
            }
            commandEnv = { KIMI_SHARE_DIR: isolatedShareDir };
            cleanup = async () => {
                rmSync(isolatedShareDir, { recursive: true, force: true });
            };
        }
        // Print mode is required for non-interactive execution
        // Note: --print implicitly adds --yolo
        args.push("--print");
        // Output format — use text with --final-message-only to get only the
        // model's final response without tool call outputs mixed in.
        const outputFormat = this.opts.outputFormat ??
            (params.options?.onEvent ? "stream-json" : "text");
        pushFlag(args, "--output-format", outputFormat);
        // When using text format, --final-message-only ensures we only get
        // the model's final response, not intermediate tool output.
        const finalMessageOnly = this.opts.finalMessageOnly ?? (outputFormat === "text");
        if (finalMessageOnly)
            args.push("--final-message-only");
        // Other flags
        const resumeSession = typeof params.options?.resumeSession === "string"
            ? params.options.resumeSession
            : undefined;
        const sessionId = resumeSession ?? this.opts.session ?? randomUUID();
        this.issuedSessionId = sessionId;
        pushFlag(args, "--work-dir", this.opts.workDir ?? params.cwd);
        pushFlag(args, "--session", sessionId);
        if (this.opts.continue)
            args.push("--continue");
        pushFlag(args, "--model", this.opts.model ?? this.model);
        const thinking = this.opts.thinking ?? true;
        args.push(thinking ? "--thinking" : "--no-thinking");
        if (this.opts.quiet)
            args.push("--quiet");
        pushFlag(args, "--agent", this.opts.agent);
        pushFlag(args, "--agent-file", this.opts.agentFile);
        pushList(args, "--mcp-config-file", this.opts.mcpConfigFile);
        pushList(args, "--mcp-config", this.opts.mcpConfig);
        pushFlag(args, "--skills-dir", this.opts.skillsDir);
        pushFlag(args, "--max-steps-per-turn", this.opts.maxStepsPerTurn);
        pushFlag(args, "--max-retries-per-step", this.opts.maxRetriesPerStep);
        pushFlag(args, "--max-ralph-iterations", this.opts.maxRalphIterations);
        if (this.opts.verbose)
            args.push("--verbose");
        if (this.opts.debug)
            args.push("--debug");
        if (this.extraArgs?.length)
            args.push(...this.extraArgs);
        // Build prompt with system prompt prepended
        const systemPrefix = params.systemPrompt
            ? `${params.systemPrompt}\n\n`
            : "";
        const jsonReminder = params.prompt?.includes("REQUIRED OUTPUT")
            ? "\n\nREMINDER: Your response MUST end with a ```json code fence containing the required JSON object. Do NOT skip this step — the pipeline will reject your response without it.\n"
            : "";
        const fullPrompt = `${systemPrefix}${params.prompt ?? ""}${jsonReminder}`;
        // Pass prompt via --prompt flag
        pushFlag(args, "--prompt", fullPrompt);
        return {
            command: "kimi",
            args,
            outputFormat,
            env: commandEnv,
            cleanup,
            stdoutBannerPatterns: [/^YOLO mode is enabled\b[^\n]*/gm],
            stdoutErrorPatterns: [
                /^LLM not set/i,
                /^LLM not supported/i,
                /^Max steps reached/i,
                /^Interrupted by user$/i,
                /^Unknown error:/i,
                /^Error:/i,
                // Auth failures kimi prints when OAuth/api-key is invalid or expired.
                // BaseCliAgent's classifyNonRetryableAgentError treats these as
                // non-retryable so the run does not waste turns on a 401 loop.
                /Error code:\s*401\b[^\n]*/i,
                /\binvalid_authentication_error\b/i,
                /API\s*Key\s+appears to be invalid or may have expired/i,
            ],
            // The kimi CLI emits "To resume this session: kimi -r <id>" to stderr
            // on every non-zero exit (it's a hint for interactive users, not the
            // actual error). Strip it so the real underlying error surfaces — and
            // when it's the only stderr content, our runner will fall back to a
            // useful "exited with code N" message that the engine can retry.
            benignStderrPatterns: [
                /^\s*To resume this session: kimi -r [0-9a-f-]+\s*$/gim,
            ],
            errorOnBannerOnly: true,
        };
    }
}
