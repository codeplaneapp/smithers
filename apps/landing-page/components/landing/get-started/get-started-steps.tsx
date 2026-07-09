import { GET_STARTED_STEPS } from "@/lib/landing/content";
import { cn } from "@/lib/utils";

type GetStartedStepsProps = {
  className?: string;
};

export function GetStartedSteps({ className }: GetStartedStepsProps) {
  return (
    <div className={cn("grid gap-6 md:grid-cols-3 md:gap-8", className)}>
      {GET_STARTED_STEPS.map((step) => (
        <div key={step.n} className="relative text-center md:text-left">
          <div className="mx-auto flex size-9 items-center justify-center rounded-full bg-primary font-mono text-sm font-medium text-primary-foreground md:mx-0">
            {step.n}
          </div>
          <h3 className="mt-3 font-medium text-foreground">{step.title}</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{step.detail}</p>
        </div>
      ))}
    </div>
  );
}
