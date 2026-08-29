import { chmodSync, writeFileSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

/**
 * @param {string} dir
 * @param {string} pathValue
 */
export function prependPath(dir, pathValue = process.env.PATH ?? "") {
  return pathValue ? `${dir}${delimiter}${pathValue}` : dir;
}

/**
 * @param {string} dir
 * @param {string} name
 * @param {string} stdoutScript
 */
export async function makeFakeNodeCli(dir, name, stdoutScript) {
  const script = `#!/usr/bin/env node\n${stdoutScript}\n`;
  if (process.platform === "win32") {
    const scriptPath = join(dir, `${name}.js`);
    const binPath = join(dir, `${name}.cmd`);
    await writeFile(scriptPath, script, "utf8");
    await writeFile(binPath, `@echo off\r\n"${process.execPath}" "%~dp0${name}.js" %*\r\n`, "utf8");
    return { dir, binPath, scriptPath };
  }

  const binPath = join(dir, name);
  await writeFile(binPath, script, "utf8");
  await chmod(binPath, 0o755);
  return { dir, binPath };
}

/**
 * @param {string} dir
 * @param {string} name
 * @param {string} stdoutScript
 */
export function makeFakeNodeCliSync(dir, name, stdoutScript) {
  const script = `#!/usr/bin/env node\n${stdoutScript}\n`;
  if (process.platform === "win32") {
    const scriptPath = join(dir, `${name}.js`);
    const binPath = join(dir, `${name}.cmd`);
    writeFileSync(scriptPath, script, "utf8");
    writeFileSync(binPath, `@echo off\r\n"${process.execPath}" "%~dp0${name}.js" %*\r\n`, "utf8");
    return { dir, binPath, scriptPath };
  }

  const binPath = join(dir, name);
  writeFileSync(binPath, script, "utf8");
  chmodSync(binPath, 0o755);
  return { dir, binPath };
}
