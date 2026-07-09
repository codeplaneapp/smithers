import { SmithersMark } from "@/components/brand/smithers-mark";
import { FOOTER_LINKS } from "@/lib/landing/content";
import { ExternalLink } from "lucide-react";

export function LandingFooter() {
  return (
    <footer className="border-t border-border px-4 py-10 pb-[max(2.5rem,env(safe-area-inset-bottom))] md:px-6 md:py-12">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 md:flex-row md:items-start md:justify-between">
        <div className="flex items-center gap-2.5">
          <SmithersMark size={24} />
          <span className="font-display text-foreground">smithers</span>
        </div>

        <nav className="grid grid-cols-2 gap-x-8 gap-y-2 sm:grid-cols-3">
          {FOOTER_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground transition-colors hover:text-primary"
            >
              {link.label}
              <ExternalLink className="size-3" aria-hidden />
            </a>
          ))}
        </nav>
      </div>
      <p className="mx-auto mt-8 max-w-6xl font-mono text-[10px] text-muted-foreground">
        MIT · Open source · The durable runtime for agentic workflows.
      </p>
    </footer>
  );
}
