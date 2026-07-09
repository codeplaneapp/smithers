import {
  STATE_LAYERS,
  STATE_LAYERS_HEADLINE,
  STATE_LAYERS_LEDE,
  STATE_LAYERS_PULL_QUOTE,
  STATE_LAYERS_SHIFT_LABEL,
  STATE_LAYERS_STABLE_LABEL,
} from "@/lib/landing/content";
import type { StateLayer } from "@/lib/landing/types";
import { cn } from "@/lib/utils";

const volatileLayers = STATE_LAYERS.filter((layer) => layer.unstable);
const stableLayer = STATE_LAYERS.find((layer) => !layer.unstable)!;

export function LayerStack() {
  return (
    <div className="mt-10 rounded-xl border border-border bg-card/50 p-4 sm:mt-14 sm:p-6 md:p-10">
      <div className="max-w-xl">
        <h3 className="font-display text-2xl tracking-tight text-foreground sm:text-3xl md:text-4xl">
          {STATE_LAYERS_HEADLINE}
        </h3>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground sm:mt-4 sm:text-base md:text-lg">
          {STATE_LAYERS_LEDE}
        </p>
      </div>

      <blockquote className="mt-8 max-w-2xl border-l-2 border-primary/45 pl-4 sm:mt-10 sm:pl-5">
        <p className="font-display text-xl leading-snug tracking-tight text-foreground sm:text-2xl md:text-[1.65rem] md:leading-snug">
          &ldquo;{STATE_LAYERS_PULL_QUOTE}&rdquo;
        </p>
      </blockquote>

      <div className="mt-8 sm:mt-10 md:mt-12">
        <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {STATE_LAYERS_SHIFT_LABEL}
        </p>

        <div className="mt-3 space-y-2">
          {volatileLayers.map((layer) => (
            <VolatileLayerRow key={layer.label} layer={layer} />
          ))}
        </div>

        <div
          className="my-5 flex items-center gap-3 md:my-6"
          aria-hidden
        >
          <div className="h-px flex-1 bg-border" />
          <span className="font-mono text-[10px] uppercase tracking-wider text-primary">
            {STATE_LAYERS_STABLE_LABEL}
          </span>
          <div className="h-px flex-1 bg-border" />
        </div>

        <StableLayerRow layer={stableLayer} />
      </div>
    </div>
  );
}

function VolatileLayerRow({ layer }: { layer: StateLayer }) {
  return (
    <div className="rounded-lg border border-border/70 bg-background/30 px-4 py-3 opacity-75">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="font-mono text-xs font-medium text-foreground/80">{layer.label}</span>
        <span className="font-mono text-[10px] text-muted-foreground">{layer.cadence}</span>
      </div>
      <p className="mt-1 font-mono text-[11px] text-muted-foreground">{layer.examples}</p>
    </div>
  );
}

function StableLayerRow({ layer }: { layer: StateLayer }) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border border-primary/35 bg-[linear-gradient(165deg,color-mix(in_oklch,var(--accent)_55%,var(--surface))_0%,var(--card)_100%)] px-5 py-5 shadow-[0_0_0_1px_color-mix(in_oklch,var(--primary)_12%,transparent),0_12px_40px_-20px_color-mix(in_oklch,var(--primary)_35%,transparent)] md:px-6 md:py-6",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-medium text-foreground md:text-base">
              {layer.label}
            </span>
            {layer.tagline && (
              <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-[10px] text-primary">
                {layer.tagline}
              </span>
            )}
          </div>
          <p className="mt-3 max-w-lg text-sm leading-relaxed text-foreground md:text-base">
            {layer.examples}
          </p>
        </div>
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-primary">
          {layer.cadence}
        </span>
      </div>
    </div>
  );
}
