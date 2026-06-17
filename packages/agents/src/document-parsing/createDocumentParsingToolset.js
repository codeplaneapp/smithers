import { dynamicTool, jsonSchema } from "ai";

/** @typedef {import("./DocumentParsingProvider.ts").DocumentParsingProvider} DocumentParsingProvider */
/** @typedef {import("./DocumentParsingToolset.ts").DocumentParsingToolset} DocumentParsingToolset */
/** @typedef {import("./DocumentParsingToolsetOptions.ts").DocumentParsingToolsetOptions} DocumentParsingToolsetOptions */

const inputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["source"],
  properties: {
    source: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["type", "url"],
          properties: { type: { const: "url" }, url: { type: "string" } },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["type", "data"],
          properties: {
            type: { const: "base64" },
            data: { type: "string" },
            mimeType: { type: "string" },
            filename: { type: "string" },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["type", "text"],
          properties: { type: { const: "text" }, text: { type: "string" }, filename: { type: "string" } },
        },
      ],
    },
    outputFormat: { enum: ["text", "markdown", "json"] },
    instructions: { type: "string" },
  },
};

/**
 * Expose a document parsing / OCR primitive as an AI SDK toolset.
 *
 * The default provider is Firecrawl for document parsing. Mistral OCR and LlamaParse
 * can be selected explicitly, or callers can inject any provider matching the
 * same contract for per-tenant credentials and custom parsing stacks.
 *
 * @param {DocumentParsingToolsetOptions} [options]
 * @returns {DocumentParsingToolset}
 */
export function createDocumentParsingToolset(options = {}) {
  const provider = resolveProvider(options);
  const toolName = options.toolName ?? "parse_document";
  return {
    tools: {
      [toolName]: dynamicTool({
        description:
          "Parse documents and images into readable text/markdown using Firecrawl, Mistral OCR, LlamaParse, or a custom provider.",
        inputSchema: jsonSchema(inputSchema),
        execute: async (input) => provider.parseDocument(normalizeInput(input)),
      }),
    },
    toolNames: [toolName],
  };
}

/**
 * @param {DocumentParsingToolsetOptions} options
 * @returns {DocumentParsingProvider}
 */
function resolveProvider(options) {
  if (typeof options.provider === "object" && options.provider) return options.provider;
  const provider = options.provider ?? "firecrawl";
  if (provider === "firecrawl") return createFirecrawlProvider(options);
  if (provider === "mistral-ocr") return createMistralOcrProvider(options);
  if (provider === "llamaparse") return createLlamaParseProvider(options);
  throw new Error(`Unsupported document parsing provider: ${provider}`);
}

/**
 * @param {unknown} input
 * @returns {Parameters<DocumentParsingProvider["parseDocument"]>[0]}
 */
function normalizeInput(input) {
  const value = /** @type {Parameters<DocumentParsingProvider["parseDocument"]>[0]} */ (input ?? {});
  if (!value.source || typeof value.source !== "object") {
    throw new Error("parse_document requires a source");
  }
  return value;
}

/**
 * @param {DocumentParsingToolsetOptions} options
 * @returns {DocumentParsingProvider}
 */
function createFirecrawlProvider(options) {
  const request = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? "https://api.firecrawl.dev/v2";
  const apiKey = options.apiKey ?? process.env.FIRECRAWL_API_KEY;
  return {
    name: "firecrawl",
    async parseDocument(input) {
      if (input.source.type !== "url") return parseFirecrawlFile(request, baseUrl, apiKey, input);
      const json = await postJson(request, `${baseUrl}/scrape`, apiKey, {
        url: input.source.url,
        formats: [input.outputFormat === "text" ? "markdown" : (input.outputFormat ?? "markdown")],
        onlyMainContent: false,
      });
      const data = pickObject(json, "data") ?? pickObject(json, "result") ?? pickObject(json, undefined);
      const markdown = pickString(data, "markdown");
      const text = pickString(data, "text") ?? pickString(data, "content") ?? markdown ?? "";
      return {
        provider: "firecrawl",
        text,
        ...(markdown ? { markdown } : {}),
        ...(pickObject(data, "metadata") ? { metadata: pickObject(data, "metadata") } : {}),
        raw: json,
      };
    },
  };
}

/**
 * @param {typeof fetch} request
 * @param {string} baseUrl
 * @param {string | undefined} apiKey
 * @param {Parameters<DocumentParsingProvider["parseDocument"]>[0]} input
 */
async function parseFirecrawlFile(request, baseUrl, apiKey, input) {
  const json = await postMultipart(request, `${baseUrl}/parse`, apiKey, createDocumentFormData(input, createFirecrawlOptions(input)));
  const data = pickObject(json, "data") ?? pickObject(json, "result") ?? pickObject(json, undefined);
  const markdown = pickString(data, "markdown");
  const text = pickString(data, "text") ?? pickString(data, "content") ?? markdown ?? "";
  return {
    provider: "firecrawl",
    text,
    ...(markdown ? { markdown } : {}),
    ...(pickObject(data, "metadata") ? { metadata: pickObject(data, "metadata") } : {}),
    raw: json,
  };
}

