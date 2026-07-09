import { ExternalLink } from "lucide-react";

type QuoteCardProps = {
  text: string;
  author: string;
  href?: string;
};

export function QuoteCard({ text, author, href }: QuoteCardProps) {
  return (
    <blockquote className="rounded-xl border border-border bg-card p-6 landing-enter">
      <p className="font-display text-lg leading-relaxed text-foreground">
        &ldquo;{text}&rdquo;
      </p>
      <footer className="mt-3 font-mono text-xs text-muted-foreground">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 hover:text-primary"
          >
            {author}
            <ExternalLink className="size-3" aria-hidden />
          </a>
        ) : (
          author
        )}
      </footer>
    </blockquote>
  );
}
