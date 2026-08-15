export type ConnectRequest = {
  minProtocol: number;
  maxProtocol: number;
  client: {
    id: string;
    version: string;
    platform: string;
    pid?: number;
  };
  auth?: {
    token: string;
  };
  subscribe?: string[];
};
