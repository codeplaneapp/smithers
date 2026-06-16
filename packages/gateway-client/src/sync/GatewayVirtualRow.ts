export type GatewayVirtualRow = {
  readonly $synced?: boolean;
  readonly $origin?: "local" | "remote";
  readonly $key?: string;
  readonly $collectionId?: string;
};
