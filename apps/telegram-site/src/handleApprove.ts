// Reference approval endpoint for the Mini App. The Mini App posts here with
// `Authorization: tma <initData>`; we verify initData server-side and, in a real
// deployment, forward the decision to your Smithers gateway
// (`resolve_approval`) or bot. Here we echo the verified decision so the Mini
// App can confirm — the deployment wiring is the documented follow-up.

import { verifyTelegramInitData } from "./verifyTelegramInitData.ts";

export type ApproveEnv = {
  /** Bot token (Wrangler secret). Approvals are disabled until it is set. */
  TELEGRAM_BOT_TOKEN?: string;
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function handleApprove(request: Request, env: ApproveEnv): Promise<Response> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    return json(503, { error: "not_configured", detail: "Set the TELEGRAM_BOT_TOKEN secret to enable approvals." });
  }
  const [scheme, initData] = (request.headers.get("authorization") ?? "").split(" ");
  if (scheme !== "tma" || !initData) {
    return json(401, { error: "unauthorized", detail: "Expected an 'Authorization: tma <initData>' header." });
  }
  const verified = await verifyTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN, { maxAgeSeconds: 3600 });
  if (!verified.ok) {
    return json(401, { error: "unauthorized", reason: verified.reason });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const decision = body.decision === "approve" ? "approve" : body.decision === "reject" ? "reject" : null;
  if (!decision) {
    return json(400, { error: "bad_request", detail: "decision must be 'approve' or 'reject'." });
  }

  // In production: forward { requestId, decision, approver } to the Smithers
  // gateway resolve_approval (or your bot) here, then return its result.
  return json(200, {
    ok: true,
    decision,
    requestId: typeof body.requestId === "string" ? body.requestId : null,
    approver: verified.initData.user
      ? { id: verified.initData.user.id, username: verified.initData.user.username ?? null }
      : null,
  });
}
