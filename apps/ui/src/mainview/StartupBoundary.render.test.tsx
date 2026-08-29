import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { MountedSignal, StartupErrorBoundary } from "./StartupBoundary"

GlobalRegistrator.register()

afterAll(async () => {
  // React's scheduler finishes a commit in a task of its own; unregistering the
  // DOM before it runs takes `window` away mid-flight.
  await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

afterEach(() => {
  document.body.textContent = ""
})

const mount = (children: React.ReactNode): void => {
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => createRoot(host).render(children))
}

/*
 * Stands in for `use(bootPromise)`: a rejected boot is delivered to the
 * boundary as a throw from the child's render, which is the only thing the
 * boundary itself can observe.
 */
const Throws = ({ error }: { readonly error: Error }) => {
  throw error
}

describe("the startup error boundary", () => {
  /*
   * The defect this pins: apps/ui had no error boundary at all, so a rejected
   * boot thrown by `use()` tore the tree down and left a blank page with no
   * message — the exact failure the startup watchdog exists to report.
   */
  test("renders the startup panel and reports the failure", () => {
    let reported: unknown
    const consoleError = console.error
    console.error = () => {}
    mount(
      <StartupErrorBoundary onError={(error) => void (reported = error)}>
        <Throws error={new Error("create app store: opfs unavailable")} />
      </StartupErrorBoundary>
    )
    console.error = consoleError
    expect(document.body.textContent).toContain("Smithers failed to start")
    expect(document.body.textContent).toContain("opfs unavailable")
    expect(document.body.textContent).toContain("Reload to try again")
    expect(reported).toBeInstanceOf(Error)
  })

  test("renders children untouched when nothing throws", () => {
    mount(
      <StartupErrorBoundary onError={() => {}}>
        <p>the app</p>
      </StartupErrorBoundary>
    )
    expect(document.body.textContent).toBe("the app")
  })
})

describe("the mounted signal", () => {
  test("reports the mount and renders nothing itself", () => {
    let mounted = 0
    mount(
      <StartupErrorBoundary onError={() => {}}>
        <MountedSignal onMounted={() => void (mounted += 1)} />
        <p>the app</p>
      </StartupErrorBoundary>
    )
    expect(mounted).toBe(1)
    expect(document.body.textContent).toBe("the app")
  })

  test("never reports a mount when the tree it sits in fails first", () => {
    let mounted = 0
    const consoleError = console.error
    console.error = () => {}
    mount(
      <StartupErrorBoundary onError={() => {}}>
        <MountedSignal onMounted={() => void (mounted += 1)} />
        <Throws error={new Error("boot rejected")} />
      </StartupErrorBoundary>
    )
    console.error = consoleError
    expect(mounted).toBe(0)
    expect(document.body.textContent).toContain("Smithers failed to start")
  })
})
