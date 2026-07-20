export type ImageGenerationToolOptions = {
  /** Tool name used when returning a toolset. */
  name?: string;
  /** Description shown to the model. */
  description?: string;
  /** Provider model to use when the agent does not specify one. */
  model?: string;
  /** Return `{ [name]: tool }` for direct mounting on an agent. */
  asToolset?: boolean;
};
