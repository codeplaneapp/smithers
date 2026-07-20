export type ImageGenerationRequest = {
  prompt: string;
  model?: string;
  size?: string;
  count?: number;
  seed?: number;
  style?: string;
};
