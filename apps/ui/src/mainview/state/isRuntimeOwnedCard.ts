import type { Card } from "./AppState"

/** These cards carry human authority or continue a flow as its original actor. */
export const isRuntimeOwnedCard = (card: Pick<Card, "kind"> | undefined): boolean =>
  card?.kind === "approval" || card?.kind === "approvals-inbox" ||
  card?.kind === "grant-confirm" || card?.kind === "flow-form"
