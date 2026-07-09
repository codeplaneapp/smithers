import { LayerStack } from "@/components/landing/state-of-world/layer-stack";
import { QuoteCard } from "@/components/landing/state-of-world/quote-card";
import { XPostCard } from "@/components/landing/state-of-world/x-post-card";
import { SectionHeading } from "@/components/landing/shared/section-heading";
import { SectionShell } from "@/components/landing/shared/section-shell";
import { STATE_QUOTES } from "@/lib/landing/content";

export function StateOfWorldSection() {
  return (
    <SectionShell>
      <div className="mx-auto max-w-4xl">
        <SectionHeading
          label="State of the world"
          title="The industry is moving toward durable agent loops."
          description="A loop = a small system that prompts your agent, checks the result, and runs again until done. Smithers is the stable layer underneath."
        />

        <div className="mt-8 space-y-4 sm:mt-10">
          {STATE_QUOTES.map((quote) =>
            quote.kind === "tweet" ? (
              <XPostCard key={quote.authorHandle} {...quote} />
            ) : (
              <QuoteCard key={quote.author} text={quote.text} author={quote.author} href={quote.href} />
            ),
          )}
        </div>

        <LayerStack />
      </div>
    </SectionShell>
  );
}
