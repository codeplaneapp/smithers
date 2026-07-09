import { LINKS } from "@/lib/landing/constants";
import { ArrowRight, ExternalLink } from "lucide-react";

export function HeroCopy() {
  return (
    <div className="mx-auto max-w-4xl text-center">
      <p className="landing-enter inline-flex items-center justify-center gap-1 font-mono text-xs text-muted-foreground">
        Open source ·{" "}
        <a
          href={LINKS.github}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-primary hover:underline"
        >
          GitHub
          <ExternalLink className="size-3" aria-hidden />
        </a>
      </p>

      <h1 className="landing-enter landing-enter-delay-1 mt-5 font-display text-[1.75rem] leading-[1.12] tracking-tight text-foreground sm:mt-6 sm:text-4xl md:text-5xl">
        Durable orchestration for agentic workflows.
      </h1>

      <p className="landing-enter landing-enter-delay-2 mx-auto mt-5 max-w-2xl text-base leading-relaxed text-muted-foreground sm:mt-6 sm:text-lg">
        Smithers runs any recipe in the background — loops, gates, retries — and
        saves every finished step. Close your laptop. Kill the process. Pick up
        where it left off.
      </p>

      <p className="landing-enter mt-8">
        <a
          href={LINKS.getStarted}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 font-mono text-sm text-primary underline-offset-4 hover:underline"
        >
          Read the 5‑minute guide
          <ArrowRight className="size-3.5" aria-hidden />
        </a>
      </p>
    </div>
  );
}
