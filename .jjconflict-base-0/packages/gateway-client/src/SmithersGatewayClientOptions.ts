export type SmithersGatewayClientOptions = {
  baseUrl?: string;
  token?: string;
  headers?: HeadersInit;
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  client?: {
    id?: string;
    version?: string;
    platform?: string;
  };
};
