/** The shell painted while the boot chunk loads and the controller and its OPFS store come up. */
export function SessionShell() {
  return (
    <div className="smithers-app" data-server-session="loading">
      <main className="smithers-shell server-session-shell" aria-label="Smithers session">
        <p>Smithers is starting your session.</p>
      </main>
    </div>
  )
}
