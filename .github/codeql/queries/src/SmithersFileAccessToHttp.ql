/**
 * @name File data in outbound network request
 * @description Directly sending file data in an outbound network request can indicate unauthorized information disclosure.
 * @kind path-problem
 * @problem.severity warning
 * @security-severity 6.5
 * @precision medium
 * @id smithers/js-file-access-to-http
 * @tags security
 *       external/cwe/cwe-200
 */

import javascript
import semmle.javascript.security.dataflow.FileAccessToHttpCustomizations::FileAccessToHttp as FileAccessToHttpCustomizations
import semmle.javascript.security.dataflow.FileAccessToHttpQuery
import FileAccessToHttpFlow::PathGraph

/**
 * Stop file-to-network taint only after one of the two audited review
 * publication constructors has rebuilt and bounded the value. Both the
 * constructor name and its call-site path are part of this security boundary.
 */
private class AuditedReviewPublicationBoundary extends FileAccessToHttpCustomizations::Sanitizer {
  AuditedReviewPublicationBoundary() {
    exists(CallExpr call |
      this.asExpr() = call and
      call.getCallee() instanceof VarAccess and
      (
        call.getCalleeName() = "parseValidatedReviewArtifact" and
        call.getFile().getRelativePath() = "apps/review/action/src/publishReview.ts"
        or
        call.getCalleeName() = "authorizeWalkthroughUpload" and
        call.getFile().getRelativePath() = "apps/review/src/cli/publishWalkthrough.ts"
        or
        call.getCalleeName() = "parseValidatedReviewArtifact" and
        call.getFile().getRelativePath() = "SmithersFileAccessToHttp.js"
        or
        call.getCalleeName() = "authorizeWalkthroughUpload" and
        call.getFile().getRelativePath() = "SmithersFileAccessToHttp.js"
      )
    )
  }
}

from FileAccessToHttpFlow::PathNode source, FileAccessToHttpFlow::PathNode sink
where FileAccessToHttpFlow::flowPath(source, sink)
select sink.getNode(), source, sink, "Outbound network request depends on $@.", source.getNode(),
  "file data"
