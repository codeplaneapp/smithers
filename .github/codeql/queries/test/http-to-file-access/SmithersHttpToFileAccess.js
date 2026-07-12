var fs = require("fs");
var express = require("express");
var app = express();

function serializeValidatedReviewArtifact(value) {
  return value;
}

function buildCanonicalReviewSummary(value) {
  return value;
}

app.post("/artifacts", (request, response) => {
  const raw = request.query.raw; // $ Source[smithers/js-http-to-file-access]
  fs.writeFileSync("/tmp/raw", raw); // $ Alert[smithers/js-http-to-file-access]

  const artifact = serializeValidatedReviewArtifact(request.query.artifact);
  fs.writeFileSync("/tmp/artifact.json", artifact);

  const summary = buildCanonicalReviewSummary(request.query.summary);
  fs.writeFileSync("/tmp/summary.json", summary);

  response.sendStatus(204);
});
