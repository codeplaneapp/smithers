/*
 * The card renderer map: every card kind, from the family that owns it.
 *
 * Each family file under ./ exports its slice (CardFamily.ts). This file
 * spreads the slices into one record keyed by kind; the mapped type makes a
 * kind without an entry a compile error, and CardRenderers.test.ts proves the
 * slices are disjoint and cover exactly the wire's card kinds. A new card kind
 * is one import plus one spread line here.
 */
import type { Card } from "../state/AppState"
import { accountCardFamily } from "./AccountCard"
import { adminCardFamily } from "./AdminCards"
import { affectedCardFamily } from "./AffectedCard"
import { agentCardFamily } from "./AgentCards"
import { anonymousCeilingCardFamily } from "./AnonymousCeilingCard"
import { approvalCardFamily } from "./ApprovalCard"
import { billingCardFamily } from "./BillingCards"
import { branchesCardFamily } from "./BranchesCard"
import type { CardActions, CardFamily, CardFamilyEntry } from "./CardFamily"
import { changeCardFamily } from "./ChangeCards"
import { ciMatrixCardFamily } from "./CiMatrixCard"
import { conversationCardFamily } from "./ConversationCards"
import { envCardFamily } from "./EnvCard"
import { fileCardFamily } from "./FileCards"
import { flowFormCardFamily } from "./FlowFormCards"
import { graphCardFamily } from "./GraphCardLazy"
import { issueCardFamily } from "./IssueCards"
import { landingCardFamily } from "./LandingCards"
import { notificationsCardFamily } from "./NotificationsCard"
import { onboardingCardFamily } from "./OnboardingCards"
import { repoImportCardFamily } from "./RepoImportCard"
import { runHistoryCardFamily } from "./RunHistoryCard"
import { runsCardFamily } from "./RunsCards"
import { runTimelineCardFamily } from "./RunTimelineCard"
import { secretsCardFamily } from "./SecretsCard"
import { serviceLogCardFamily } from "./ServiceLogCard"
import { syncCardFamily } from "./SyncCards"
import { targetCardFamily } from "./TargetCards"
import { themePickerCardFamily } from "./ThemePickerCard"
import { triggersCardFamily } from "./TriggersCard"
import { turnCardFamily } from "./TurnCards"
import { workflowCardFamily } from "./WorkflowCards"
import { workspaceCardFamily } from "./WorkspaceCard"

/** The families in registration order; the test reads this list to prove the slices are disjoint. */
export const CARD_FAMILIES: ReadonlyArray<CardFamily<never>> = [
  turnCardFamily,
  approvalCardFamily,
  billingCardFamily,
  adminCardFamily,
  conversationCardFamily,
  workflowCardFamily,
  triggersCardFamily,
  runsCardFamily,
  onboardingCardFamily,
  issueCardFamily,
  landingCardFamily,
  changeCardFamily,
  notificationsCardFamily,
  envCardFamily,
  secretsCardFamily,
  accountCardFamily,
  repoImportCardFamily,
  syncCardFamily,
  branchesCardFamily,
  fileCardFamily,
  themePickerCardFamily,
  targetCardFamily,
  graphCardFamily,
  runTimelineCardFamily,
  runHistoryCardFamily,
  affectedCardFamily,
  ciMatrixCardFamily,
  agentCardFamily,
  flowFormCardFamily,
  workspaceCardFamily,
  serviceLogCardFamily,
  anonymousCeilingCardFamily
]

/** One entry per card kind. Written as a literal so a missing kind fails to compile. */
export const CARD_RENDERERS: CardFamily<Card["kind"]> = {
  ...turnCardFamily,
  ...approvalCardFamily,
  ...billingCardFamily,
  ...adminCardFamily,
  ...conversationCardFamily,
  ...workflowCardFamily,
  ...triggersCardFamily,
  ...runsCardFamily,
  ...onboardingCardFamily,
  ...issueCardFamily,
  ...landingCardFamily,
  ...changeCardFamily,
  ...notificationsCardFamily,
  ...envCardFamily,
  ...secretsCardFamily,
  ...accountCardFamily,
  ...repoImportCardFamily,
  ...syncCardFamily,
  ...branchesCardFamily,
  ...fileCardFamily,
  ...themePickerCardFamily,
  ...targetCardFamily,
  ...graphCardFamily,
  ...runTimelineCardFamily,
  ...runHistoryCardFamily,
  ...affectedCardFamily,
  ...ciMatrixCardFamily,
  ...agentCardFamily,
  ...flowFormCardFamily,
  ...workspaceCardFamily,
  ...serviceLogCardFamily,
  ...anonymousCeilingCardFamily
}

/** The entry for one kind, typed to that kind's card. */
export const cardRenderer = <K extends Card["kind"]>(kind: K): CardFamilyEntry<K> => CARD_RENDERERS[kind]

/**
 * The header's status word. An error card wears "failed" whatever its kind;
 * otherwise the family that owns the kind answers.
 */
export const pillStatus = (card: Card): string => {
  if (card.status === "error") return "failed"
  return cardRenderer(card.kind).pill(card)
}

/** The card's body, from the family that owns its kind. */
export const renderCardBody = (card: Card, actions: CardActions) => cardRenderer(card.kind).render(card, actions)
