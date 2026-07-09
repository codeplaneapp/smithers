import type { Metadata } from "next";

import { brandPalette } from "@/lib/brand";

const SITE_NAME = "Smithers";

export const siteConfig = {
  name: SITE_NAME,
  title: "Smithers — Durable orchestration for agentic workflows",
  shortTitle: "Smithers",
  tagline: "Durable orchestration for agentic workflows.",
  description:
    "Smithers runs agentic workflows in the background — loops, gates, retries — and saves every finished step. Close your laptop. Kill the process. Pick up where it left off.",
  ogDescription:
    "Multi-step agent work that survives crashes. Your agent picks the recipe — you say the outcome.",
  url: getSiteUrl(),
  github: "https://github.com/smithersai/smithers",
  landingRepo: "https://github.com/smithersai/smithers/tree/main/apps/landing-page",
  docs: "https://smithers.sh",
  keywords: [
    "Smithers",
    "agent orchestration",
    "agentic workflows",
    "coding agents",
    "durable workflows",
    "AI agents",
    "open source",
    "Codex",
    "Claude Code",
  ],
  locale: "en_US",
  themeColor: brandPalette.canvas,
} as const;

function getSiteUrl() {
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  }

  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL.replace(/\/$/, "")}`;
  }

  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL.replace(/\/$/, "")}`;
  }

  return "http://localhost:3000";
}

export const rootMetadata: Metadata = {
  metadataBase: new URL(siteConfig.url),
  title: {
    default: siteConfig.title,
    template: `%s · ${SITE_NAME}`,
  },
  description: siteConfig.description,
  applicationName: SITE_NAME,
  keywords: [...siteConfig.keywords],
  authors: [{ name: "Smithers", url: siteConfig.github }],
  creator: "Smithers",
  publisher: "Smithers",
  category: "technology",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    locale: siteConfig.locale,
    url: siteConfig.url,
    siteName: SITE_NAME,
    title: siteConfig.title,
    description: siteConfig.ogDescription,
  },
  twitter: {
    card: "summary_large_image",
    title: siteConfig.title,
    description: siteConfig.ogDescription,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  icons: {
    icon: [
      { url: "/icon", type: "image/png", sizes: "32x32" },
      { url: "/smithers-icon.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/apple-icon", type: "image/png", sizes: "180x180" }],
    shortcut: ["/icon"],
  },
  manifest: "/manifest.webmanifest",
};
