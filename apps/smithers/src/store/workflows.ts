import type { CommandId } from "../commands";

/**
 * The shape of a workflow card in the store / concierge router.
 *
 * The catalog itself is NO LONGER a locally static seed — it is sourced live from
 * the gateway `listWorkflows` RPC (`useGatewayWorkflows`) and shaped by
 * `toStoreWorkflow`/`mapToStoreWorkflows` in `workflowMetadata.ts`, which merges
 * the live row (`key`/`readableName`/`description`) with client-side display
 * metadata (`icon`/`category`/`color`) and chat-affordance fields
 * (`command`/`starter`). This module now exports only the TYPE; the retired
 * `STORE_WORKFLOWS` / `EXAMPLE_WORKFLOWS` seeds were deleted in the P1a rewire
 * (docs/p1a-plan.md §3.D, Option A: installed-only, sourced from the gateway).
 */
export type StoreWorkflow = {
  id: string;
  name: string;
  description: string;
  /** Emoji shown in the card badge. */
  icon: string;
  category: string;
  /** Accent color for the card. */
  color: string;
  /** If set, opening the workflow switches to this view. */
  command?: CommandId;
  /** If set, opening prefills the chat composer with this starter prompt. */
  starter?: string;
};
