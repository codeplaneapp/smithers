export type Capability =
  | "virtual-time"
  | "seeded-interleaving"
  | "explicit-interleaving"
  | "barriers"
  | "mediated-effects"
  | "real-db"
  | "real-process"
  | "native-error-parity"
  | "durability-faults";
export type CapabilityDecision = Readonly<{
  readonly kind: "supported" | "capability-failure" | "capability-skip";
  readonly harness: string;
  readonly capability: Capability;
  readonly hint?: string;
}>;
export const admitCapabilities = (
  harness: { name: string; capabilities: ReadonlySet<Capability> },
  requested: readonly Capability[],
  policy: "fail" | "skip" = "fail",
): readonly CapabilityDecision[] =>
  requested.map((capability) =>
    harness.capabilities.has(capability)
      ? { kind: "supported", harness: harness.name, capability }
      : {
          kind: policy === "skip" ? "capability-skip" : "capability-failure",
          harness: harness.name,
          capability,
          hint: "Choose a harness that declares this capability.",
        },
  );
export const requiredCapabilities = (ast: {
  readonly steps: readonly { readonly capabilities: readonly string[] }[];
  readonly barriers: readonly unknown[];
  readonly faults: readonly unknown[];
  readonly extensions: readonly { readonly name: string }[];
}): readonly Capability[] => {
  const result = new Set<Capability>();
  for (const step of ast.steps) for (const capability of step.capabilities) result.add(capability as Capability);
  if (ast.barriers.length) result.add("barriers");
  if (ast.faults.length) result.add("durability-faults");
  if (ast.extensions.length) result.add("explicit-interleaving");
  return [...result];
};
