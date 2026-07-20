/**
 * Linear integration configuration. Explicit values win over values
 * registered via `configureLinear`, which win over the
 * `SMITHERS_LINEAR_API_KEY` / `SMITHERS_LINEAR_WEBHOOK_SECRET` /
 * `SMITHERS_LINEAR_API_BASE_URL` environment variables.
 */
type LinearConfig = {
    /** Linear personal API key (sent raw in `Authorization`). */
    apiKey?: string;
    /** Webhook signing secret for `Linear-Signature` verification. */
    webhookSecret?: string;
    /** GraphQL endpoint override (tests point this at a fixture server). @default "https://api.linear.app/graphql" */
    apiBaseUrl?: string;
};
/** LinearConfig with every layer (explicit/registered/env) merged in. */
type ResolvedLinearConfig = {
    apiKey: string | undefined;
    webhookSecret: string | undefined;
    apiBaseUrl: string;
};

export type { LinearConfig, ResolvedLinearConfig };
