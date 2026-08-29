/**
 * Finds an executable on `PATH`.
 *
 * 0.x called `Bun.which`, which tied the command to one runtime. The bin this
 * app ships runs under Node, so the lookup is written out: `PATH` entries in
 * order, `X_OK` access, and `PATHEXT` on Windows.
 *
 * @since 1.0.0
 */
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * Returns the absolute path of `command` on `PATH`, or `undefined`.
 *
 * @since 1.0.0
 * @category constructors
 */
export function whichBinary(
  command: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  if (command === "") return undefined;
  const extensions = process.platform === "win32"
    ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((entry) => entry !== "")
    : [""];
  const candidates = isAbsolute(command) || command.includes("/")
    ? [command]
    : (environment.PATH ?? "").split(delimiter).filter((entry) => entry !== "").map((dir) => join(dir, command));
  for (const candidate of candidates) {
    for (const extension of extensions) {
      const full = `${candidate}${extension}`;
      try {
        accessSync(full, constants.X_OK);
        return full;
      } catch {
        // Not this one; keep walking PATH.
      }
    }
  }
  return undefined;
}
