// A module under a directory whose name contains `#`, which is a legal
// filename character and URL syntax at once. A `file:` specifier built by
// concatenation truncates at it and addresses `.../modules/rev` instead, so
// the loader reports "could not be loaded" for a module that is right there.
// Reaching this file at all is the assertion; what it exports is refused
// afterwards, which is how the test tells "loaded and rejected" from "never
// found".
export default { notAFlow: "rev#2" }
