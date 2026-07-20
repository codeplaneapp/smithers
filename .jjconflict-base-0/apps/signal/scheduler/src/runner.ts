import { Container } from "@cloudflare/containers";
import type { Env } from "./env";

function classifyRunFailure(body: Record<string, unknown>): string | null {
  if (body.ok === true) return null;
  const text = Array.isArray(body.errors) ? body.errors.join(" ").toLowerCase() : "";
  if (text.includes("no usable model provider") || text.includes("api key") || text.includes("quota") || text.includes("billing")) return "provider";
  if (text.includes("verification") || text.includes("assert-verified") || text.includes("failed verification")) return "verification";
  if (text.includes("publish") || text.includes("cloudflare") || text.includes("r2") || text.includes("kv")) return "publish";
  if (text.includes("not found") || text.includes("spawn") || text.includes("smithers up exited")) return "runner";
  return "workflow";
}

/** Durable Object binding for apps/signal/runner's Docker image (built from ../../runner/Dockerfile). */
export class Runner extends Container<Env> {
  defaultPort = 8080;
  // A full pipeline run (fetch -> classify -> compose -> verify -> render -> publish) can take
  // several minutes end to end; keep the container warm well past the slowest expected run.
  sleepAfter = "20m";
  envVars = {
    // Optional: SIGNAL_MODEL_PROVIDER's auto mode (default) probes whichever of
    // these are non-empty at run start and falls back in order anthropic ->
    // openai -> gemini (see .smithers/lib/daily-ceo-intel/modelProvider.ts).
    ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY ?? "",
    OPENAI_API_KEY: this.env.OPENAI_API_KEY ?? "",
    GEMINI_API_KEY: this.env.GEMINI_API_KEY ?? "",
    SIGNAL_MODEL_PROVIDER: this.env.SIGNAL_MODEL_PROVIDER ?? "auto",
    CLOUDFLARE_ACCOUNT_ID: this.env.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: this.env.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_KV_NAMESPACE_ID: this.env.CLOUDFLARE_KV_NAMESPACE_ID,
    CLOUDFLARE_R2_BUCKET: this.env.CLOUDFLARE_R2_BUCKET,
    SIGNAL_PUBLISH_MODE: "auto",
  };

  private async alert(message: string): Promise<void> {
    const webhook = this.env.SIGNAL_ALERT_WEBHOOK_URL;
    if (!webhook) return;
    try {
      await fetch(webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `[The Smithers Signal] ${message}` }),
      });
    } catch (error) {
      console.error(`[signal-runner-do] alert webhook delivery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async run(payload: { dateEt: string }): Promise<void> {
    try {
      const response = await this.containerFetch(new Request("http://runner/run", { method: "POST" }));
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      await this.env.SIGNAL_REPORTS.put(
        `run-status:${payload.dateEt}`,
        JSON.stringify({
          ok: body.ok === true,
          httpStatus: response.status,
          published: body.published === true,
          finalizeStatus: typeof body.finalizeStatus === "string" ? body.finalizeStatus : null,
          publishSkipped: typeof body.publishSkippedReason === "string" ? body.publishSkippedReason : null,
          failureDetail: Array.isArray(body.errors)
            ? body.errors.join(" ").slice(-4000)
            : typeof body.error === "string"
              ? body.error.slice(-1000)
              : null,
          failureClass: classifyRunFailure(body),
          cliExitCode: typeof body.cliExitCode === "number" ? body.cliExitCode : null,
          completedAt: new Date().toISOString(),
        }),
        { expirationTtl: 7 * 24 * 60 * 60 },
      );
      if (!response.ok) {
        const message = `run for ${payload.dateEt} failed: HTTP ${response.status}`;
        console.error(`[signal-runner-do] ${message}`);
        await this.alert(message);
      }
    } catch (error) {
      const message = `run for ${payload.dateEt} failed before completion: ${error instanceof Error ? error.message : String(error)}`;
      console.error(`[signal-runner-do] ${message}`);
      await this.alert(message);
      throw error;
    } finally {
      await this.env.SIGNAL_REPORTS.delete(`inflight:${payload.dateEt}`);
    }
  }

  override onError(error: unknown): never {
    console.error("[signal-runner-do] container error:", error);
    throw error;
  }
}
