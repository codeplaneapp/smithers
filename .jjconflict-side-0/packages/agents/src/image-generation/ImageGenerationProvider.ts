import type { ImageGenerationRequest } from "./ImageGenerationRequest.js";
import type { ImageGenerationResult } from "./ImageGenerationResult.js";

export type ImageGenerationProvider = {
  name?: string;
  generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult> | ImageGenerationResult;
};
