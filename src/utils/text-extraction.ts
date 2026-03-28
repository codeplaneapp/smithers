export function extractTextFromJsonValue(value: any): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = value.map((item) => extractTextFromJsonValue(item) ?? "").join("");
    return text || undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (typeof value.output_text === "string") return value.output_text;

  if (Array.isArray(value.content)) {
    const text = value.content
      .map((part: any) => extractTextFromJsonValue(part) ?? "")
      .join("");
    if (text) return text;
  }

  for (const field of ["response", "message", "result", "output", "data", "item"]) {
    const text = extractTextFromJsonValue(value[field]);
    if (text) return text;
  }

  return undefined;
}
