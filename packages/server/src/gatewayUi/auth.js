/**
 * @param {{
 *   match: { config: { kind: string; config: Record<string, unknown> } };
 *   authMode: string;
 *   token: string | null;
 *   authenticate: (token: string | null) => Promise<{ ok: true } | { ok: false; code: string; message: string; details?: Record<string, unknown> }>;
 * }} options
 */
export async function authorizeGatewayUiRequest(options) {
    const isBuiltinOperator = options.match.config.config.builtin === "operator";
    if (!isBuiltinOperator || options.authMode === "none") {
        return null;
    }
    const authResult = await options.authenticate(options.token);
    return authResult.ok === false ? authResult : null;
}
