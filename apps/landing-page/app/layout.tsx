import { ThemeShell } from "@/components/theme/theme-shell";
import { rootMetadata, siteConfig } from "@/lib/site";
import { themeInitScript } from "@/lib/theme/theme-script";
import { DEFAULT_THEME } from "@/lib/theme/types";
import type { Metadata, Viewport } from "next";
import {
  Atkinson_Hyperlegible,
  DM_Sans,
  Instrument_Sans,
  Instrument_Serif,
  JetBrains_Mono,
  Newsreader,
} from "next/font/google";
import Script from "next/script";
import "./globals.css";

const newsreader = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
  display: "swap",
});

const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
  display: "swap",
});

const atkinson = Atkinson_Hyperlegible({
  variable: "--font-atkinson",
  subsets: ["latin"],
  weight: ["400", "700"],
  display: "swap",
});

const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: ["400"],
  display: "swap",
});

const instrumentSans = Instrument_Sans({
  variable: "--font-instrument-sans",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = rootMetadata;

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: siteConfig.themeColor,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`dark ${newsreader.variable} ${dmSans.variable} ${atkinson.variable} ${instrumentSerif.variable} ${instrumentSans.variable} ${jetbrainsMono.variable} h-full antialiased`}
      data-palette={DEFAULT_THEME.palette}
      data-font={DEFAULT_THEME.font}
      data-radius={DEFAULT_THEME.radius}
      suppressHydrationWarning
    >
      <body className="flex min-h-full flex-col">
        <Script id="smithers-theme-init" strategy="beforeInteractive">
          {themeInitScript}
        </Script>
        <ThemeShell>{children}</ThemeShell>
      </body>
    </html>
  );
}
