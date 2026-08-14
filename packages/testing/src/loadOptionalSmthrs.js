// src/loadOptionalSmthrs.ts
var smthrsPromise;
async function loadOptionalSmthrs(action) {
  if (!smthrsPromise) {
    smthrsPromise = import("smthrs").catch((error) => {
      smthrsPromise = void 0;
      throw new Error(
        `${action}: \`npm install smthrs\`. "smthrs" is an optional peerDependency of @smthrs/testing. Original error: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    });
  }
  return smthrsPromise;
}
export {
  loadOptionalSmthrs
};
