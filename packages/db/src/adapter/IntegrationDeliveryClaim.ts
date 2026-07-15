/** Durable outcome of claiming one integration event for delivery. */
export type IntegrationDeliveryClaim =
  | {
      status: "claimed";
      receivedAtMs: number;
      leaseExpiresAtMs: number;
    }
  | {
      status: "completed";
      receivedAtMs: number;
    }
  | {
      status: "busy";
      receivedAtMs: number;
      leaseExpiresAtMs: number | null;
    };
