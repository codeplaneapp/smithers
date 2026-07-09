import { cn } from "@/lib/utils";

type SectionShellProps = {
  children: React.ReactNode;
  className?: string;
  id?: string;
  ref?: React.Ref<HTMLElement>;
};

export function SectionShell({ children, className, id, ref }: SectionShellProps) {
  return (
    <section
      ref={ref}
      id={id}
      className={cn(
        "border-t border-border px-4 py-12 sm:py-16 md:px-6 md:py-20",
        className,
      )}
    >
      {children}
    </section>
  );
}
