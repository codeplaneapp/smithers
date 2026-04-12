import { resolve } from "node:path";
export const BUN = Bun.which("bun") ?? process.execPath;
export const TUI_ENTRY = resolve(import.meta.dir, "../../../apps/cli/src/index.js");
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;
class BunSpawnBackend {
    buffer = "";
    proc;
    /**
   * @param {any} proc
   */
    constructor(proc) {
        this.proc = proc;
        this.readStream(this.proc.stdout);
        this.readStream(this.proc.stderr);
    }
    /**
   * @param {ReadableStream<Uint8Array> | null | undefined} stream
   */
    async readStream(stream) {
        if (!stream)
            return;
        try {
            const reader = stream.getReader();
            const decoder = new TextDecoder();
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                this.buffer += decoder.decode(value, { stream: true });
            }
        }
        catch { }
    }
    /**
   * @returns {string}
   */
    getBufferText() {
        return this.buffer.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
    }
    /**
   * @param {string} expected
   * @returns {boolean}
   */
    matchesText(expected) {
        const buffer = this.getBufferText();
        if (buffer.includes(expected))
            return true;
        /**
     * @param {string} value
     */
        const compact = (value) => value.replace(/\s+/g, "");
        return compact(buffer).includes(compact(expected));
    }
    /**
   * @param {string} text
   * @returns {Promise<void>}
   */
    async waitForText(text, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
            if (this.matchesText(text))
                return;
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }
        throw new Error(`waitForText: "${text}" not found within ${timeoutMs}ms.\nBuffer:\n${this.getBufferText()}`);
    }
    /**
   * @param {string} text
   * @returns {Promise<void>}
   */
    async waitForNoText(text, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
            if (!this.matchesText(text))
                return;
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }
        throw new Error(`waitForNoText: "${text}" still present after ${timeoutMs}ms.\nBuffer:\n${this.getBufferText()}`);
    }
    /**
   * @param {string} text
   */
    sendKeys(text) {
        if (this.proc.stdin) {
            if (typeof this.proc.stdin.write === "function") {
                this.proc.stdin.write(text);
            }
            else if (typeof this.proc.stdin.getWriter === "function") {
                const writer = this.proc.stdin.getWriter();
                writer.write(new TextEncoder().encode(text));
                writer.releaseLock();
            }
        }
    }
    /**
   * @returns {string}
   */
    snapshot() {
        return this.getBufferText();
    }
    /**
   * @returns {Promise<void>}
   */
    async terminate() {
        try {
            this.proc.kill();
        }
        catch { }
    }
}
/**
 * @param {string[]} args
 * @param {{ cwd?: string }} [options]
 * @returns {Promise<TUITestInstance>}
 */
export async function launchTUI(args, options = {}) {
    const env = {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        LANG: "en_US.UTF-8",
    };
    const proc = Bun.spawn([BUN, "run", TUI_ENTRY, ...args], {
        cwd: options.cwd,
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
    });
    const backend = new BunSpawnBackend(proc);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return backend;
}
