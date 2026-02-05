import { writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

const piAiOauth = join(root, "node_modules/@mariozechner/pi-ai/dist/utils/oauth/index.js");
const piWebUiIndex = join(root, "node_modules/@mariozechner/pi-web-ui/dist/index.js");
const piWebUiModelDiscovery = join(root, "node_modules/@mariozechner/pi-web-ui/dist/utils/model-discovery.js");

const piAiOauthStub = `// Browser-safe OAuth stubs for Smithers desktop build
// Anthropic
export { loginAnthropic, refreshAnthropicToken } from "./anthropic.js";
// GitHub Copilot
export { getGitHubCopilotBaseUrl, loginGitHubCopilot, normalizeDomain, refreshGitHubCopilotToken } from "./github-copilot.js";
// Google Antigravity (browser stub)
export async function loginAntigravity() { throw new Error("Antigravity OAuth is not available in the webview."); }
export async function refreshAntigravityToken() { throw new Error("Antigravity OAuth is not available in the webview."); }
// Google Gemini CLI (browser stub)
export async function loginGeminiCli() { throw new Error("Gemini CLI OAuth is not available in the webview."); }
export async function refreshGoogleCloudToken() { throw new Error("Gemini CLI OAuth is not available in the webview."); }
export * from "./types.js";
import { refreshAnthropicToken } from "./anthropic.js";
import { refreshGitHubCopilotToken } from "./github-copilot.js";
const refreshAntigravityTokenImpl = async () => { throw new Error("Antigravity OAuth is not available in the webview."); };
const refreshGoogleCloudTokenImpl = async () => { throw new Error("Gemini CLI OAuth is not available in the webview."); };
export async function refreshOAuthToken(provider, credentials) {
  if (!credentials) throw new Error(`No OAuth credentials found for ${provider}`);
  let newCredentials;
  switch (provider) {
    case "anthropic":
      newCredentials = await refreshAnthropicToken(credentials.refresh);
      break;
    case "github-copilot":
      newCredentials = await refreshGitHubCopilotToken(credentials.refresh, credentials.enterpriseUrl);
      break;
    case "google-gemini-cli":
      if (!credentials.projectId) throw new Error("Google Cloud credentials missing projectId");
      newCredentials = await refreshGoogleCloudTokenImpl(credentials.refresh, credentials.projectId);
      break;
    case "google-antigravity":
      if (!credentials.projectId) throw new Error("Antigravity credentials missing projectId");
      newCredentials = await refreshAntigravityTokenImpl(credentials.refresh, credentials.projectId);
      break;
    default:
      throw new Error(`Unknown OAuth provider: ${provider}`);
  }
  return newCredentials;
}
export async function getOAuthApiKey(provider, credentials) {
  let creds = credentials[provider];
  if (!creds) return null;
  if (Date.now() >= creds.expires) {
    try {
      creds = await refreshOAuthToken(provider, creds);
    } catch {
      throw new Error(`Failed to refresh OAuth token for ${provider}`);
    }
  }
  if (provider === "google-gemini-cli" || provider === "google-antigravity") {
    return JSON.stringify({ token: creds.access, projectId: creds.projectId });
  }
  return creds.access;
}
`;

const piWebUiIndexSlim = `// Slim export surface for Smithers desktop build
export { Agent } from "./agent/agent.js";
export { ChatPanel } from "./ChatPanel.js";
export { getMessageRenderer, registerMessageRenderer, renderMessage } from "./components/message-renderer-registry.js";
`;

const modelDiscoveryStub = `// Browser-safe stubs for Smithers desktop build
export async function discoverOllamaModels() { return []; }
export async function discoverLlamaCppModels() { return []; }
export async function discoverVLLMModels() { return []; }
export async function discoverLMStudioModels() { return []; }
export async function discoverModels() { return []; }
`;

writeFileSync(piAiOauth, piAiOauthStub, "utf8");
writeFileSync(piWebUiIndex, piWebUiIndexSlim, "utf8");
writeFileSync(piWebUiModelDiscovery, modelDiscoveryStub, "utf8");

console.log("Patched vendor modules for browser bundling.");