/**
 * @param {DocumentParsingToolsetOptions} options
 * @returns {DocumentParsingProvider}
 */
function createMistralOcrProvider(options) {
  const request = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? "https://api.mistral.ai/v1";
  const apiKey = options.apiKey ?? process.env.MISTRAL_API_KEY;
  return {
    name: "mistral-ocr",
    async parseDocument(input) {
      if (input.source.type === "text") {
        return { provider: "mistral-ocr", text: input.source.text, raw: { source: "text" } };
      }
      const document = input.source.type === "url"
        ? { type: "document_url", document_url: input.source.url }
        : input.source.type === "base64"
          ? createMistralBase64Document(input.source)
          : undefined;
      const json = await postJson(request, `${baseUrl}/ocr`, apiKey, {
        model: "mistral-ocr-latest",
        document,
        ...(input.instructions ? { prompt: input.instructions } : {}),
      });
      const pages = Array.isArray(json?.pages) ? json.pages.map(normalizePage).filter(Boolean) : undefined;
      const markdown = pages?.map((page) => page.markdown || page.text || "").filter(Boolean).join("\n\n");
      return {
        provider: "mistral-ocr",
        text: markdown || pickString(json, "text") || "",
        ...(markdown ? { markdown } : {}),
        ...(pages?.length ? { pages } : {}),
        raw: json,
      };
    },
  };
}

/**
 * @param {DocumentParsingToolsetOptions} options
 * @returns {DocumentParsingProvider}
 */
function createLlamaParseProvider(options) {
  const request = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? "https://api.cloud.llamaindex.ai";
  const apiKey = options.apiKey ?? process.env.LLAMA_CLOUD_API_KEY;
  return {
    name: "llamaparse",
    async parseDocument(input) {
      const fileId = input.source.type === "url" ? undefined : await uploadLlamaParseFile(request, baseUrl, apiKey, input);
      const created = await postJson(request, `${baseUrl}/api/v2/parse`, apiKey, {
        ...(fileId ? { file_id: fileId } : { source_url: input.source.url }),
        tier: "agentic",
        version: "latest",
        expand: input.outputFormat === "text" ? ["text_full", "metadata"] : ["markdown_full", "text_full", "metadata"],
        ...(input.instructions ? { parsing_instruction: input.instructions } : {}),
      });
      const jobId = pickString(pickObject(created, "job") ?? created, "id");
      if (!jobId) throw new Error("LlamaParse did not return a parse job id");
      const json = await pollLlamaParseJob(request, baseUrl, apiKey, jobId, input.outputFormat);
      const markdown = pickString(json, "markdown_full") ?? pickString(pickObject(json, "markdown"), "text");
      const text = pickString(json, "text_full") ?? pickString(pickObject(json, "text"), "text") ?? markdown ?? "";
      return {
        provider: "llamaparse",
        text,
        ...(markdown ? { markdown } : {}),
        ...(pickObject(json, "metadata") ? { metadata: pickObject(json, "metadata") } : {}),
        raw: json,
      };
    },
  };
}

/**
 * @param {typeof fetch} request
 * @param {string} baseUrl
 * @param {string | undefined} apiKey
 * @param {Parameters<DocumentParsingProvider["parseDocument"]>[0]} input
 */
async function uploadLlamaParseFile(request, baseUrl, apiKey, input) {
  const json = await postMultipart(request, `${baseUrl}/api/v1/files/`, apiKey, createDocumentFormData(input));
  const fileId = pickString(json, "id");
  if (!fileId) throw new Error("LlamaParse did not return an uploaded file id");
  return fileId;
}

/**
 * @param {typeof fetch} request
 * @param {string} url
 * @param {string | undefined} apiKey
 * @param {unknown} body
 * @returns {Promise<any>}
 */
async function postJson(request, url, apiKey, body) {
  if (!apiKey) throw new Error(`Missing API key for ${url}`);
  const response = await request(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(`Document parsing provider failed (${response.status}): ${message || response.statusText}`);
  }
  return response.json();
}

/**
 * @param {typeof fetch} request
 * @param {string} url
 * @param {string | undefined} apiKey
 * @param {FormData} body
 * @returns {Promise<any>}
 */
async function postMultipart(request, url, apiKey, body) {
  if (!apiKey) throw new Error(`Missing API key for ${url}`);
  const response = await request(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    body,
  });
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(`Document parsing provider failed (${response.status}): ${message || response.statusText}`);
  }
  return response.json();
}

/**
 * @param {typeof fetch} request
 * @param {string} baseUrl
 * @param {string | undefined} apiKey
 * @param {string} jobId
 * @param {"text" | "markdown" | "json" | undefined} outputFormat
 * @returns {Promise<any>}
 */
