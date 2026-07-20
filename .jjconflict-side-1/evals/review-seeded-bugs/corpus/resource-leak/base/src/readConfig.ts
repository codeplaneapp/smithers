import { open } from "node:fs/promises";

export async function readConfig(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}
