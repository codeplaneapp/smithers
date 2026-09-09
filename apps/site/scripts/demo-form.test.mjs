import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { setImmediate } from "node:timers/promises"
import { runInNewContext } from "node:vm"

const page = readFileSync(new URL("../src/pages/demo/index.astro", import.meta.url), "utf8")
const script = page.match(/<script define:vars=\{\{ endpoint \}\}>([\s\S]*?)<\/script>/)[1]

function mount(t, fetch, timeoutName = "TimeoutError") {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const values = { firstName: " Jane ", lastName: "Smith", workEmail: "jane@example.com", message: "A demo, please" }
  const classes = new Set()
  const status = { textContent: "", classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) } }
  const label = { textContent: "Continue" }
  const button = { disabled: false, querySelector: () => label }
  const thanks = { hidden: true }
  let submit
  const form = {
    hidden: false,
    values,
    reportValidity: () => true,
    querySelector: (selector) => selector === "[data-status]" ? status : button,
    addEventListener: (name, handler) => { assert.equal(name, "submit"); submit = handler }
  }
  runInNewContext(script, {
    document: { querySelector: (selector) => selector === "#demo-form" ? form : thanks },
    FormData: class { constructor(form) { return Object.entries(form.values) } },
    endpoint: "https://intake.example.test/api/demo-requests",
    fetch,
    AbortSignal: {
      // Native AbortSignal.timeout uses an internal clock; bind it to the test clock.
      timeout(ms) {
        const controller = new AbortController()
        setTimeout(() => controller.abort(new DOMException("Timed out", timeoutName)), ms)
        return controller.signal
      }
    }
  })
  return { form, thanks, button, label, status, classes, submit: () => submit({ preventDefault() {} }) }
}

for (const timeoutName of ["TimeoutError", "AbortError"]) {
  test(`a stalled request restores retry controls and retains values on ${timeoutName}`, async (t) => {
    let requests = 0
    const ui = mount(t, (_url, { signal }) => {
      if (++requests > 1) return Promise.resolve({ ok: true })
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
    }, timeoutName)
    const entered = { ...ui.form.values }
    const pending = ui.submit()
    assert.equal(ui.button.disabled, true)
    assert.equal(ui.label.textContent, "Sending…")
    t.mock.timers.tick(19_999)
    await setImmediate()
    assert.equal(ui.button.disabled, true)
    t.mock.timers.tick(1)
    await setImmediate()
    assert.equal(ui.button.disabled, false)
    assert.equal(ui.label.textContent, "Continue")
    assert.match(ui.status.textContent, /timed out.*try again/i)
    assert.equal(ui.classes.has("error"), true)
    assert.equal(ui.form.hidden, false)
    assert.equal(ui.thanks.hidden, true)
    assert.deepEqual(ui.form.values, entered)
    await pending
    await ui.submit()
    assert.equal(requests, 2)
    assert.equal(ui.form.hidden, true)
    assert.equal(ui.thanks.hidden, false)
    assert.equal(ui.status.textContent, "")
    assert.equal(ui.classes.has("error"), false)
  })
}

test("successful submission sends trimmed values and restores controls", async (t) => {
  let request
  const ui = mount(t, async (url, options) => { request = { url, options }; return { ok: true } })
  await ui.submit()
  assert.equal(request.url, "https://intake.example.test/api/demo-requests")
  assert.equal(request.options.method, "POST")
  assert.equal(request.options.headers["content-type"], "application/json")
  assert.deepEqual(JSON.parse(request.options.body), { ...ui.form.values, firstName: "Jane" })
  assert.equal(ui.form.hidden, true)
  assert.equal(ui.thanks.hidden, false)
  assert.equal(ui.button.disabled, false)
  assert.equal(ui.label.textContent, "Continue")
})

for (const failure of ["network", "http"]) {
  test(`${failure} failure restores controls and retains values`, async (t) => {
    const ui = mount(t, async () => {
      if (failure === "network") throw new TypeError("Failed to fetch")
      return { ok: false, status: 503 }
    })
    const entered = { ...ui.form.values }
    await ui.submit()
    assert.equal(ui.button.disabled, false)
    assert.equal(ui.label.textContent, "Continue")
    assert.match(ui.status.textContent, /Something went wrong/)
    assert.equal(ui.classes.has("error"), true)
    assert.equal(ui.form.hidden, false)
    assert.equal(ui.thanks.hidden, true)
    assert.deepEqual(ui.form.values, entered)
  })
}
