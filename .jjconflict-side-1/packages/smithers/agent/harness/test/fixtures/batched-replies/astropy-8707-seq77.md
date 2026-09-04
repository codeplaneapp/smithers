```cell
const s = ctx.state
return {
  intent: "continue",
  state: s,
  context: [
    { role: "user", text: "Relevant stored inspection data:\nHEADER:\n" + JSON.stringify(s.header) + "\nCARD:\n" + JSON.stringify(s.card) + "\nTEST HITS:\n" + JSON.stringify(s.hits) + "\nPROBE INPUT:\n" + JSON.stringify(s.probeInput) + "\nPROBE RESULT:\n" + JSON.stringify(s.probe) }
  ],
  justification: "The captured source excerpts are in durable state but were not visible in the model context; surfacing them is required to make the source edit without re-reading files."
}
```

```cell
const s = ctx.state
return {
  intent: "continue",
  state: s,
  context: [
    { role: "user", text: "Relevant stored inspection data:\nHEADER:\n" + JSON.stringify(s.header) + "\nCARD:\n" + JSON.stringify(s.card) + "\nTEST HITS:\n" + JSON.stringify(s.hits) + "\nPROBE INPUT:\n" + JSON.stringify(s.probeInput) + "\nPROBE RESULT:\n" + JSON.stringify(s.probe) }
  ],
  justification: "The captured source excerpts are in durable state but were not visible in the model context; surfacing them is required to make the source edit without re-reading files."
}
```
