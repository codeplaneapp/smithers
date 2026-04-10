type OpenInBrowserResult =
  | { ok: true }
  | { ok: false; error: string };

function commandForUrl(url: string): string[] {
  switch (process.platform) {
    case "darwin":
      return ["open", url];
    case "win32":
      return ["cmd", "/c", "start", "", url];
    default:
      return ["xdg-open", url];
  }
}

export async function openInBrowser(url: string): Promise<OpenInBrowserResult> {
  const child = Bun.spawn(commandForUrl(url), {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });

  const exitCode = await child.exited;
  if (exitCode === 0) {
    return { ok: true };
  }

  const stderr = await new Response(child.stderr).text();
  return {
    ok: false,
    error: stderr.trim() || `Browser open command exited with code ${exitCode}`,
  };
}
