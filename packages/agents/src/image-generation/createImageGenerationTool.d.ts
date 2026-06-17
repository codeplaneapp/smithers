import type { Tool } from "ai";
import type { ImageGenerationProvider } from "./ImageGenerationProvider.js";
import type { ImageGenerationToolOptions } from "./ImageGenerationToolOptions.js";

export type { ImageGenerationProvider } from "./ImageGenerationProvider.js";
export type { ImageGenerationRequest } from "./ImageGenerationRequest.js";
export type { ImageGenerationResult } from "./ImageGenerationResult.js";
export type { ImageGenerationToolOptions } from "./ImageGenerationToolOptions.js";

export declare function createImageGenerationTool(
  provider: ImageGenerationProvider,
  options: ImageGenerationToolOptions & { asToolset: true },
): Record<string, Tool>;

export declare function createImageGenerationTool(
  provider: ImageGenerationProvider,
  options?: ImageGenerationToolOptions,
): Tool;
