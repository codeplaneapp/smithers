import { expect, test } from "bun:test"
import type { FetchLike } from "@smthrs/rpc/NativeAgent"
import { createAppStore } from "../AppStore"
import { initialGuide } from "../AppState"
import { createGuideController } from "./guide"
import type { ControllerContext } from "./context"

const setup = async (step: number, rawHttp: FetchLike) => {
  const data = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) } } })
  await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step } }).isPersisted.promise
  const controller = createGuideController({ store, rawHttp, commandActor: "user" } as unknown as ControllerContext)
  return { store, controller }
}

test("optional answers submit only on continue and failed saves keep the form and stable retry id", async () => {
  const payloads: any[] = []
  let ok = false
  const { store, controller } = await setup(3, (async (_url, init) => { payloads.push(JSON.parse(String(init?.body))); return Response.json({ saved: ok }, { status: ok ? 200 : 503 }) }) as FetchLike)
  await controller.guideAct("heard", "A friend")
  expect(payloads).toHaveLength(0)
  expect(await controller.guideAct("next")).toContain("could not be saved")
  expect(store.session().guide?.step).toBe(3)
  ok = true
  await controller.guideAct("next")
  expect(store.session().guide?.step).toBe(4)
  expect(payloads[1].id).toBe(payloads[0].id)
  expect(payloads[1].heard).toBe("A friend")
  await store.dispose?.()
})

test("empty optional form advances without a cloud write", async () => {
  const { store, controller } = await setup(3, (async () => { throw Error("should not fetch") }) as FetchLike)
  await controller.guideAct("next")
  expect(store.session().guide?.step).toBe(4)
  await store.dispose?.()
})

test("the theme lesson flips the theme, advances, and restores the starting theme", async () => {
  const { store, controller } = await setup(1, fetch)
  expect(store.session().theme).toBe("light")
  const demo = controller.guideAct("dark")
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(store.session().theme).toBe("dark")
  expect(store.session().guide?.step).toBe(2)
  await demo
  expect(store.session().theme).toBe("light")
  expect(store.session().guide?.step).toBe(2)
  /* The demonstration belongs to its lesson: step 2 offers no repeat. */
  expect(await controller.guideAct("dark")).toContain("belongs to its lesson")
  await store.dispose?.()
}, 5000)

test("every notify press sends its own notification", async () => {
  const { store, controller } = await setup(2, fetch)
  await controller.guideAct("notify")
  await controller.guideAct("notify")
  await controller.guideAct("notify")
  const toasts = [...store.collections.toasts.values()].filter((toast) => toast.key.startsWith("guide-hello-"))
  expect(toasts).toHaveLength(3)
  expect(new Set(toasts.map((toast) => toast.id)).size).toBe(3)
  for (const toast of toasts) {
    expect(toast.status).toBe("ok")
    expect(toast.title).toBe("You can keep working")
  }
  await store.dispose?.()
})

test("example flow waits five seconds then completes without overwriting navigation", async () => {
  const { store, controller } = await setup(4, fetch)
  const start = Date.now()
  const running = controller.guideAct("wait-flow")
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(store.session().guide?.demoRun?.status).toBe("running")
  const toastId = `toast-guide-flow-${store.session().guide?.demoRun?.id}`
  expect(store.collections.toasts.get(toastId)?.title).toBe("Waiting 5 seconds…")
  expect(store.collections.toasts.get(toastId)?.status).toBe("running")
  await controller.guideAct("next")
  await running
  expect(Date.now() - start).toBeGreaterThanOrEqual(5000)
  expect(store.session().guide?.demoRun?.status).toBe("succeeded")
  expect(store.collections.toasts.get(toastId)?.title).toBe("Done")
  expect(store.collections.toasts.get(toastId)?.status).toBe("ok")
  expect(store.session().guide?.step).toBe(5)
  await store.dispose?.()
}, 10000)
