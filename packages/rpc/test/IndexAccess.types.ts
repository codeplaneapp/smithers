// Indexing a wire collection must force the consumer to handle absence.
declare const entries: ReadonlyArray<string>
// @ts-expect-error an unchecked index can be undefined
const required: string = entries[0]
void required
