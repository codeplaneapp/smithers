import { readFileSync, writeFileSync } from "node:fs";

/**
 * Parse the only compound shell shape coverage can reproduce without a shell:
 * one or more direct `bun test` commands joined by `&&`.
 *
 * Returns null for any other command, operator, expansion, or malformed quote
 * so coverage fails closed instead of silently running a different test set.
 */
export function directBunTestSegments(input) {
  const words = [];
  let current = "";
  let quote = null;
  let started = false;
  const pushWord = () => {
    if (started) words.push(current);
    current = "";
    started = false;
  };

  for (let index = 0; index < input.length; index += 1) {
    const ch = input[index];
    if (ch === "\n" || ch === "\r") return null;

    if (quote === "\"") {
      if (ch === "\"") {
        quote = null;
      } else if ("$`%^!".includes(ch)) {
        return null;
      } else if (ch === "\\" && (input[index + 1] === "\"" || input[index + 1] === "\\")) {
        current += input[index + 1];
        index += 1;
      } else {
        current += ch;
      }
      started = true;
      continue;
    }

    if (ch === "\\") {
      return null;
    }
    if (ch === "\"") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === "&") {
      if (input[index + 1] !== "&") return null;
      pushWord();
      words.push("&&");
      index += 1;
      continue;
    }
    // Coverage bypasses the package-manager shell and spawns Bun directly.
    // These constructs cannot be reproduced with an argv array.
    if (";|<>()`*?[]~{}'$%^!".includes(ch) || ch === "#") return null;
    if (/\s/.test(ch)) {
      pushWord();
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote) return null;
  pushWord();

  const commands = [];
  let command = [];
  for (const word of words) {
    if (word === "&&") {
      if (command.length === 0) return null;
      commands.push(command);
      command = [];
    } else {
      command.push(word);
    }
  }
  if (command.length === 0) return null;
  commands.push(command);

  const segments = [];
  for (const [index, commandWords] of commands.entries()) {
    if (commandWords[0] !== "bun" || commandWords[1] !== "test") return null;
    const args = [];
    for (let argIndex = 2; argIndex < commandWords.length; argIndex += 1) {
      const arg = commandWords[argIndex];
      if (arg === "--coverage") continue;
      if (arg === "--coverage-reporter" || arg === "--coverage-dir") {
        if (commandWords[argIndex + 1] === undefined) return null;
        argIndex += 1;
        continue;
      }
      if (arg.startsWith("--coverage-reporter=") || arg.startsWith("--coverage-dir=")) continue;
      args.push(arg);
    }
    segments.push({ phase: `test-${index + 1}`, args });
  }
  return segments;
}

/**
 * Merge Bun LCOV legs by unioning identified entities and summing their hits.
 * Bun can emit only aggregate LF/LH, FNF/FNH, or BRF/BRH counters for a source.
 * Without identities, require a stable found total across legs and use max(hit)
 * as a conservative lower bound for the union. Ambiguous inventories throw,
 * avoiding both double-counted totals and the dangerous `0 found` => 100%.
 */
