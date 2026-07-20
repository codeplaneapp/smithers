import { Hono } from "hono";

/**
 * @typedef {{
 *   pathname: string;
 *   mountPath: string;
 *   assetPath: string | null;
 *   config: Record<string, unknown>;
 * }} GatewayUiMatch
 */

/**
 * @param {{
 *   resolveMatch: (pathname: string) => GatewayUiMatch | null;
 *   renderIndex: (match: GatewayUiMatch) => string;
 *   renderAsset: (match: GatewayUiMatch) => Promise<{ body: string; contentType: string } | null>;
 * }} options
 */
export function createGatewayUiApp(options) {
    const app = new Hono();
    app.get("*", async (c) => {
        const url = new URL(c.req.url);
        const match = options.resolveMatch(url.pathname);
        if (!match) {
            return new Response("Not Found", {
                status: 404,
                headers: { "x-smithers-ui-miss": "1" },
            });
        }
        if (match.assetPath) {
            const asset = await options.renderAsset(match);
            if (!asset) {
                return c.text("Not Found", 404);
            }
            return c.body(asset.body, 200, {
                "Content-Type": asset.contentType,
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            });
        }
        return c.html(options.renderIndex(match), 200, {
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        });
    });
    return app;
}
