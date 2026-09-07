/*
 * The `auth` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { flow, NoPayload } from "./Declare"
import type { FlowEntry } from "../registry"
import type { CommandActions } from "./Declare"

/** The `auth` flows registered as one aggregator block. */
export const authFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    /*
     * The OAuth redirect leaves the page (or, natively, opens the system
     * browser): the human's gesture, so user-only — auth.prompt below is the
     * agent's door, rendering this button in the chat.
     */
    name: "auth.sign-in",
    summary: "Sign in with GitHub",
    runtime: ["identity"],
    userOnly: true,
    userOnlyReason: "the GitHub OAuth redirect is the human's browser gesture; the agent renders the step with auth.prompt",
    input: NoPayload,
    handler: () => actions.signIn()
  }),
  flow({
    /*
     * The agent's door to login: it cannot run auth.sign-in (user-only —
     * navigation is the human's act), but it CAN render the step. The
     * message's action IS the sign-in button, one click away.
     */
    name: "auth.prompt",
    summary: "Offer the GitHub sign-in step in the chat",
    runtime: ["identity"],
    input: NoPayload,
    handler: () => actions.promptSignIn()
  }),
  flow({
    /* Signing out needs a session: offering it signed out is the clearest
		   case of a listing that names a step the user cannot take (§1.2). */
    name: "auth.sign-out",
    summary: "Sign out of Smithers",
    runtime: ["identity"],
    userOnly: true,
    userOnlyReason: "dropping the human's session is theirs alone",
    requires: ["signed-in"],
    input: NoPayload,
    handler: () => actions.signOut()
  }),
  flow({
    name: "auth.request-access",
    summary: "Request access to Smithers",
    runtime: ["identity"],
    requires: ["signed-in"],
    input: NoPayload,
    handler: () => actions.requestAccess()
  })
]
