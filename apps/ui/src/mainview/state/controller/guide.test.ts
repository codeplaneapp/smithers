import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { initialGuide } from "../AppState"
import { createGuideController } from "./guide"
import type { ControllerContext } from "./context"

const setup = async (step: number, rawHttp: typeof fetch) => {
  const data = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) } } })
  await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step } }).isPersisted.promise
  const controller = createGuideController({ store, rawHttp, commandActor: "user" } as unknown as ControllerContext)
  return { store, controller }
}

test("optional answers submit only on continue and failed saves keep the form and stable retry id", async () => {
  const payloads: any[] = []
  let ok = false
  const { store, controller } = await setup(3, (async (_url, init) => { payloads.push(JSON.parse(String(init?.body))); return Response.json({ saved: ok }, { status: ok ? 200 : 503 }) }) as typeof fetch)
  await controller.guideAct("heard", "A friend")
  expect(payloads).toHaveLength(0)
  expect(await controller.guideAct("next")).toContain("could not be saved")
  expect(store.session().guide?.step).toBe(3)
  ok = true
  await controller.guideAct("next")
  expect(store.session().guide?.step).toBe(4)
  expect(payloads[1].id).toBe(payloads[0].id)
  expect(payloads[1].heard).toBe("A friend")
  await store.dispose()
})

test("empty optional form advances without a cloud write", async () => {
  const { store, controller } = await setup(3, (async () => { throw Error("should not fetch") }) as typeof fetch)
  await controller.guideAct("next")
  expect(store.session().guide?.step).toBe(4)
  await store.dispose()
})

test("example flow waits five seconds then completes without overwriting navigation", async () => {
  const { store, controller } = await setup(4, fetch)
  const start = Date.now()
  const running = controller.guideAct("wait-flow")
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(store.session().guide?.demoRun?.status).toBe("running")
  await controller.guideAct("next")
  await running
  expect(Date.now() - start).toBeGreaterThanOrEqual(5000)
  expect(store.session().guide?.demoRun?.status).toBe("succeeded")
  expect(store.session().guide?.step).toBe(5)
  await store.dispose()
}, 10000)
