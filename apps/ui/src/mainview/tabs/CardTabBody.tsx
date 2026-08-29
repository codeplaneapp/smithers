import { useLiveQuery } from "@tanstack/react-db"
import { CardView } from "../ChatCards"
import { useController } from "../ControllerContext"
import { useCardRows } from "../state/useCardRows"

/*
 * A card tab's body (docs/LOCAL-APP.md "Cards"): the SAME card component
 * over the SAME store record the transcript renders, so the tab is a
 * presentation of the card and never a second implementation. The command
 * bindings are the ones App.tsx gives the transcript's copy; every in-card
 * act still routes through the registry.
 */
export function CardTabBody({ cardId }: { readonly cardId: string }) {
  const controller = useController()
  const { collections } = controller.store
  const cardRows = useCardRows(collections.cards)
  const { data: worldDocumentRows } = useLiveQuery(collections.worldDocuments)
  const { data: sessionRows } = useLiveQuery((q) =>
    q.from({ session: collections.sessions }).select(({ session }) => ({
      id: session.id,
      maximizedCardId: session.maximizedCardId
    }))
  )
  const card = cardRows.find((candidate) => candidate.id === cardId)
  if (card === undefined) {
    // The card left the transcript (a /clear, a sign-out): the tab states it and offers nothing else.
    return <p className="card-tab-gone">This card is no longer in the conversation.</p>
  }
  const worldDocuments = [...worldDocumentRows].sort((left, right) => left.path.localeCompare(right.path))
  return (
    <div className="card-tab">
      <CardView
        card={card}
        maximized={sessionRows[0]?.maximizedCardId === card.id}
        onDecideApproval={(id, decision) =>
          controller.runCommandArgs(decision === "approved" ? "approval.approve" : "approval.deny", id)}
        onGrantConfirm={(id) => controller.runCommandArgs("admin.grant.confirm", id)}
        onGrantCancel={(id) => controller.runCommandArgs("admin.grant.cancel", id)}
        onQueueApprove={(login) => controller.runCommandArgs("admin.queue.approve", login)}
        onRepoToggle={(name) => controller.runCommandArgs("repos.watch.toggle", name)}
        onReposSelectAll={() => controller.runCommand("repos.watch.all")}
        onReposSelectNone={() => controller.runCommand("repos.watch.none")}
        onReposConfirm={() => controller.runCommand("repos.watch.confirm")}
        onMaximize={(id) => controller.runCommandArgs("card.maximize", id)}
        onMinimize={() => controller.runCommand("card.minimize")}
        onOpenInTab={(id) => controller.runCommandArgs("tab.card", id)}
        onConnectGitHub={() => controller.runCommand("auth.sign-in")}
        onConnectLocal={() => controller.runCommandArgs("connector.add", "read")}
        onRunWorkflow={(name) => controller.runCommandArgs("flow.run", name)}
        onStopRun={(id) => controller.runCommandArgs("flow.run.stop", id)}
        onRetryRun={(id) => controller.runCommandArgs("flow.run.retry", id)}
        onChooseWorkflowRepo={(name) => controller.runCommandArgs("flow.repo.choose", name)}
        worldDocuments={worldDocuments}
        onChangeWorldDocument={(id, body) => controller.changeWorldDocument(id, body)}
        onRunCommand={(name, commandArgs) =>
          commandArgs === undefined
            ? controller.runCommand(name)
            : controller.runCommandArgs(name, commandArgs)}
      />
    </div>
  )
}
