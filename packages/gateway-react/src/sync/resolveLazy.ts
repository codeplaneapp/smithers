export type LazyValue<T> = T | (() => T | Promise<T>);

export async function resolveLazy<T>(value: LazyValue<T>): Promise<T> {
  return typeof value === "function" ? await (value as () => T | Promise<T>)() : value;
}
