/// <reference path="../types/bun-test-shim.d.ts" />
import * as smthrs from 'smthrs';

type SmthrsModule = typeof smthrs;
/**
 * Load the optional `smthrs` peer only for testing features that need the
 * published facade. Keeping this import lazy avoids restoring the
 * smthrs -> @smthrs/testing -> smthrs runtime dependency cycle.
 */
declare function loadOptionalSmthrs(action: string): Promise<SmthrsModule>;

export { loadOptionalSmthrs };
