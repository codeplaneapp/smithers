import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function loadPublishConfig(homeDir = homedir()): { url: string; token: string } {
  let url = process.env.SMITHERS_REVIEW_PUBLISH_URL?.trim() || "";
  let token = process.env.SMITHERS_REVIEW_PUBLISH_TOKEN?.trim() || "";
  if (!url || !token) {
    const path = join(homeDir, ".smithers-review.json");
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { publishUrl?: string; publishToken?: string };
      url = url || raw.publishUrl?.trim() || "";
      token = token || raw.publishToken?.trim() || "";
    }
  }
  if (!url) {
    throw new Error(
      "no publish URL: set SMITHERS_REVIEW_PUBLISH_URL or write ~/.smithers-review.json with { \"publishUrl\": \"...\" }",
    );
  }
  if (!token) {
    throw new Error(
      "no publish token: set SMITHERS_REVIEW_PUBLISH_TOKEN or write ~/.smithers-review.json with { \"publishToken\": \"...\" }",
    );
  }
  return { url: url.replace(/\/$/, ""), token };
}

/** Upload a walkthrough HTML file to the publish service; returns the share URL. */
export async function publishWalkthrough(htmlPath: string, options: { homeDir?: string } = {}): Promise<string> {
  const { url, token } = loadPublishConfig(options.homeDir);
  const html = readFileSync(htmlPath);
  const response = await fetch(`${url}/api/walkthroughs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "text/html; charset=utf-8",
    },
    body: html,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`publish failed: HTTP ${response.status}${detail ? ` ${detail.slice(0, 200)}` : ""}`);
  }
  const data = (await response.json()) as { url?: string };
  if (!data.url) throw new Error("publish failed: response had no url");
  return data.url;
}
