export type ImageGenerationResult = {
  provider?: string;
  model?: string;
  images: Array<{
    url?: string;
    base64?: string;
    mimeType?: string;
    revisedPrompt?: string;
  }>;
};