async function pollLlamaParseJob(request, baseUrl, apiKey, jobId, outputFormat) {
  const expand = outputFormat === "text" ? "text_full,metadata" : "markdown_full,text_full,metadata";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const json = await getJson(request, `${baseUrl}/api/v2/parse/${encodeURIComponent(jobId)}?expand=${expand}`, apiKey);
    const job = pickObject(json, "job") ?? json;
    const status = pickString(job, "status");
    if (status === "COMPLETED" || status === "completed") return json;
    if (status === "FAILED" || status === "failed" || status === "CANCELLED" || status === "cancelled") {
      throw new Error(`LlamaParse job ${jobId} ${status}: ${pickString(job, "error_message") ?? "no error details"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`LlamaParse job ${jobId} did not complete before timeout`);
}

/**
 * @param {typeof fetch} request
 * @param {string} url
 * @param {string | undefined} apiKey
 * @returns {Promise<any>}
 */
async function getJson(request, url, apiKey) {
  if (!apiKey) throw new Error(`Missing API key for ${url}`);
  const response = await request(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(`Document parsing provider failed (${response.status}): ${message || response.statusText}`);
  }
  return response.json();
}

/**
 * @param {unknown} value
 * @returns {{ index: number; text?: string; markdown?: string; images?: unknown[] } | null}
 */
function normalizePage(value) {
  if (!value || typeof value !== "object") return null;
  const page = /** @type {Record<string, unknown>} */ (value);
  return {
    index: typeof page.index === "number" ? page.index : typeof page.page === "number" ? page.page : 0,
    ...(typeof page.text === "string" ? { text: page.text } : {}),
    ...(typeof page.markdown === "string" ? { markdown: page.markdown } : {}),
    ...(Array.isArray(page.images) ? { images: page.images } : {}),
  };
}

/**
 * @param {unknown} value
 * @param {string | undefined} key
 * @returns {Record<string, unknown> | undefined}
 */
function pickObject(value, key) {
  const target = key && value && typeof value === "object" ? /** @type {Record<string, unknown>} */ (value)[key] : value;
  return target && typeof target === "object" && !Array.isArray(target) ? /** @type {Record<string, unknown>} */ (target) : undefined;
}

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {string | undefined}
 */
function pickString(value, key) {
  return value && typeof value === "object" && typeof /** @type {Record<string, unknown>} */ (value)[key] === "string"
    ? /** @type {string} */ (/** @type {Record<string, unknown>} */ (value)[key])
    : undefined;
}

/**
 * @param {Parameters<DocumentParsingProvider["parseDocument"]>[0]} input
 * @param {unknown} [options]
 * @returns {FormData}
 */
function createDocumentFormData(input, options) {
  const form = new FormData();
  form.append("file", sourceToBlob(input.source), sourceFilename(input.source));
  if (options) form.append("options", JSON.stringify(options));
  return form;
}

/**
 * @param {Parameters<DocumentParsingProvider["parseDocument"]>[0]} input
 */
function createFirecrawlOptions(input) {
  return {
    formats: [input.outputFormat === "json" ? "json" : (input.outputFormat ?? "markdown")],
    ...(input.source.type === "base64" && (input.source.mimeType ?? "").includes("pdf")
      ? { parsers: [{ type: "pdf", mode: "auto" }] }
      : {}),
    ...(input.instructions ? { prompt: input.instructions } : {}),
  };
}

/**
 * @param {Parameters<DocumentParsingProvider["parseDocument"]>[0]["source"]} source
 * @returns {Blob}
 */
function sourceToBlob(source) {
  if (source.type === "base64") {
    return new Blob([Buffer.from(source.data, "base64")], { type: source.mimeType ?? "application/octet-stream" });
  }
  if (source.type === "text") return new Blob([source.text], { type: "text/html" });
  throw new Error("File upload requires base64 or text source");
}

/**
 * @param {Parameters<DocumentParsingProvider["parseDocument"]>[0]["source"]} source
 * @returns {string}
 */
function sourceFilename(source) {
  if (source.type === "base64") return source.filename ?? defaultFilename(source.mimeType);
  if (source.type === "text") return source.filename ?? "document.html";
  return "document";
}

/**
 * @param {string | undefined} mimeType
 */
function defaultFilename(mimeType) {
  if (mimeType === "application/pdf") return "document.pdf";
  if (mimeType === "text/html") return "document.html";
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "document.docx";
  if (mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "document.xlsx";
  return "document.bin";
}

/**
 * @param {{ type: "base64"; data: string; mimeType?: string; filename?: string }} source
 */
function createMistralBase64Document(source) {
  const dataUrl = `data:${source.mimeType ?? "application/pdf"};base64,${source.data}`;
  if ((source.mimeType ?? "").startsWith("image/")) return { type: "image_url", image_url: dataUrl };
  return { type: "document_url", document_url: dataUrl };
}
