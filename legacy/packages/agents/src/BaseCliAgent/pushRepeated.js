/**
 * Emit one flag/value pair per entry: `--flag a --flag b`.
 *
 * Use this for vendor flags whose parser accepts exactly one value per
 * occurrence (clap `Vec<T>` without `num_args`, commander accumulating
 * `argParser`). `pushList` would emit `--flag a b`, and the vendor then
 * parses `b` as a positional argument.
 *
 * @param {string[]} args
 * @param {string} flag
 * @param {string[]} [values]
 */
export function pushRepeated(args, flag, values) {
  if (!values || values.length === 0) return;
  for (const value of values) {
    args.push(flag, String(value));
  }
}
