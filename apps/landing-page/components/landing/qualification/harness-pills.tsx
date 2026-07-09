import { HARNESSES } from "@/lib/landing/constants";

export function HarnessPills() {
  return (
    <div className="mt-6 flex flex-wrap justify-center gap-2">
      {HARNESSES.map((h) => (
        <span
          key={h}
          className="rounded-full border border-border px-3 py-1 font-mono text-[10px] text-muted-foreground"
        >
          {h}
        </span>
      ))}
    </div>
  );
}
