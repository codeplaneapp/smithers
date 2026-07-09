import { CopyCommand } from "@/components/landing/get-started/copy-command";
import { DocLinkCards } from "@/components/landing/get-started/doc-link-cards";
import { GetStartedSteps } from "@/components/landing/get-started/get-started-steps";
import { SectionHeading } from "@/components/landing/shared/section-heading";
import { SectionShell } from "@/components/landing/shared/section-shell";
import { GET_STARTED } from "@/lib/landing/content";
import { LINKS } from "@/lib/landing/constants";
import { ExternalLink } from "lucide-react";

export function GetStartedSection() {
  return (
    <SectionShell id="start" className="border-t border-border bg-card/30 py-16 sm:py-20 md:py-24">
      <div className="mx-auto max-w-4xl">
        <SectionHeading
          label="Get started"
          title={GET_STARTED.title}
          description={GET_STARTED.description}
          className="text-center [&_p]:mx-auto"
        />

        <div className="landing-enter mt-8 overflow-hidden rounded-xl border border-border bg-card p-4 shadow-lg shadow-black/20 sm:mt-10 sm:p-6 md:p-8">
          <CopyCommand />
        </div>

        <GetStartedSteps className="mt-8 sm:mt-12" />

        <DocLinkCards className="mt-8 border-t border-border pt-8 sm:mt-12 sm:pt-10" />

        <p className="mt-8 text-center font-display text-base text-foreground sm:mt-10 sm:text-lg">
          {GET_STARTED.closer}
        </p>

        <p className="mt-4 text-center font-mono text-xs text-muted-foreground">
          MIT licensed ·{" "}
          <a
            href={LINKS.github}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 hover:text-primary"
          >
            GitHub
            <ExternalLink className="size-3" aria-hidden />
          </a>
          {" · "}
          Bun recommended; npm in docs
        </p>
      </div>
    </SectionShell>
  );
}
