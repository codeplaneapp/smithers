import { confirm, intro, isCancel, note, outro, password, select, spinner, text } from "@clack/prompts";
import { defaultConfigDir } from "@smithers-orchestrator/accounts";
import { runAgentAdd, pingAccount } from "./runAgentAdd.js";

/** @typedef {import("@smithers-orchestrator/accounts").AccountProvider} AccountProvider */

const PROVIDER_CHOICES = [
    { value: "claude-code", label: "Claude Code (subscription)", hint: "Pro / Max plan via `claude` CLI" },
    { value: "codex", label: "Codex (subscription)", hint: "ChatGPT Plus/Pro via `codex` CLI" },
    { value: "gemini", label: "Gemini (subscription)", hint: "Google account via `gemini` CLI" },
    { value: "kimi", label: "Kimi (subscription)", hint: "OAuth via `kimi` CLI" },
    { value: "anthropic-api", label: "Anthropic API key", hint: "Pay-per-token via api.anthropic.com" },
    { value: "openai-api", label: "OpenAI API key", hint: "Pay-per-token via api.openai.com (used by Codex)" },
    { value: "gemini-api", label: "Gemini API key", hint: "Pay-per-token via Google AI Studio" },
];

const SUBSCRIPTION_LOGIN_BIN = {
    "claude-code": "claude",
    "codex": "codex",
    "gemini": "gemini",
    "kimi": "kimi",
};

const SUBSCRIPTION_DIR_ENV_VAR = {
    "claude-code": "CLAUDE_CONFIG_DIR",
    "codex": "CODEX_HOME",
    "gemini": "GEMINI_DIR",
    "kimi": "KIMI_SHARE_DIR",
};

/**
 * Provider-specific login command + on-screen instructions. Some CLIs use a
 * dedicated subcommand (`codex login`, `kimi login`); others authenticate via
 * a slash command inside the REPL (`claude` then /login).
 *
 * @type {Record<string, { args: string[]; postInstructions?: string }>}
 */
const SUBSCRIPTION_LOGIN_RECIPE = {
    "claude-code": { args: [], postInstructions: "Inside Claude Code, type /login and follow the browser flow." },
    "codex": { args: ["login"] },
    "gemini": { args: [], postInstructions: "Inside Gemini, type /auth (or follow the prompt) to sign in." },
    "kimi": { args: ["login"] },
};

function bail() {
    outro("Cancelled.");
    process.exit(130);
}

/**
 * Interactive `smithers agents add` wizard. Loops until the user is done
 * adding accounts. Returns the list of labels that were added in this session.
 *
 * @param {{ env?: NodeJS.ProcessEnv; cwd?: string; loop?: boolean; skipIntro?: boolean }} [opts]
 * @returns {Promise<string[]>}
 */
export async function agentAddWizard(opts = {}) {
    const env = opts.env ?? process.env;
    const cwd = opts.cwd ?? process.cwd();
    if (!opts.skipIntro) intro("Add a Smithers agent account");
    /** @type {string[]} */
    const added = [];
    while (true) {
        const provider = await select({
            message: "Which provider?",
            options: PROVIDER_CHOICES,
        });
        if (isCancel(provider)) bail();
        const label = await text({
            message: "Label this account",
            placeholder: provider === "claude-code" ? "claude-work" : `${provider}-1`,
            validate(value) {
                if (!value || !value.trim()) return "Label cannot be empty";
                if (!/^[A-Za-z0-9._-]+$/.test(value)) return "Use letters, digits, '.', '_' or '-'";
            },
        });
        if (isCancel(label)) bail();
        const isSubscription = SUBSCRIPTION_LOGIN_BIN[provider] !== undefined;
        /** @type {string | undefined} */
        let configDir;
        /** @type {string | undefined} */
        let apiKey;
        if (isSubscription) {
            const useDefault = await confirm({
                message: `Store credentials at the default location (~/.smithers/accounts/${label})?`,
                initialValue: true,
            });
            if (isCancel(useDefault)) bail();
            if (useDefault) {
                configDir = defaultConfigDir(label, env);
            }
            else {
                const customDir = await text({
                    message: "Path to existing CLI config dir (e.g. ~/.claude or ~/.codex)",
                    validate(value) {
                        if (!value || !value.trim()) return "Path cannot be empty";
                    },
                });
                if (isCancel(customDir)) bail();
                configDir = customDir.replace(/^~(?=\/|$)/, env.HOME ?? "");
            }
            const bin = SUBSCRIPTION_LOGIN_BIN[provider];
            const envVar = SUBSCRIPTION_DIR_ENV_VAR[provider];
            const recipe = SUBSCRIPTION_LOGIN_RECIPE[provider] ?? { args: [] };
            const loginCmd = `${envVar}=${configDir} ${bin}${recipe.args.length ? " " + recipe.args.join(" ") : ""}`;
            const lines = [
                "Open another terminal and run:",
                "",
                `  ${loginCmd}`,
            ];
            if (recipe.postInstructions) {
                lines.push("", recipe.postInstructions);
            }
            lines.push("", "Come back here once you're done.");
            note(lines.join("\n"), "Log in");
            const ready = await confirm({
                message: "Logged in?",
                initialValue: true,
            });
            if (isCancel(ready)) bail();
            // Trust the user: if they say they logged in, register without
            // re-checking the dir. We surface success/failure via a ping below.
            const sp = spinner();
            sp.start("Registering account…");
            const result = runAgentAdd({
                provider: /** @type {AccountProvider} */ (provider),
                label,
                configDir,
                env,
                cwd,
                skipLogin: true,
            });
            if (!result.ok) {
                sp.stop(`Could not register: ${result.reason}`);
                note(result.detail ?? "");
            }
            else {
                sp.stop(`Registered ${result.account.label} (${result.account.provider}).`);
                added.push(result.account.label);
                if (result.regen?.rewritten) note(`Updated ${result.regen.path}`, ".smithers/agents.ts");
                if (ready) {
                    const ping = pingAccount(result.account);
                    if (ping.ran) {
                        const status = ping.exitCode === 0 ? "OK" : `non-zero exit (${ping.exitCode ?? "?"})`;
                        note(`${ping.cmd}\n→ ${status}`, "Ping");
                    }
                }
                else {
                    note(`Registered without verifying. Run \`smithers agents test ${result.account.label}\` after logging in.`);
                }
            }
        }
        else {
            const key = await password({
                message: "Paste your API key (kept locally in ~/.smithers/accounts.json, mode 0600)",
                validate(value) {
                    if (!value) return "API key cannot be empty";
                },
            });
            if (isCancel(key)) bail();
            apiKey = key;
            const sp = spinner();
            sp.start("Registering account…");
            const result = runAgentAdd({
                provider: /** @type {AccountProvider} */ (provider),
                label,
                apiKey,
                env,
                cwd,
            });
            if (!result.ok) {
                sp.stop(`Could not register: ${result.reason}`);
                note(result.detail ?? "");
            }
            else {
                sp.stop(`Registered ${result.account.label} (${result.account.provider}).`);
                added.push(result.account.label);
                if (result.regen?.rewritten) note(`Updated ${result.regen.path}`, ".smithers/agents.ts");
            }
        }
        if (!opts.loop) break;
        const another = await confirm({
            message: "Add another account?",
            initialValue: false,
        });
        if (isCancel(another) || !another) break;
    }
    if (!opts.skipIntro) outro(`Added ${added.length} account(s).`);
    return added;
}
