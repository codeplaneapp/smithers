/**
 * A raw `accounts.json` entry whose `provider` this build does not recognize —
 * e.g. a pre-0.25 `gemini` subscription row. Carried verbatim through
 * read → write so an unrelated `agents add`/`agents remove` cannot destroy the
 * credentials its `configDir` points at.
 *
 * `label` is always a non-empty string: `parseAccountsFile` validates the label
 * before it validates the provider.
 */
export type UnknownAccount = {
  label: string;
  provider?: unknown;
  [key: string]: unknown;
};
