/**
 * The shell layout. `app/layout.tsx` is optional; when it exists the router
 * exports its default component as `layout` and the entry point wraps every
 * page in it.
 *
 * The navigation comes from the manifest declared in PACKAGE.ts, so adding a
 * `nav` entry and the matching `app/<href>/page.tsx` is the whole change.
 */
import type { ReactNode } from "react"
import manifest from "virtual:smthrs-app/manifest"

export default function Layout({ children }: { readonly children: ReactNode }) {
  return (
    <div className="shell">
      <aside className="shell-sidebar">
        <div className="shell-wordmark">{manifest.brand.wordmark ?? manifest.brand.name}</div>
        {manifest.nav.map((group) => (
          <nav key={group.label} className="shell-nav">
            <div className="shell-nav-label">{group.label}</div>
            {group.items.map((item) => (
              <a key={item.href} className="shell-nav-item" href={`#${item.href}`}>
                {item.label}
              </a>
            ))}
          </nav>
        ))}
      </aside>
      <main className="shell-main">{children}</main>
    </div>
  )
}
