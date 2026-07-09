import { WhyDemo } from "@/components/landing/why/why-demo";
import type { WhyDemoType } from "@/lib/landing/types";

type WhyCardProps = {
  title: string;
  body: string;
  demo: WhyDemoType;
};

export function WhyCard({ title, body, demo }: WhyCardProps) {
  return (
    <article className="rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/30 sm:p-5">
      <WhyDemo type={demo} />
      <h3 className="mt-4 font-display text-lg text-foreground sm:mt-5 sm:text-xl">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
    </article>
  );
}