export function mergeLcovReports(lcovPaths, outputPath) {
  const newMetric = () => ({ identities: new Map(), found: undefined, hit: undefined });
  const records = new Map();
  const recordFor = (source) => {
    let record = records.get(source);
    if (!record) {
      record = {
        lines: new Map(),
        functionLines: new Map(),
        functions: new Map(),
        branches: new Map(),
        legs: new Map(),
      };
      records.set(source, record);
    }
    return record;
  };
  const legFor = (record, legIndex) => {
    let leg = record.legs.get(legIndex);
    if (!leg) {
      leg = {
        lines: newMetric(),
        functions: newMetric(),
        branches: newMetric(),
      };
      record.legs.set(legIndex, leg);
    }
    return leg;
  };
  const addHits = (map, identity, hits) => {
    map.set(identity, (map.get(identity) ?? 0) + hits);
  };
  const addBranchHits = (map, identity, hits) => {
    const previous = map.get(identity);
    map.set(identity, hits === null ? previous ?? null : (previous ?? 0) + hits);
  };
  const setAggregate = (metric, field, value, source, legIndex, metricName) => {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Invalid LCOV ${metricName} ${field} for ${source} in leg ${legIndex + 1}`);
    }
    if (metric[field] !== undefined && metric[field] !== value) {
      throw new Error(`Conflicting LCOV ${metricName} ${field} for ${source} in leg ${legIndex + 1}`);
    }
    metric[field] = value;
  };

  for (const [legIndex, lcovPath] of lcovPaths.entries()) {
    let record = null;
    let leg = null;
    let source = null;
    for (const line of readFileSync(lcovPath, "utf8").split(/\r?\n/)) {
      if (line.startsWith("SF:")) {
        source = line.slice(3);
        record = recordFor(source);
        leg = legFor(record, legIndex);
        continue;
      }
      if (!record || line === "end_of_record") {
        if (line === "end_of_record") {
          record = null;
          leg = null;
          source = null;
        }
        continue;
      }
      if (line.startsWith("DA:")) {
        const [lineNo, hits] = line.slice(3).split(",", 2);
        addHits(record.lines, lineNo, Number(hits));
        addHits(leg.lines.identities, lineNo, Number(hits));
      } else if (line.startsWith("FN:")) {
        const comma = line.indexOf(",", 3);
        if (comma >= 0) {
          const name = line.slice(comma + 1);
          record.functionLines.set(name, line.slice(3, comma));
          if (!record.functions.has(name)) record.functions.set(name, 0);
          if (!leg.functions.identities.has(name)) leg.functions.identities.set(name, 0);
        }
      } else if (line.startsWith("FNDA:")) {
        const comma = line.indexOf(",", 5);
        if (comma >= 0) {
          const name = line.slice(comma + 1);
          const hits = Number(line.slice(5, comma));
          addHits(record.functions, name, hits);
          addHits(leg.functions.identities, name, hits);
        }
      } else if (line.startsWith("BRDA:")) {
        const [lineNo, block, branch, taken] = line.slice(5).split(",", 4);
        const key = `${lineNo},${block},${branch}`;
        const hits = taken === "-" ? null : Number(taken);
        addBranchHits(record.branches, key, hits);
        addBranchHits(leg.branches.identities, key, hits);
      } else if (line.startsWith("LF:")) {
        setAggregate(leg.lines, "found", Number(line.slice(3)), source, legIndex, "lines");
      } else if (line.startsWith("LH:")) {
        setAggregate(leg.lines, "hit", Number(line.slice(3)), source, legIndex, "lines");
      } else if (line.startsWith("FNF:")) {
        setAggregate(leg.functions, "found", Number(line.slice(4)), source, legIndex, "functions");
      } else if (line.startsWith("FNH:")) {
        setAggregate(leg.functions, "hit", Number(line.slice(4)), source, legIndex, "functions");
      } else if (line.startsWith("BRF:")) {
        setAggregate(leg.branches, "found", Number(line.slice(4)), source, legIndex, "branches");
      } else if (line.startsWith("BRH:")) {
        setAggregate(leg.branches, "hit", Number(line.slice(4)), source, legIndex, "branches");
      }
    }
  }

  const hitCount = (identities) => [...identities.values()].filter((hits) => hits !== null && hits > 0).length;
  const metricCounts = (source, record, metricName, unionIdentities) => {
    const legs = [...record.legs.entries()].map(([legIndex, leg]) => {
      const metric = leg[metricName];
      let { found, hit } = metric;
      // Bun omits BRF/BRH entirely when a source has no branches.
      if (
        metricName === "branches" &&
        found === undefined &&
        hit === undefined &&
        metric.identities.size === 0
      ) {
        found = 0;
        hit = 0;
      }
      if (found === undefined || hit === undefined) {
        throw new Error(`Incomplete LCOV ${metricName} aggregates for ${source} in leg ${legIndex + 1}`);
      }
      const identifiedFound = metric.identities.size;
      const identifiedHit = hitCount(metric.identities);
      if (identifiedFound > found || identifiedHit > hit || hit > found) {
        throw new Error(`Inconsistent LCOV ${metricName} counters for ${source} in leg ${legIndex + 1}`);
      }
      const complete = identifiedFound === found;
      if (complete && identifiedHit !== hit) {
        throw new Error(`Inconsistent LCOV ${metricName} hits for ${source} in leg ${legIndex + 1}`);
      }
      return { found, hit, complete };
    });
    const unionFound = unionIdentities.size;
    const unionHit = hitCount(unionIdentities);
    if (legs.every((leg) => leg.complete)) return { found: unionFound, hit: unionHit };

    const foundTotals = new Set(legs.map((leg) => leg.found));
    if (foundTotals.size !== 1) {
      throw new Error(`Ambiguous LCOV ${metricName} totals for ${source}: ${[...foundTotals].join(", ")}`);
    }
    const stableFound = legs[0].found;
    if (unionFound > stableFound) {
      throw new Error(
        `Ambiguous LCOV ${metricName} identities for ${source}: ${unionFound} identified exceeds ${stableFound} found`,
      );
    }
    // Unknown identities prevent an exact hit union. max(hit) is the safe
    // lower bound: it never invents coverage and still preserves each leg.
    const conservativeHit = Math.max(unionHit, ...legs.map((leg) => leg.hit));
    return { found: stableFound, hit: conservativeHit };
  };

  const output = [];
  for (const [source, record] of [...records.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const functions = metricCounts(source, record, "functions", record.functions);
    const lines = metricCounts(source, record, "lines", record.lines);
    const branches = metricCounts(source, record, "branches", record.branches);
    output.push("TN:", `SF:${source}`);
    for (const [name, lineNo] of [...record.functionLines.entries()].sort((a, b) => Number(a[1]) - Number(b[1]))) {
      output.push(`FN:${lineNo},${name}`);
    }
    for (const [name, hits] of [...record.functions.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      output.push(`FNDA:${hits},${name}`);
    }
    output.push(`FNF:${functions.found}`);
    output.push(`FNH:${functions.hit}`);
    for (const [lineNo, hits] of [...record.lines.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
      output.push(`DA:${lineNo},${hits}`);
    }
    output.push(`LF:${lines.found}`);
    output.push(`LH:${lines.hit}`);
    for (const [key, hits] of [...record.branches.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      output.push(`BRDA:${key},${hits ?? "-"}`);
    }
    output.push(`BRF:${branches.found}`);
    output.push(`BRH:${branches.hit}`);
    output.push("end_of_record");
  }
  writeFileSync(outputPath, `${output.join("\n")}\n`);
}
