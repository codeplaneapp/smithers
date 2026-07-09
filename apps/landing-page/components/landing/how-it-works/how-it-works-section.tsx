import { ArchitectureFlow } from "@/components/landing/how-it-works/architecture-flow";
import { PersistenceSnapshot } from "@/components/landing/how-it-works/persistence-snapshot";
import { WorkflowTsxReveal } from "@/components/landing/how-it-works/workflow-tsx-reveal";
import { SectionLabel } from "@/components/landing/shared/section-label";
import { SectionHeading } from "@/components/landing/shared/section-heading";
import { SectionShell } from "@/components/landing/shared/section-shell";
import { HOW_IT_WORKS } from "@/lib/landing/content";

export function HowItWorksSection() {
  return (
    <SectionShell>
      <div className="mx-auto max-w-4xl">
        <SectionHeading
          label="How it works"
          title={HOW_IT_WORKS.title}
          description={HOW_IT_WORKS.description}
        />

        <ArchitectureFlow />

        <div className="mt-8 grid gap-6 lg:grid-cols-2 lg:gap-10 sm:mt-12">
          <div>
            <SectionLabel className="mb-3">What you define</SectionLabel>
            <WorkflowTsxReveal />
          </div>
          <div>
            <SectionLabel className="mb-3">What the orchestrator runs</SectionLabel>
            <PersistenceSnapshot />
          </div>
        </div>

        <p className="mt-8 text-center text-sm text-muted-foreground">{HOW_IT_WORKS.footer}</p>
      </div>
    </SectionShell>
  );
}
