import type { BootSession } from "./BootSession"

/** HTML rendered before the browser-only controller and its OPFS store can exist. */
export function SessionShell({ session }: { readonly session: BootSession }) {
  const message = session.state === "signed-out"
    ? "Smithers is a design-partner preview — sign in with GitHub to continue."
    : session.state === "signed-in" && !session.allowlisted
    ? `You're signed in as ${session.login ?? "a GitHub user"}, but Smithers is open to design partners only right now.`
    : session.state === "unavailable"
    ? "This build isn't connected to Smithers' identity service. Everything local still works."
    : "Smithers is starting your session."
  return (
    <div className="smithers-app" data-server-session={session.state}>
      <main className="smithers-shell server-session-shell" aria-label="Smithers session">
        <p>{message}</p>
        {session.state === "signed-out" ? <a href="/api/auth/sign-in">Sign in with GitHub</a> : null}
      </main>
    </div>
  )
}
