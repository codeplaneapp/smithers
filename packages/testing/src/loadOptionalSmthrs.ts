type SmthrsModule = typeof import("smthrs");

let smthrsPromise: Promise<SmthrsModule> | undefined;

/**
 * Load the optional `smthrs` peer only for testing features that need the
 * published facade. Keeping this import lazy avoids restoring the
 * smthrs -> @smthrs/testing -> smthrs runtime dependency cycle.
 */
export async function loadOptionalSmthrs(action: string): Promise<SmthrsModule> {
  if (!smthrsPromise) {
    smthrsPromise = import("smthrs").catch((error: unknown) => {
      smthrsPromise = undefined;
      throw new Error(
        `${action}: \`npm install smthrs\`. ` +
          `"smthrs" is an optional peerDependency of @smthrs/testing. Original error: ${
            error instanceof Error ? error.message : String(error)
          }`,
        { cause: error },
      );
    });
  }
  return smthrsPromise;
}
