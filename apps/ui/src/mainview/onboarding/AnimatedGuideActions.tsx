import { useState, type ReactNode } from "react"

/** Only the retiring visual is transient; the active lesson belongs to the persisted guide. */
export function AnimatedGuideActions({ step, children }: { step: number; children: ReactNode }) {
  const [frames, setFrames] = useState({ step, current: children, retiring: null as ReactNode })
  if (frames.step !== step) {
    setFrames({ step, current: children, retiring: frames.current })
  }
  return (
    <div className="guide-action-transition">
      {frames.retiring && (
        <div
          key={`out-${frames.step}`}
          className="guide-action-retiring"
          inert
          aria-hidden="true"
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget) setFrames(frame => ({ ...frame, retiring: null }))
          }}
        >
          {frames.retiring}
        </div>
      )}
      <div key={step} className="guide-action-current">{children}</div>
    </div>
  )
}
