export type ZigFileInput = {
  zig: string;
  loc?: number;
  crate?: string;
};

export type PortFile = {
  zig: string;
  rs: string;
  loc: number;
  crate: string;
};

export type LifetimeField = {
  file: string;
  crate: string;
  struct: string;
  field: string;
  zigType: string;
  class: string;
  rustType: string;
  evidence: string;
  confidence: "high" | "low";
};

export type CrateInput = {
  name: string;
  tier?: number;
};

export type TestArea = {
  id: string;
  glob: string;
  crate: string;
};

export type Probe = {
  id: string;
  cmd: string;
  expect?: string;
};

export type SweepInput = {
  id: string;
  kind: string;
  pattern: string;
  scope: string;
};

export const DEFAULT_TEST_AREAS: TestArea[] = [
  { id: "bun-http", glob: "test/js/bun/http/", crate: "runtime/server" },
  { id: "bun-crypto", glob: "test/js/bun/crypto/", crate: "runtime/crypto" },
  { id: "bun-ffi", glob: "test/js/bun/ffi/", crate: "runtime/ffi" },
  { id: "bun-shell", glob: "test/js/bun/shell/", crate: "runtime/shell" },
  { id: "node-fs", glob: "test/js/node/fs/", crate: "runtime/node/fs" },
  { id: "node-http", glob: "test/js/node/http/", crate: "runtime/node" },
  { id: "node-stream", glob: "test/js/node/stream/", crate: "runtime/webcore/streams" },
  { id: "web-fetch", glob: "test/js/web/fetch/", crate: "http_jsc" },
  { id: "bundler", glob: "test/bundler/", crate: "bundler" },
  { id: "resolver", glob: "test/js/bun/resolve/", crate: "resolver" },
];

export const DEFAULT_PROBES: Probe[] = [
  { id: "help", cmd: "--help", expect: "Usage" },
  { id: "version", cmd: "--version", expect: "." },
  { id: "eval-log", cmd: "-e 'console.log(1)'", expect: "1" },
  { id: "print-expr", cmd: "-p '1+1'", expect: "2" },
];

export const DEFAULT_SWEEPS: SweepInput[] = [
  { id: "unsafe-wrap", kind: "unsafe", pattern: "unsafe { &mut *", scope: "src/" },
  { id: "scopeguard", kind: "raii", pattern: "scopeguard::guard((),", scope: "src/" },
  { id: "idioms", kind: "idiom", pattern: "TODO(port)", scope: "src/" },
];

export function rsPathFor(zig: string): string {
  const parts = zig.split("/").filter(Boolean);
  const file = parts.pop();
  if (!file || !file.endsWith(".zig")) {
    throw new Error(`expected .zig path, got ${zig}`);
  }
  const base = file.replace(/\.zig$/, "");
  const parent = parts[parts.length - 1];
  const area = parts[1];
  if (parts.length === 2 && base === area) return [...parts, "lib.rs"].join("/");
  if (base === parent) return [...parts, "mod.rs"].join("/");
  return [...parts, `${base}.rs`].join("/");
}

export function crateForZig(zig: string): string {
  const parts = zig.split("/").filter(Boolean);
  return parts[1] ?? "unknown";
}

export function normalizePortFiles(files: ZigFileInput[]): PortFile[] {
  return files.map((file) => ({
    zig: file.zig,
    rs: rsPathFor(file.zig),
    loc: Number.isFinite(file.loc) ? Number(file.loc) : 0,
    crate: file.crate ?? crateForZig(file.zig),
  }));
}

export function normalizeCrates(crates: CrateInput[]): Required<CrateInput>[] {
  return crates.map((crate, index) => ({
    name: crate.name.replace(/^bun_/, ""),
    tier: Number.isFinite(crate.tier) ? Number(crate.tier) : index,
  }));
}

export function groupCratesByTier(crates: CrateInput[]): Required<CrateInput>[][] {
  const groups = new Map<number, Required<CrateInput>[]>();
  for (const crate of normalizeCrates(crates)) {
    const tier = crate.tier;
    groups.set(tier, [...(groups.get(tier) ?? []), crate]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, values]) => values);
}

export function stableNodeId(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 140);
  const hash = hashString(value).toString(36);
  return `${slug || "node"}-${hash}`;
}

export function fieldKey(field: Pick<LifetimeField, "file" | "struct" | "field">): string {
  return `${field.file}|${field.struct}|${field.field}`;
}

export function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function stableSample(value: string, rate: number): boolean {
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  return hashString(value) / 0xffffffff < rate;
}

export function selectLifetimeVerificationRows(
  fields: LifetimeField[],
  sampleRate = 0.12,
): LifetimeField[] {
  return fields.filter((field) => {
    if (field.class === "UNKNOWN" || field.confidence === "low") return true;
    return stableSample(fieldKey(field), sampleRate);
  });
}

export function summarizeLifetimeRows(fields: LifetimeField[]): {
  totalFields: number;
  byClass: Record<string, number>;
  unknownRate: number;
} {
  const byClass: Record<string, number> = {};
  for (const field of fields) byClass[field.class] = (byClass[field.class] ?? 0) + 1;
  const totalFields = fields.length;
  return {
    totalFields,
    byClass,
    unknownRate: totalFields === 0 ? 0 : (byClass.UNKNOWN ?? 0) / totalFields,
  };
}

export function lifetimeTsv(fields: LifetimeField[]): string {
  return [
    "file\tstruct\tfield\tzigType\tclass\trustType\tevidence\tconfidence",
    ...fields.map((field) => [
      field.file,
      field.struct,
      field.field,
      field.zigType,
      field.class,
      field.rustType,
      field.evidence,
      field.confidence,
    ].join("\t")),
  ].join("\n");
}

export function cacheKeyForFile(input: {
  repo: string;
  zig: string;
  crate?: string;
  portingRevision?: string;
  lifetimeRevision?: string;
}): Record<string, string> {
  return {
    repo: input.repo,
    zig: input.zig,
    crate: input.crate ?? "",
    portingRevision: input.portingRevision ?? "",
    lifetimeRevision: input.lifetimeRevision ?? "",
  };
}

export function failureKey(input: {
  panicLocation?: string | null;
  assertion?: string | null;
  signal?: string | null;
  command?: string | null;
}): string {
  return [
    input.panicLocation?.trim() || "no-panic",
    input.assertion?.trim() || "no-assertion",
    input.signal?.trim() || "no-signal",
    input.command?.trim() || "no-command",
  ].join("|");
}

export function dedupeFailures<T extends {
  passed: boolean;
  panicLocation?: string | null;
  assertion?: string | null;
  signal?: string | null;
  command?: string | null;
}>(results: T[]): Array<T & { failureKey: string }> {
  const seen = new Set<string>();
  const failures: Array<T & { failureKey: string }> = [];
  for (const result of results) {
    if (result.passed) continue;
    const key = failureKey(result);
    if (seen.has(key)) continue;
    seen.add(key);
    failures.push({ ...result, failureKey: key });
  }
  return failures;
}
