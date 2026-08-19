/** @typedef {import("./GenerateResult.ts").GenerateTextResult} GenerateTextResult */
/** @typedef {import("./GenerateResult.ts").StreamTextResult} StreamTextResult */
/**
 * @template TOOLS, OUTPUT
 * @param {StreamTextResult<TOOLS, any>} stream
 * @param {(text: string) => void} [onStdout]
 * @returns {Promise<GenerateTextResult<TOOLS, any>>}
 */
export async function streamResultToGenerateResult(stream, onStdout) {
  // When the provider rejects the request (e.g. a 404 "model not found"), the
  // AI SDK delivers an `error` part on the stream and then rejects the derived
  // promises (text/output/steps) with a generic NoOutputGeneratedError that
  // masks the real cause — which smithers' engine misclassifies as "the agent
  // did not return valid JSON for the declared output schema". Capture the
  // first error here so we can re-throw the genuine provider error instead.
  /** @type {unknown} */
  let streamError;
  if (onStdout) {
    const eventStream = stream.stream ?? stream.fullStream;
    for await (const part of eventStream) {
      if (part.type === "error") {
        if (streamError === undefined) streamError = part.error;
      } else if (part.type === "text-delta" && part.text) {
        onStdout(part.text);
      }
    }
  } else {
    await stream.consumeStream({
      onError: (error) => {
        if (streamError === undefined) streamError = error;
      },
    });
  }
  /** @type {any[]} */
  let resolved;
  try {
    resolved = await Promise.all([
      stream.content,
      stream.text,
      stream.reasoning,
      stream.reasoningText,
      stream.files,
      stream.sources,
      stream.toolCalls,
      stream.staticToolCalls,
      stream.dynamicToolCalls,
      stream.toolResults,
      stream.staticToolResults,
      stream.dynamicToolResults,
      stream.finishReason,
      stream.rawFinishReason,
      stream.usage,
      stream.totalUsage,
      stream.warnings,
      stream.steps,
      stream.request,
      stream.response,
      stream.providerMetadata,
      stream.output,
    ]);
  } catch (err) {
    // Prefer the captured provider error (the true 404/APICallError) over the
    // SDK's masking NoOutputGeneratedError.
    if (streamError !== undefined) throw streamError;
    throw err;
  }
  const [
    content,
    text,
    reasoning,
    reasoningText,
    files,
    sources,
    toolCalls,
    staticToolCalls,
    dynamicToolCalls,
    toolResults,
    staticToolResults,
    dynamicToolResults,
    finishReason,
    rawFinishReason,
    usage,
    totalUsage,
    warnings,
    steps,
    request,
    response,
    providerMetadata,
    output,
  ] = resolved;
  return {
    content,
    text,
    reasoning,
    reasoningText,
    files,
    sources,
    toolCalls,
    staticToolCalls,
    dynamicToolCalls,
    toolResults,
    staticToolResults,
    dynamicToolResults,
    finishReason,
    rawFinishReason,
    usage,
    totalUsage,
    warnings,
    request,
    response,
    providerMetadata,
    steps,
    output,
  };
}
