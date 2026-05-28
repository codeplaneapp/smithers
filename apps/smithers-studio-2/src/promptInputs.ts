export type PromptInput = {
  name: string;
  type?: string;
  defaultValue?: string;
};

const INPUT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const FRONTMATTER_SECTION_KEYS = new Set(["inputs", "props", "parameters", "params", "variables", "args"]);
const FRONTMATTER_METADATA_KEYS = new Set([
  "title",
  "description",
  "tags",
  "date",
  "updated",
  "slug",
  "layout",
  "author",
  "summary",
]);

function normalizeSource(source: string) {
  return source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function splitFrontmatter(source: string) {
  const lines = normalizeSource(source).split("\n");
  if (lines[0]?.replace(/^\uFEFF/, "").trim() !== "---") {
    return { frontmatter: null, body: source };
  }
  const closingIndex = lines.slice(1).findIndex((line) => {
    const trimmed = line.trim();
    return trimmed === "---" || trimmed === "...";
  });
  if (closingIndex < 0) {
    return { frontmatter: null, body: source };
  }
  const end = closingIndex + 1;
  return {
    frontmatter: lines.slice(1, end).join("\n"),
    body: lines.slice(end + 1).join("\n"),
  };
}

function stripYamlComment(line: string) {
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (doubleQuoted && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'" && !doubleQuoted) {
      singleQuoted = !singleQuoted;
      continue;
    }
    if (char === "\"" && !singleQuoted) {
      doubleQuoted = !doubleQuoted;
      continue;
    }
    if (char === "#" && !singleQuoted && !doubleQuoted) {
      return line.slice(0, index).trimEnd();
    }
  }

  return line;
}

