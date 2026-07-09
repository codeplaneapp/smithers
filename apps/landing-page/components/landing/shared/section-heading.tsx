import { SectionLabel } from "@/components/landing/shared/section-label";
import { cn } from "@/lib/utils";

type SectionHeadingProps = {
  label: string;
  title: string;
  description?: string;
  descriptionClassName?: string;
  className?: string;
};

export function SectionHeading({
  label,
  title,
  description,
  descriptionClassName,
  className,
}: SectionHeadingProps) {
  return (
    <div className={className}>
      <SectionLabel>{label}</SectionLabel>
      <h2 className="mt-3 font-display text-2xl tracking-tight text-foreground sm:text-3xl md:text-4xl">
        {title}
      </h2>
      {description && (
        <p
          className={cn(
            "mt-4 max-w-2xl text-muted-foreground",
            descriptionClassName,
          )}
        >
          {description}
        </p>
      )}
    </div>
  );
}
