"use client";

import { SmithersMark } from "@/components/brand/smithers-mark";
import { LINKS } from "@/lib/landing/constants";
import { cn } from "@/lib/utils";
import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";

export function LandingHeader() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 48);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        "sticky top-0 z-50 border-b transition-colors duration-200 pt-[env(safe-area-inset-top)]",
        scrolled
          ? "border-border bg-background/80 backdrop-blur-md"
          : "border-transparent bg-transparent",
      )}
    >
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 md:px-6">
        <a href="#" className="flex items-center gap-2.5">
          <SmithersMark size={28} />
          <span className="font-display text-lg tracking-tight text-foreground">
            smithers
          </span>
        </a>

        <nav className="flex items-center gap-2 sm:gap-4 md:gap-6">
          <a
            href={LINKS.docs}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 p-1 text-muted-foreground transition-colors hover:text-foreground sm:p-0 sm:text-sm"
            aria-label="Documentation"
          >
            <span className="hidden sm:inline">Docs</span>
            <ExternalLink className="size-3.5 sm:size-3" aria-hidden />
          </a>
          <a
            href={LINKS.github}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 p-1 text-muted-foreground transition-colors hover:text-foreground sm:p-0 sm:text-sm"
            aria-label="GitHub repository"
          >
            <span className="hidden sm:inline">GitHub</span>
            <ExternalLink className="size-3.5 sm:size-3" aria-hidden />
          </a>
          <a
            href="#start"
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 sm:text-sm"
          >
            Get started
          </a>
        </nav>
      </div>
    </header>
  );
}
