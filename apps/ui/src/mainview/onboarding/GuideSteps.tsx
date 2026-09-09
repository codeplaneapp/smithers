import type { ReactNode } from "react"

/*
 * Human instructions, numbered. A lesson that asks the human for a gesture
 * renders the gesture as steps — "1. Press ⌘ K and type a message to me" —
 * so the ask reads as something to do, not a paragraph to decode. The steps
 * are the props; any lesson can use it.
 */
export function GuideSteps({ steps }: { steps: ReadonlyArray<ReactNode> }) {
  return (
    <ol className="guide-steps">
      {steps.map((step, index) => (
        <li key={index}>
          <span className="guide-step-number" aria-hidden="true">{index + 1}</span>
          <span className="guide-step-body">{step}</span>
        </li>
      ))}
    </ol>
  )
}
