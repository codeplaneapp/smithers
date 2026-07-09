import { GetStartedSection } from "@/components/landing/get-started/get-started-section";
import { LandingHero } from "@/components/landing/hero/landing-hero";
import { HowItWorksSection } from "@/components/landing/how-it-works/how-it-works-section";
import { JustSaySection } from "@/components/landing/just-say/just-say-section";
import { LandingFooter } from "@/components/landing/landing-footer";
import { LandingHeader } from "@/components/landing/landing-header";
import { QualificationSection } from "@/components/landing/qualification/qualification-section";
import { StateOfWorldSection } from "@/components/landing/state-of-world/state-of-world-section";
import { WhySection } from "@/components/landing/why/why-section";

export function LandingPage() {
  return (
    <div className="landing-root overflow-x-clip">
      <div className="landing-grain" aria-hidden />
      <LandingHeader />
      <main>
        <LandingHero />
        <QualificationSection />
        <WhySection />
        <StateOfWorldSection />
        <HowItWorksSection />
        <JustSaySection />
        <GetStartedSection />
      </main>
      <LandingFooter />
    </div>
  );
}
