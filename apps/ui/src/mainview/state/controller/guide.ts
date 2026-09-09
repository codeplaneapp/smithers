import { initialGuide } from "../AppState"
import type { GuideState } from "../AppState"
import type { ControllerContext } from "./context"

/** Durable, replayable onboarding. Practice artifacts never enter repository/run tables. */
export function createGuideController(ctx: ControllerContext) {
  const guideAct = async (action: string, value = ""): Promise<string | void> => {
    const guide: GuideState = { ...(ctx.store.session().guide ?? initialGuide()) }
    switch (action) {
      case "next":
        if ([5, 6, 7, 8, 9, 12].includes(guide.step)) return "Complete this lesson's action first."
        guide.step = Math.min(15, guide.step + 1)
        if (guide.step === 7) guide.conversationOpen = false
        break
      case "back":
        guide.step = Math.max(0, guide.step - 1)
        break
      case "restart":
        Object.assign(guide, initialGuide())
        break
      case "open":
        guide.conversationOpen = true
        if (guide.step === 7) guide.step = 8
        break
      case "close":
        guide.conversationOpen = false
        break
      case "toggle":
        guide.conversationOpen = !guide.conversationOpen
        if (guide.step === 7 && guide.conversationOpen) guide.step = 8
        break
      case "heard":
        guide.heard = value.slice(0, 500)
        break
      case "project":
        guide.project = value.slice(0, 500)
        break
      case "title":
        guide.prototypeTitle = value.slice(0, 100)
        break
      case "sound":
        guide.sound = !guide.sound
        break
      case "notify":
        ctx.store.dispatch({
          type: "toast.shown",
          actor: "system",
          key: "guide-hello",
          title: "A little hello from Smithers",
        })
        ctx.store.dispatch({
          type: "toast.resolved",
          actor: "system",
          key: "guide-hello",
          status: "ok",
          title: "You can keep working",
          detail: "This is a tutorial notification. I'll bring real flow updates here too.",
        })
        break
      case "dark":
      case "light":
        if (guide.step !== (action === "dark" ? 5 : 6))
          return "This theme demonstration belongs to its lesson."
        ctx.store.dispatch({ type: "theme.changed", actor: "system", theme: action })
        guide.step++
        break
      case "library":
        if (guide.step !== 8) return "Meet the Library in the plugin lesson."
        guide.library = true
        guide.step = 9
        guide.conversationOpen = false
        break
      case "librarian":
        if (guide.step !== 9 || !guide.library) return "Install the Library first."
        guide.librarian = true
        guide.step = 10
        break
      case "revise":
        if (guide.step !== 12 || !guide.prototypeTitle.trim()) return "Give the prototype a title first."
        guide.revised = true
        guide.step = 13
        break
      case "finish":
        guide.step = 15
        guide.conversationOpen = false
        break
      default:
        return `Unknown onboarding action: ${action}`
    }
    if (action === "next" && guide.step === 2) {
      ctx.store.dispatch({
        type: "toast.shown",
        actor: "system",
        key: "guide-introduction",
        title: "Hello from your notification corner",
      })
      ctx.store.dispatch({
        type: "toast.resolved",
        actor: "system",
        key: "guide-introduction",
        status: "ok",
        title: "Hello from your notification corner",
        detail: "A tutorial example. You can keep working; I'll bring updates to you.",
      })
    }
    await ctx.store.dispatch({ type: "guide.changed", actor: ctx.commandActor, guide }).isPersisted.promise
  }
  return { guideAct }
}
