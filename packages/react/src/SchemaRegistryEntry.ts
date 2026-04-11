export type SchemaRegistryEntry = {
  readonly key: string;
  readonly value: unknown;
  readonly [key: string]: unknown;
};
