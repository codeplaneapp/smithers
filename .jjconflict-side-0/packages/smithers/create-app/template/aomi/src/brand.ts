import type { Brand, NavGroup } from "@smthrs/create-app/app"

// Aomi design tokens, vendored from apps/build/src/app/aomi-design-tokens.css
// in the aomi repo (aomi-design commit 01f0bd72). Values are mapped onto the
// @smthrs/ui house tokens by CreateApp; anything not listed keeps the
// styleguide default.
export const aomiBrand: Brand = {
  name: "aomi",
  wordmark: "aomi",
  theme: "light",
  fonts: {
    display: "\"PT Serif\", ui-serif, Georgia, Cambria, serif",
    body: "\"Geist\", ui-sans-serif, system-ui, sans-serif",
    mono: "\"Geist Mono\", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    wordmark: "\"Source Serif 4\", \"PT Serif\", serif",
    googleFonts: ["PT+Serif:wght@400;700", "Geist:wght@400;500;600", "Geist+Mono:wght@400;500", "Source+Serif+4:wght@600"]
  },
  tokens: {
    // ink (primary is ink, not blue)
    primary: "#09090b",
    primaryHover: "#27272a",
    primaryActive: "#3f3f46",
    primarySubtle: "#f4f4f5",
    // sky ramp: the selected-nav blue
    accent: "#5288c2",
    accentForeground: "#ffffff",
    accentSubtle: "#e2eef8",
    accentRing: "#5288c2",
    // lilac secondary
    secondary: "#9c83a8",
    secondarySubtle: "#efe9f1",
    // status
    success: "#2e9e6b",
    successSubtle: "#e4f3ec",
    warning: "#d9982b",
    danger: "#d2495b",
    info: "#416cac",
    // neutrals (zinc + aomi off-stops)
    background: "#ffffff",
    surface: "#fafafa",
    surfaceRaised: "#ffffff",
    border: "#e9e9ec",
    borderStrong: "#d4d4d8",
    foreground: "#09090b",
    foregroundMuted: "#71717a",
    foregroundSubtle: "#a1a1aa",
    // radius + shadow
    radiusSm: "0.5rem",
    radiusMd: "0.75rem",
    radiusLg: "1rem",
    radiusXl: "1.5rem",
    radiusComposer: "1.875rem",
    radiusPill: "9999px",
    shadowSm: "0 1px 2px rgba(13,13,15,.04)",
    shadowMd: "0 4px 16px rgba(13,13,15,.06)",
    shadowLg: "0 12px 40px rgba(13,13,15,.1)"
  }
}

// The sidebar from the aomi Build page (control-plane-shell.tsx navGroups).
// Hrefs are app routes; each has an app/<route>/page.tsx.
export const aomiNav: ReadonlyArray<NavGroup> = [
  {
    label: "Overview",
    items: [
      { label: "Overview", href: "/overview", icon: "home" },
      { label: "Projects", href: "/projects", icon: "folder-kanban" }
    ]
  },
  {
    label: "Build",
    items: [{ label: "Build", href: "/build", icon: "hammer" }]
  },
  {
    label: "Operate",
    items: [
      { label: "Deployments", href: "/operate/deployments", icon: "rocket" },
      { label: "Transactions", href: "/operate/transactions", icon: "wallet-cards" },
      { label: "Observability", href: "/operate/observability", icon: "activity" },
      { label: "Usage", href: "/operate/usage", icon: "gauge" },
      { label: "Logs", href: "/operate/logs", icon: "scroll-text" }
    ]
  },
  {
    label: "Account",
    items: [
      { label: "Providers", href: "/providers", icon: "key-round" },
      { label: "Integrations", href: "/integrations", icon: "plug" },
      { label: "Settings", href: "/settings", icon: "settings" }
    ]
  }
]

// Build page content (features/build/templates.ts + build-view.tsx).
export const actionPills = [
  { label: "Arb bot", action: "tpl_arbitrage_bot" },
  { label: "OpenAPI agent", action: "tpl_openapi_agent" },
  { label: "Plan from idea", hint: "⇧Tab", action: "plan" }
] as const

export const featuredTemplateIds = ["tpl_arbitrage_bot", "tpl_openapi_agent", "tpl_trading_agent"] as const

export const buildTemplates = [
  { id: "tpl_arbitrage_bot", title: "Arbitrage Bot", category: "trading", description: "Multi-venue arbitrage with execution and risk guardrails.", prompt: "I wanna build a hyperliquid & binance arb bot with risk limits and paper-trade first." },
  { id: "tpl_trading_agent", title: "Trading Agent", category: "trading", description: "Cross-exchange strategy runner with risk controls and wallet ops.", prompt: "Build a cross-exchange trading agent with a max drawdown guard and a wallet for settlement." },
  { id: "tpl_telegram_bot", title: "Telegram Bot", category: "social", description: "Auto-responding command bot with deployment and alert hooks.", prompt: "Build a Telegram bot that answers /status and alerts me when a position moves 5%." },
  { id: "tpl_openapi_agent", title: "OpenAPI Agent", category: "infra", description: "Wrap REST APIs as agent-callable tools from OpenAPI specs.", prompt: "Wrap this OpenAPI spec as agent tools and answer questions with it." },
  { id: "tpl_mcp_server", title: "MCP Server", category: "infra", description: "Tool interface with secure command rules and middleware.", prompt: "Expose my chain tools as an MCP server with an allowlist." },
  { id: "tpl_wallet_agent", title: "Wallet Agent", category: "trading", description: "Non-custodial wallet ops with simulation and batch signing.", prompt: "Build a wallet agent that simulates every transaction on a fork before signing." },
  { id: "tpl_rag_agent", title: "RAG Agent", category: "research", description: "Retrieval pipeline for docs, embeddings, and grounded chat.", prompt: "Build a RAG agent over my protocol docs." },
  { id: "tpl_discord_bot", title: "Discord Bot", category: "social", description: "Moderation and command bot with webhook integrations.", prompt: "Build a Discord bot with moderation commands and a webhook for deploy notices." }
] as const