function parseYamlScalar(raw: string) {
  const trimmed = stripYamlComment(raw).trim();
  if (!trimmed || trimmed.toLowerCase() === "null" || trimmed === "~") {
    return undefined;
  }
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseYamlKeyValue(line: string): [string, string] | null {
  const separator = line.indexOf(":");
  if (separator < 0) {
    return null;
  }
  const key = line.slice(0, separator).trim();
  if (!key) {
    return null;
  }
  return [key, line.slice(separator + 1).trim()];
}

function parseYamlListItem(line: string) {
  if (!line.startsWith("-")) {
    return null;
  }
  const content = line.slice(1).trim();
  return content || null;
}

function leadingIndent(line: string) {
  const match = /^[\t ]*/.exec(line);
  return match?.[0].length ?? 0;
}

function normalizedInputName(raw: string) {
  const scalar = parseYamlScalar(raw);
  if (!scalar) {
    return undefined;
  }
  const name = scalar.trim();
  return INPUT_NAME_PATTERN.test(name) ? name : undefined;
}

function appendInput(
  byName: Map<string, PromptInput>,
  order: string[],
  name: string,
  type?: string,
  defaultValue?: string,
) {
  if (!INPUT_NAME_PATTERN.test(name)) {
    return;
  }
  const normalizedType = type?.trim() || undefined;
  const normalizedDefault = defaultValue?.trim();
  const existing = byName.get(name);
  if (existing) {
    byName.set(name, {
      name,
      type: existing.type ?? normalizedType,
      defaultValue: existing.defaultValue ?? normalizedDefault,
    });
    return;
  }
  order.push(name);
  byName.set(name, { name, type: normalizedType, defaultValue: normalizedDefault });
}

function parseInlineInputList(value: string, byName: Map<string, PromptInput>, order: string[]) {
  const trimmed = value.trim();
  if (!trimmed) {
    return;
  }
  const content = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
  for (const rawItem of content.split(",")) {
    const item = rawItem.trim();
    if (!item) {
      continue;
    }
    const keyValue = parseYamlKeyValue(item);
    if (keyValue) {
      const [key, rawDefault] = keyValue;
      const name = normalizedInputName(key);
      if (name) {
        appendInput(byName, order, name, "string", parseYamlScalar(rawDefault));
      }
      continue;
    }
    const name = normalizedInputName(item);
    if (name) {
      appendInput(byName, order, name, "string");
    }
  }
}

function discoverFrontmatterInputs(frontmatter: string) {
  const byName = new Map<string, PromptInput>();
  const order: string[] = [];
  let activeSection: string | undefined;
  let sectionIndent = 0;
  let currentName: string | undefined;
  let currentNameIndent = -1;
  let topLevelProp = false;

  for (const rawLine of frontmatter.split("\n")) {
    const line = stripYamlComment(rawLine);
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const indent = leadingIndent(line);
    const listItem = parseYamlListItem(trimmed);
    if (listItem) {
      if (!activeSection) {
        continue;
      }
      const keyValue = parseYamlKeyValue(listItem);
      if (keyValue?.[0].toLowerCase() === "name") {
        currentName = normalizedInputName(keyValue[1]);
        currentNameIndent = indent;
        if (currentName) {
          appendInput(byName, order, currentName, "string");
        }
      } else {
        currentName = normalizedInputName(listItem);
        currentNameIndent = currentName ? indent : -1;
        if (currentName) {
          appendInput(byName, order, currentName, "string");
        }
      }
      continue;
    }

    const keyValue = parseYamlKeyValue(trimmed);
    if (!keyValue) {
      continue;
    }
    const [key, value] = keyValue;
    const loweredKey = key.toLowerCase();

    if (indent === 0) {
      currentName = undefined;
      currentNameIndent = -1;
      topLevelProp = false;
      activeSection = undefined;

      if (FRONTMATTER_SECTION_KEYS.has(loweredKey)) {
        activeSection = loweredKey;
        sectionIndent = indent;
        parseInlineInputList(value, byName, order);
        continue;
      }

      if (!FRONTMATTER_METADATA_KEYS.has(loweredKey)) {
        const name = normalizedInputName(key);
        if (name) {
          topLevelProp = true;
          currentName = name;
          currentNameIndent = indent;
          appendInput(byName, order, name, "string", parseYamlScalar(value));
        }
      }
      continue;
    }

    if (activeSection && indent <= sectionIndent) {
      activeSection = undefined;
    }

    if (activeSection) {
      if (loweredKey === "name") {
        currentName = normalizedInputName(value);
        currentNameIndent = indent;
        if (currentName) {
          appendInput(byName, order, currentName, "string");
        }
        continue;
      }

      if (currentName && indent > currentNameIndent) {
        if (loweredKey === "type") {
          appendInput(byName, order, currentName, parseYamlScalar(value) ?? "string");
          continue;
        }
        if (loweredKey === "default" || loweredKey === "defaultvalue" || loweredKey === "value") {
          appendInput(byName, order, currentName, undefined, parseYamlScalar(value));
          continue;
        }
      }

      if (currentName === undefined || indent <= currentNameIndent) {
        const nestedName = normalizedInputName(key);
        if (nestedName) {
          currentName = nestedName;
          currentNameIndent = indent;
          appendInput(byName, order, nestedName, "string", parseYamlScalar(value));
        }
      }
      continue;
    }

    if (topLevelProp && currentName && indent > currentNameIndent) {
      if (loweredKey === "type") {
        appendInput(byName, order, currentName, parseYamlScalar(value) ?? "string");
      } else if (loweredKey === "default" || loweredKey === "defaultvalue" || loweredKey === "value") {
        appendInput(byName, order, currentName, undefined, parseYamlScalar(value));
      }
    }
  }

  return order.flatMap((name) => byName.get(name) ?? []);
}

function discoverComponentInputs(source: string, byName: Map<string, PromptInput>, order: string[]) {
  const tagPattern = /<[A-Z][A-Za-z0-9_.:-]*\b[^>]*>/gs;
  const propMemberPattern = /[A-Za-z_][A-Za-z0-9_.-]*\s*=\s*\{\s*props\.([A-Za-z_][A-Za-z0-9_.-]*)\s*\}/g;
  const passThroughPattern = /([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}/g;
  for (const tag of source.matchAll(tagPattern)) {
    const text = tag[0];
    for (const match of text.matchAll(propMemberPattern)) {
      appendInput(byName, order, match[1], "string");
    }
    for (const match of text.matchAll(passThroughPattern)) {
      if (match[1] === match[2]) {
        appendInput(byName, order, match[1], "string");
      }
    }
  }
}

export function discoverPromptInputs(source: string, preferredInputs: PromptInput[] = []) {
  const normalized = normalizeSource(source);
  const { frontmatter, body } = splitFrontmatter(normalized);
  const byName = new Map<string, PromptInput>();
  const order: string[] = [];

  if (frontmatter) {
    for (const input of discoverFrontmatterInputs(frontmatter)) {
      appendInput(byName, order, input.name, input.type ?? "string", input.defaultValue);
    }
  }

  for (const match of body.matchAll(/\{\s*props\.([A-Za-z_][A-Za-z0-9_.-]*)\s*\}/g)) {
    appendInput(byName, order, match[1], "string");
  }
  discoverComponentInputs(body, byName, order);

  const discovered = order.flatMap((name) => byName.get(name) ?? []);
  if (discovered.length === 0) {
    return preferredInputs;
  }
  const preferredByName = new Map(preferredInputs.map((input) => [input.name, input]));
  return discovered.map((input) => {
    const preferred = preferredByName.get(input.name);
    return {
      name: input.name,
      type: preferred?.type ?? input.type,
      defaultValue: preferred?.defaultValue ?? input.defaultValue,
    };
  });
}

export function defaultPromptInputValues(inputs: PromptInput[]) {
  return inputs.reduce<Record<string, string>>((values, input) => {
    if (input.defaultValue !== undefined) {
      values[input.name] = input.defaultValue;
    }
    return values;
  }, {});
}

export function renderPromptPreview(source: string, input: Record<string, string>) {
  const { body } = splitFrontmatter(source);
  return body.replace(/\{\s*props\.([A-Za-z_][A-Za-z0-9_.-]*)\s*\}/g, (_match, name: string) => {
    return input[name] ?? "";
  }).trim();
}
