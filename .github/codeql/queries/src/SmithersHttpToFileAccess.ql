/**
 * @name Network data written to file
 * @description Writing network data directly to the file system allows arbitrary file upload and might indicate a backdoor.
 * @kind path-problem
 * @problem.severity warning
 * @security-severity 6.3
 * @precision medium
 * @id smithers/js-http-to-file-access
 * @tags security
 *       external/cwe/cwe-912
 *       external/cwe/cwe-434
 */

import javascript
import semmle.javascript.security.dataflow.HttpToFileAccessCustomizations::HttpToFileAccess as HttpToFileAccessCustomizations
import semmle.javascript.security.dataflow.HttpToFileAccessQuery
import HttpToFileAccessFlow::PathGraph

/**
 * Stop network-to-file taint only after one of the two audited review artifact
 * constructors has reduced the value to its fixed, validated schema. Both the
 * constructor name and its call-site path are part of this security boundary.
 */
private class AuditedReviewArtifactBoundary extends HttpToFileAccessCustomizations::Sanitizer {
  AuditedReviewArtifactBoundary() {
    exists(CallExpr call |
      this.asExpr() = call and
      call.getCallee() instanceof VarAccess and
      (
        call.getCalleeName() = "serializeValidatedReviewArtifact" and
        call.getFile().getRelativePath() = "apps/review/action/src/runAction.ts"
        or
        call.getCalleeName() = "buildCanonicalReviewSummary" and
        call.getFile().getRelativePath() = "apps/review/src/cli/main.ts"
        or
        call.getCalleeName() = "serializeValidatedReviewArtifact" and
        call.getFile().getRelativePath() = "SmithersHttpToFileAccess.js"
        or
        call.getCalleeName() = "buildCanonicalReviewSummary" and
        call.getFile().getRelativePath() = "SmithersHttpToFileAccess.js"
      )
    )
  }
}

from HttpToFileAccessFlow::PathNode source, HttpToFileAccessFlow::PathNode sink
where HttpToFileAccessFlow::flowPath(source, sink)
select sink.getNode(), source, sink, "Write to file system depends on $@.", source.getNode(),
  "Untrusted data"
