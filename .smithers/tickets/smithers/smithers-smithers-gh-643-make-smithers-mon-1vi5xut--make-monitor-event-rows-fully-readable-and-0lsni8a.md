# Make Monitor event rows fully readable and inspectable

GitHub: https://github.com/smithersai/smithers/issues/1131

Parent: smithers/smithers-gh-643-make-smithers-monitor-trul-0iz5n9a--polish-the-events-stream-and-event-filtering.md

Context: Monitor event rows must support fast triage and detailed investigation without becoming noisy. Acceptance criteria: render every row with an unambiguous sequence number, event type, node identifier when present, and concise human-readable detail; support long and multiline payloads without breaking row layout; add focused unit/rendering coverage for representative lifecycle, node, agent, output, and failure events.
