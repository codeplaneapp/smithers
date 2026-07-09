import { HeroCopy } from "@/components/landing/hero/hero-copy";
import { HeroDemoTabs } from "@/components/landing/hero/hero-demo-tabs";

export function LandingHero() {
  return (
    <section className="relative px-4 pb-12 pt-8 sm:pb-16 sm:pt-10 md:px-6 md:pb-20 md:pt-16">
      <HeroCopy />
      <HeroDemoTabs />
    </section>
  );
}
