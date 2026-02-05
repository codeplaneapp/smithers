# Smithers Desktop V2 — Engineering Implementation Plan

How to implement the complete redesign: Samurai Champloo Blue + Evil Rabbit + Figma + T3 Chat + Linear.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [File Inventory & Change Map](#2-file-inventory--change-map)
3. [Phase 1: Token System & CSS Foundation](#3-phase-1-token-system--css-foundation)
4. [Phase 2: Layout Rewrite — Tri-Pane](#4-phase-2-layout-rewrite--tri-pane)
5. [Phase 3: ShortcutManager & Command Palette](#5-phase-3-shortcutmanager--command-palette)
6. [Phase 4: Chat Interface Overhaul](#6-phase-4-chat-interface-overhaul)
7. [Phase 5: Inspector Panel](#7-phase-5-inspector-panel)
8. [Phase 6: Micro-Interactions & Motion](#8-phase-6-micro-interactions--motion)
9. [Migration Strategy](#9-migration-strategy)
10. [Testing Plan](#10-testing-plan)
11. [Risk Register](#11-risk-register)

---

## 1. Architecture Overview

### What stays the same

- **Runtime**: Electrobun (Bun process + native webview). No change.
- **RPC layer**: `src/shared/rpc.ts` with typed requests/messages. No change needed.
- **Bun-side services**: `AgentService`, `SmithersService`, `WorkspaceService`, tools, plugins. Untouched.
- **Plain DOM approach**: No framework migration. Continue using vanilla TS + Web Components.
- **ChatAgent**: `src/webview/chat/ChatAgent.ts` state container. Interface unchanged.
- **Build system**: `electrobun.config.ts`, `bunx electrobun dev`. No change.

### What changes

| Layer | Current | New |
|---|---|---|
| **CSS tokens** | `--bg: #faf6ee` (warm), `--accent: #f27638` (orange) | `--bg: #0B0D10` (dark), `--accent: #4C7DFF` (blue) |
| **Layout** | Menubar + toolbar + chat + sidebar (2-pane) | Nav rail + chat canvas + inspector (3-pane) |
| **Shortcuts** | Meta+key only, in `handleShortcuts()` | Scoped `ShortcutManager` with chords, j/k, Cmd+K |
| **Chat UI** | `ChatPanel` web component with bubble layout | Full-width left-aligned messages with hover actions |
| **Workflow panel** | Right sidebar with tab-panel | Inspector drawer with slide animation |
| **app.ts** | 2159-line monolith | Split into modules |

### New file structure

```
src/webview/
├── app.ts                    # Entry point (slimmed down)
├── main.css                  # Token system + base styles
├── core/
│   ├── ShortcutManager.ts    # NEW: scoped keyboard handler
│   ├── CommandPalette.ts     # NEW: Cmd+K palette component
│   ├── NavRail.ts            # NEW: left navigation rail
│   └── Toast.ts              # Extract from app.ts
├── chat/
│   ├── ChatAgent.ts          # Unchanged
│   ├── ChatPanel.ts          # Major restyle
│   ├── ChatComposer.ts       # NEW: extracted composer
│   ├── MessageRenderer.ts    # NEW: message rendering logic
│   ├── types.ts              # Unchanged
│   └── index.ts              # Unchanged
├── inspector/
│   ├── InspectorPanel.ts     # NEW: right-side inspector
│   ├── GraphView.ts          # Extract from app.ts
│   ├── TimelineView.ts       # Extract from app.ts
│   ├── LogsView.ts           # Extract from app.ts
│   ├── OutputsView.ts        # Extract from app.ts
│   └── NodeDrawer.ts         # Extract from app.ts
├── views/
│   ├── RunsView.ts           # NEW: runs list view
│   └── WorkflowsView.ts     # NEW: workflows list view
└── rpc/
    ├── electrobun.ts         # Unchanged
    ├── types.ts              # Unchanged
    └── web.ts                # Unchanged
```

---

## 2. File Inventory & Change Map

### Files to modify

| File | Change | Effort |
|---|---|---|
| `views/main/index.html` | Update body background, remove inline dark/light styles | S |
| `views/main/main.css` | **Complete rewrite** — new token system, all component styles | XL |
| `src/webview/main.css` | **Complete rewrite** — mirrors views/main/main.css | XL |
| `views/main/app.css` | Tailwind output — regenerate or keep, update syntax highlight vars | M |
| `src/webview/app.ts` | **Major refactor** — extract modules, rewrite `setupUi()`, new layout HTML | XL |
| `src/webview/chat/ChatPanel.ts` | Restyle shadow DOM CSS, restructure message layout | L |

### Files to create

| File | Purpose | Effort |
|---|---|---|
| `src/webview/core/ShortcutManager.ts` | Scoped keyboard shortcut system | L |
| `src/webview/core/CommandPalette.ts` | Cmd+K command palette web component | L |
| `src/webview/core/NavRail.ts` | Left navigation rail component | M |
| `src/webview/core/Toast.ts` | Extract toast system from app.ts | S |
| `src/webview/inspector/InspectorPanel.ts` | Right-side details panel | L |
| `src/webview/inspector/GraphView.ts` | Extract from app.ts ~lines 1007-1237 | M |
| `src/webview/inspector/TimelineView.ts` | Extract from app.ts ~lines 1031-1047 | S |
| `src/webview/inspector/LogsView.ts` | Extract from app.ts ~lines 1049-1133 | M |
| `src/webview/inspector/OutputsView.ts` | Extract from app.ts ~lines 1135-1188 | S |
| `src/webview/inspector/NodeDrawer.ts` | Extract from app.ts ~lines 1594-1715 | M |
| `src/webview/views/RunsView.ts` | Extract from app.ts ~lines 750-816 | M |
| `src/webview/views/WorkflowsView.ts` | Extract from app.ts ~lines 818-843 | S |
| `src/webview/chat/ChatComposer.ts` | Extracted & enhanced composer | M |
| `src/webview/chat/MessageRenderer.ts` | Extracted message rendering | M |

### Files unchanged

- `src/shared/rpc.ts`
- `src/bun/**/*` (entire bun-side)
- `src/webview/chat/ChatAgent.ts`
- `src/webview/chat/types.ts`
- `src/webview/rpc/*`
- `electrobun.config.ts`
- `package.json`

---

## 3. Phase 1: Token System & CSS Foundation

**Goal**: Replace every color, spacing, and typography value with the new design system. The app looks completely different after this phase — new dark blue identity — but layout and behavior are unchanged.

### 3.1 Rewrite `main.css` token block

Replace the `:root` and `.dark` blocks in both `src/webview/main.css` AND `views/main/main.css`:

```css
:root {
  color-scheme: dark;

  /* === BASE NEUTRALS (Evil Rabbit / Vercel) === */
  --black-0: #000000;
  --black-1: #07080A;
  --black-2: #0B0D10;
  --black-3: #10141A;
  --black-4: #161C24;
  --black-5: #1C2430;

  --white-0: #FFFFFF;
  --white-1: #F5F7FA;
  --white-2: #C9D1E0;
  --white-3: #8B96A9;
  --white-4: #5A6577;

  /* === CHAMPLOO BLUES (Primary) === */
  --champloo-deep:     #0D1117;
  --champloo-indigo-1: #1a1a2e;
  --champloo-indigo-2: #16213e;
  --champloo-navy:     #0f3460;
  --champloo-violet:   #533483;

  --accent:        #4C7DFF;
  --accent-hover:  #6B94FF;
  --accent-pressed:#2F5BFF;
  --accent-muted:  rgba(76, 125, 255, 0.15);
  --accent-glow:   rgba(76, 125, 255, 0.25);

  /* === WARM SECONDARY (Approvals/Attention) === */
  --amber:       #F2A43A;
  --amber-muted: rgba(242, 164, 58, 0.15);

  /* === SEMANTIC === */
  --danger:       #FF3B5C;
  --danger-muted: rgba(255, 59, 92, 0.12);
  --success:      #3DDC97;
  --success-muted:rgba(61, 220, 151, 0.12);

  /* === APPLICATION TOKENS === */
  --bg:       var(--black-2);
  --panel:    var(--black-3);
  --panel-2:  var(--black-4);
  --panel-3:  var(--black-5);
  --border:       #1E2736;
  --border-hover: #2C3A4E;
  --text:     var(--white-1);
  --muted:    var(--white-3);
  --subtle:   var(--white-4);
  --info:     var(--accent);
  --warning:  var(--amber);
  --focus-ring: var(--accent);

  /* === TYPOGRAPHY === */
  --sans: "Geist", "Inter", system-ui, -apple-system, sans-serif;
  --mono: "Geist Mono", "JetBrains Mono", ui-monospace, monospace;
  --text-2xs: 10px;
  --text-xs:  11px;
  --text-sm:  12px;
  --text-md:  13px;
  --text-lg:  15px;
  --text-xl:  18px;

  /* === MOTION === */
  --ease-out:    cubic-bezier(0.2, 0.8, 0.2, 1);
  --ease-snap:   cubic-bezier(0.2, 0.9, 0.1, 1);
  --ease-spring: cubic-bezier(0.16, 1, 0.3, 1);
  --dur-instant: 60ms;
  --dur-fast:    100ms;
  --dur-normal:  180ms;
  --dur-smooth:  260ms;

  /* === SHADOWS === */
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.3);
  --shadow-md: 0 4px 12px rgba(0,0,0,0.4);
  --shadow-lg: 0 8px 32px rgba(0,0,0,0.5);
  --shadow-glow: 0 0 0 1px var(--accent-muted), 0 8px 24px rgba(0,0,0,0.45);

  /* === LAYOUT === */
  --nav-width: 56px;
  --nav-width-expanded: 240px;
  --inspector-width: 400px;
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;
  --radius-xl: 12px;
}
```

### 3.2 Update `index.html`

```html
<body style="margin:0; background:#0B0D10; color:#F5F7FA;">
```

Remove the `@media (prefers-color-scheme: dark)` block — we're dark-first.

### 3.3 Find and kill hardcoded colors

Run this grep to find all hardcoded hex values that need token replacement:

```bash
grep -rn '#f27638\|#db3400\|#ff7a3d\|#ff4d1f\|#faf6ee\|#f5efe3\|#ece4d4\|#1b1a17' \
  apps/desktop/src/webview/ apps/desktop/views/
```

Every match must be replaced with the appropriate `var(--token)`.

**Critical**: `ChatPanel.ts` has hardcoded colors in its shadow DOM styles (lines 62, 86-87, 94-95, etc.) and in workflow card buttons (lines 313-321). All must use CSS custom properties that inherit through the shadow boundary.

### 3.4 Update `stateColor()` in app.ts

```typescript
// BEFORE (orange-themed)
case "in-progress":
  return { bg: "#1a1208", stroke: "#f27638" };

// AFTER (blue-themed)
case "in-progress":
  return { bg: "#0D1630", stroke: "#4C7DFF" };
case "finished":
  return { bg: "#0A1A15", stroke: "#3DDC97" };
case "failed":
  return { bg: "#1E0A10", stroke: "#FF3B5C" };
case "waiting-approval":
  return { bg: "#1A1508", stroke: "#F2A43A" };
case "cancelled":
case "skipped":
  return { bg: "#10141A", stroke: "#5A6577" };
default:
  return { bg: "#10141A", stroke: "#2C3A4E" };
```

### 3.5 Update syntax highlight vars in app.css

The `:root` and `.dark` syntax highlight variables need updating to fit the blue theme.

### 3.6 Validation

After this phase:
- `bunx electrobun dev` — app loads with new dark blue identity
- All text is readable (WCAG AA contrast)
- No visible orange/warm tones except on approval elements
- No hardcoded hex values in component code

---

## 4. Phase 2: Layout Rewrite — Tri-Pane

**Goal**: Replace menubar+toolbar+chat+sidebar with nav rail + chat canvas + inspector.

### 4.1 Rewrite `setupUi()` in app.ts

Replace the current HTML template (lines 352-400) with:

```typescript
function setupUi() {
  appRoot = document.createElement("div");
  appRoot.className = "app";
  appRoot.innerHTML = `
    <a href="#main-content" class="skip-link">Skip to main content</a>

    <!-- LEFT: Navigation Rail -->
    <nav class="nav-rail" id="nav-rail" role="navigation" aria-label="Main navigation">
      <div class="nav-rail__logo">
        <span class="nav-rail__logo-mark">◆</span>
        <span class="nav-rail__logo-text">Smithers</span>
      </div>

      <div class="nav-rail__items">
        <button class="nav-item active" data-nav="chat" aria-label="Chat (g c)">
          <span class="nav-item__icon">💬</span>
          <span class="nav-item__label">Chat</span>
          <span class="nav-item__shortcut">g c</span>
        </button>
        <button class="nav-item" data-nav="runs" aria-label="Runs (g r)">
          <span class="nav-item__icon">▶</span>
          <span class="nav-item__label">Runs</span>
          <span class="nav-item__shortcut">g r</span>
          <span class="nav-item__badge hidden" id="approval-badge">0</span>
        </button>
        <button class="nav-item" data-nav="workflows" aria-label="Workflows (g w)">
          <span class="nav-item__icon">⚡</span>
          <span class="nav-item__label">Workflows</span>
          <span class="nav-item__shortcut">g w</span>
        </button>
        <button class="nav-item" data-nav="settings" aria-label="Settings (g s)">
          <span class="nav-item__icon">⚙</span>
          <span class="nav-item__label">Settings</span>
          <span class="nav-item__shortcut">g s</span>
        </button>
      </div>

      <div class="nav-rail__sessions" id="session-list"></div>

      <div class="nav-rail__footer">
        <button class="nav-item nav-item--subtle" id="shortcuts-help" aria-label="Keyboard shortcuts (?)">
          <span class="nav-item__icon">?</span>
          <span class="nav-item__label">Shortcuts</span>
        </button>
        <div class="nav-rail__version">v0.1.0</div>
      </div>
    </nav>

    <!-- CENTER: Main Content -->
    <main class="main-content" id="main-content">
      <!-- Chat view (default) -->
      <div class="view view--chat active" id="view-chat">
        <header class="chat-header" id="chat-header">
          <div class="chat-header__title">
            <select id="session-select" class="chat-header__session-select" aria-label="Session"></select>
            <button id="new-session" class="btn-ghost btn-sm" aria-label="New session">+</button>
          </div>
          <div class="chat-header__context" id="context-bar"></div>
          <div class="chat-header__actions">
            <button class="btn-ghost btn-sm" id="toggle-inspector" aria-label="Toggle inspector (⌘I)">⌘I</button>
          </div>
        </header>
        <section id="chat-pane" class="chat-pane" aria-label="Chat"></section>
      </div>

      <!-- Runs view -->
      <div class="view view--runs" id="view-runs"></div>

      <!-- Workflows view -->
      <div class="view view--workflows" id="view-workflows"></div>
    </main>

    <!-- RIGHT: Inspector Panel -->
    <aside class="inspector" id="inspector" aria-label="Inspector" aria-hidden="true">
      <div class="inspector__header" id="inspector-header"></div>
      <div class="inspector__tabs" id="inspector-tabs" role="tablist"></div>
      <div class="inspector__body" id="inspector-body"></div>
    </aside>

    <!-- Overlays -->
    <div id="command-palette" class="command-palette hidden" role="dialog" aria-label="Command palette"></div>
    <div id="toast-container" class="toast-container" role="status" aria-live="polite"></div>
  `;
  // ... wire up references ...
}
```

### 4.2 Navigation state machine

Add a `currentView` to state:

```typescript
type AppView = "chat" | "runs" | "workflows" | "settings";

const state = {
  // ...existing...
  currentView: "chat" as AppView,
  inspectorOpen: false,
};
```

Implement `navigateTo(view: AppView)`:

```typescript
function navigateTo(view: AppView) {
  state.currentView = view;

  // Update nav rail active indicator
  document.querySelectorAll('.nav-item[data-nav]').forEach(el => {
    el.classList.toggle('active', el.getAttribute('data-nav') === view);
  });

  // Show/hide views with animation
  document.querySelectorAll('.view').forEach(el => {
    const isTarget = el.id === `view-${view}`;
    el.classList.toggle('active', isTarget);
    if (isTarget) {
      el.style.opacity = '0';
      el.style.transform = 'translateY(4px)';
      requestAnimationFrame(() => {
        el.style.transition = 'opacity var(--dur-normal) var(--ease-out), transform var(--dur-normal) var(--ease-out)';
        el.style.opacity = '1';
        el.style.transform = 'translateY(0)';
      });
    }
  });

  // Render the target view content if needed
  if (view === "runs") renderRuns();
  if (view === "workflows") renderWorkflows();
  if (view === "settings") openSettingsDialog();
}
```

### 4.3 Inspector toggle

```typescript
function toggleInspector(open?: boolean) {
  state.inspectorOpen = open ?? !state.inspectorOpen;
  const inspector = document.getElementById('inspector')!;

  if (state.inspectorOpen) {
    inspector.classList.add('inspector--open');
    inspector.setAttribute('aria-hidden', 'false');
    inspector.style.transform = 'translateX(0)';
    inspector.style.opacity = '1';
  } else {
    inspector.style.transform = 'translateX(16px)';
    inspector.style.opacity = '0';
    setTimeout(() => {
      inspector.classList.remove('inspector--open');
      inspector.setAttribute('aria-hidden', 'true');
    }, 260);
  }
}
```

### 4.4 CSS for tri-pane layout

```css
.app {
  display: grid;
  grid-template-columns: var(--nav-width) 1fr 0;
  height: 100vh;
  overflow: hidden;
  transition: grid-template-columns var(--dur-smooth) var(--ease-spring);
}

.app:has(.inspector--open) {
  grid-template-columns: var(--nav-width) 1fr var(--inspector-width);
}

.nav-rail {
  display: flex;
  flex-direction: column;
  background: var(--black-1);
  border-right: 1px solid var(--border);
  width: var(--nav-width);
  overflow: hidden;
  transition: width var(--dur-smooth) var(--ease-spring);
}

.nav-rail.expanded {
  width: var(--nav-width-expanded);
}

.main-content {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.inspector {
  background: var(--panel);
  border-left: 1px solid var(--border);
  overflow-y: auto;
  transform: translateX(16px);
  opacity: 0;
  transition: transform var(--dur-smooth) var(--ease-spring),
              opacity var(--dur-normal) var(--ease-out);
}

.inspector--open {
  transform: translateX(0);
  opacity: 1;
}
```

### 4.5 Responsive behavior

```css
@media (max-width: 1199px) {
  .nav-rail { width: var(--nav-width); }
  .nav-item__label,
  .nav-item__shortcut,
  .nav-rail__logo-text,
  .nav-rail__sessions,
  .nav-rail__version { display: none; }
}

@media (max-width: 899px) {
  .app { grid-template-columns: var(--nav-width) 1fr; }
  .inspector {
    position: fixed;
    right: 0;
    top: 0;
    bottom: 0;
    width: min(var(--inspector-width), 90vw);
    z-index: 30;
    box-shadow: var(--shadow-lg);
  }
}
```

### 4.6 Remove old layout code

Delete from `setupUi()`:
- Menubar (`<nav class="menubar">`)
- Toolbar (`<header class="toolbar">`)
- Old sidebar (`<aside class="sidebar">`)
- Collapsed sidebar (`<div class="sidebar-collapsed">`)

Delete functions:
- `openMenu()`, `closeMenu()`, `getMenuItems()` — replaced by command palette
- `toggleSidebar()` — replaced by `toggleInspector()`
- `switchTab()` — replaced by `navigateTo()`

### 4.7 Validation

- App renders tri-pane layout
- Nav rail shows icons + labels (> 1200px) or icons only (< 1200px)
- Clicking nav items switches views
- Inspector slides in/out smoothly
- Chat remains functional

---

## 5. Phase 3: ShortcutManager & Command Palette

### 5.1 ShortcutManager

Create `src/webview/core/ShortcutManager.ts`:

```typescript
type ShortcutScope = 'global' | 'chat' | 'runs' | 'workflows' | 'inspector' | 'modal' | 'palette';

type ShortcutHandler = (event: KeyboardEvent) => void | boolean;

type ShortcutBinding = {
  key: string;                     // e.g. "k", "Enter", "Escape"
  meta?: boolean;                  // Cmd/Ctrl required
  shift?: boolean;
  alt?: boolean;
  scope: ShortcutScope;
  handler: ShortcutHandler;
  label: string;                   // for command palette / help overlay
  category?: string;               // for grouping in help
  allowInInput?: boolean;          // default false
};

type ChordBinding = {
  prefix: string;                  // e.g. "g"
  key: string;                     // e.g. "c"
  scope: ShortcutScope;
  handler: ShortcutHandler;
  label: string;
  category?: string;
};

export class ShortcutManager {
  private bindings: ShortcutBinding[] = [];
  private chords: ChordBinding[] = [];
  private scopeStack: ShortcutScope[] = ['global'];
  private chordPending: string | null = null;
  private chordTimer: ReturnType<typeof setTimeout> | null = null;
  private chordIndicator: HTMLElement | null = null;

  constructor() {
    window.addEventListener('keydown', this.handleKeydown.bind(this), true);
  }

  register(binding: ShortcutBinding): () => void {
    this.bindings.push(binding);
    return () => {
      this.bindings = this.bindings.filter(b => b !== binding);
    };
  }

  registerChord(chord: ChordBinding): () => void {
    this.chords.push(chord);
    return () => {
      this.chords = this.chords.filter(c => c !== chord);
    };
  }

  pushScope(scope: ShortcutScope): void {
    this.scopeStack.push(scope);
  }

  popScope(scope: ShortcutScope): void {
    const idx = this.scopeStack.lastIndexOf(scope);
    if (idx >= 0) this.scopeStack.splice(idx, 1);
  }

  get activeScopes(): ShortcutScope[] {
    return [...this.scopeStack];
  }

  getAllBindings(): (ShortcutBinding | ChordBinding)[] {
    return [...this.bindings, ...this.chords];
  }

  private handleKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    const isInput = target.tagName === 'INPUT'
      || target.tagName === 'TEXTAREA'
      || target.tagName === 'SELECT'
      || target.isContentEditable;

    // Handle chord completion
    if (this.chordPending) {
      const prefix = this.chordPending;
      this.cancelChord();

      if (!isInput) {
        const chord = this.chords.find(c =>
          c.prefix === prefix
          && c.key === event.key
          && this.scopeStack.includes(c.scope)
        );
        if (chord) {
          event.preventDefault();
          event.stopPropagation();
          chord.handler(event);
          return;
        }
      }
    }

    // Check chord prefixes (single letter, no modifiers, not in input)
    if (!isInput && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      const hasChord = this.chords.some(c =>
        c.prefix === event.key
        && this.scopeStack.includes(c.scope)
      );
      if (hasChord) {
        event.preventDefault();
        this.startChord(event.key);
        return;
      }
    }

    // Check direct bindings (most specific scope first)
    const meta = event.metaKey || event.ctrlKey;

    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      const scope = this.scopeStack[i]!;
      const binding = this.bindings.find(b =>
        b.scope === scope
        && b.key.toLowerCase() === event.key.toLowerCase()
        && (b.meta ?? false) === meta
        && (b.shift ?? false) === event.shiftKey
        && (b.alt ?? false) === event.altKey
        && (isInput ? b.allowInInput : true)
      );
      if (binding) {
        event.preventDefault();
        event.stopPropagation();
        const result = binding.handler(event);
        if (result !== false) return; // handled
      }
    }
  }

  private startChord(prefix: string): void {
    this.chordPending = prefix;
    this.showChordIndicator(prefix);
    this.chordTimer = setTimeout(() => this.cancelChord(), 600);
  }

  private cancelChord(): void {
    this.chordPending = null;
    if (this.chordTimer) clearTimeout(this.chordTimer);
    this.chordTimer = null;
    this.hideChordIndicator();
  }

  private showChordIndicator(prefix: string): void {
    if (!this.chordIndicator) {
      this.chordIndicator = document.createElement('div');
      this.chordIndicator.className = 'chord-indicator';
      document.body.appendChild(this.chordIndicator);
    }
    this.chordIndicator.textContent = `${prefix}…`;
    this.chordIndicator.classList.add('visible');
  }

  private hideChordIndicator(): void {
    this.chordIndicator?.classList.remove('visible');
  }
}
```

### 5.2 Register shortcuts

In `app.ts`, after creating the `ShortcutManager`:

```typescript
const shortcuts = new ShortcutManager();

// Cmd+K — command palette
shortcuts.register({
  key: 'k', meta: true, scope: 'global',
  allowInInput: true,
  handler: () => toggleCommandPalette(),
  label: 'Open command palette',
  category: 'General',
});

// Cmd+I — toggle inspector
shortcuts.register({
  key: 'i', meta: true, scope: 'global',
  allowInInput: true,
  handler: () => toggleInspector(),
  label: 'Toggle inspector',
  category: 'General',
});

// Esc — close topmost overlay
shortcuts.register({
  key: 'Escape', scope: 'global',
  allowInInput: true,
  handler: () => closeTopmost(),
  label: 'Close',
  category: 'General',
});

// g-prefix navigation chords
shortcuts.registerChord({
  prefix: 'g', key: 'c', scope: 'global',
  handler: () => navigateTo('chat'),
  label: 'Go to Chat',
  category: 'Navigation',
});
shortcuts.registerChord({
  prefix: 'g', key: 'r', scope: 'global',
  handler: () => navigateTo('runs'),
  label: 'Go to Runs',
  category: 'Navigation',
});
shortcuts.registerChord({
  prefix: 'g', key: 'w', scope: 'global',
  handler: () => navigateTo('workflows'),
  label: 'Go to Workflows',
  category: 'Navigation',
});
shortcuts.registerChord({
  prefix: 'g', key: 's', scope: 'global',
  handler: () => navigateTo('settings'),
  label: 'Go to Settings',
  category: 'Navigation',
});

// j/k list navigation (when in runs or workflows view)
shortcuts.register({
  key: 'j', scope: 'runs',
  handler: () => moveRunSelection(1),
  label: 'Next run',
  category: 'Runs',
});
shortcuts.register({
  key: 'k', scope: 'runs',
  handler: () => moveRunSelection(-1),
  label: 'Previous run',
  category: 'Runs',
});
```

### 5.3 Command Palette

Create `src/webview/core/CommandPalette.ts`:

The palette is a modal with:
- Search input (auto-focused)
- Filtered list of actions grouped by category
- Arrow key / j/k navigation
- Enter to execute
- Esc to close

The palette sources items from:
1. `shortcuts.getAllBindings()` — all registered shortcuts
2. `state.runs` — recent runs (searchable)
3. `state.workflows` — available workflows
4. `state.sessions` — chat sessions

```typescript
export class CommandPalette {
  private container: HTMLElement;
  private input: HTMLInputElement;
  private list: HTMLElement;
  private items: PaletteItem[] = [];
  private selectedIndex = 0;
  private isOpen = false;

  constructor(container: HTMLElement) {
    this.container = container;
    // Build DOM...
  }

  open(): void {
    this.isOpen = true;
    this.container.classList.remove('hidden');
    this.container.style.opacity = '0';
    this.container.style.transform = 'scale(0.97)';
    requestAnimationFrame(() => {
      this.container.style.transition = 'opacity var(--dur-smooth) var(--ease-spring), transform var(--dur-smooth) var(--ease-spring)';
      this.container.style.opacity = '1';
      this.container.style.transform = 'scale(1)';
    });
    this.input.value = '';
    this.input.focus();
    this.refreshItems();
    this.render();
    shortcuts.pushScope('palette');
  }

  close(): void {
    this.isOpen = false;
    this.container.style.opacity = '0';
    this.container.style.transform = 'scale(0.97)';
    setTimeout(() => this.container.classList.add('hidden'), 260);
    shortcuts.popScope('palette');
  }

  // ... fuzzy search, arrow key handling, execute ...
}
```

### 5.4 Replace old `handleShortcuts()`

Delete the existing `handleShortcuts()` function (lines 1431-1485) and all its associated menu code. The `ShortcutManager` now handles everything.

### 5.5 Validation

- Cmd+K opens/closes palette
- Typing in palette filters items
- Arrow keys navigate, Enter executes
- g+c/r/w/s navigates correctly
- j/k works in runs list
- Cmd+I toggles inspector
- Esc closes overlays in correct order
- Shortcuts don't fire when typing in inputs (except allowed ones)

---

## 6. Phase 4: Chat Interface Overhaul

### 6.1 Restyle ChatPanel shadow DOM

In `ChatPanel.ts`, rewrite the `<style>` block (lines 54-332):

Key changes:
- Messages are full-width, left-aligned (not bubble chat)
- User messages: subtle panel-2 background card
- Assistant messages: transparent background, blue left border
- Tool calls: collapsed by default, monospace, click to expand
- Hover actions appear on message hover (copy, retry)

### 6.2 Extract MessageRenderer

Move message rendering logic from `ChatPanel.ts` `renderMessageContent()` and `renderText()` into a dedicated `MessageRenderer.ts`:

```typescript
export function renderMessage(message: Message, options: {
  isStreaming?: boolean;
  onAction?: (action: string, message: Message) => void;
}): string {
  // ...
}
```

### 6.3 Enhanced Composer

Extract the input area from `ChatPanel.ts` into `ChatComposer.ts`:

New features:
- Context chips (workspace, selected run) shown above input
- Attachment pills with remove
- Bottom row: mention trigger (@), slash commands (/), model indicator
- Send/Stop animated icon transition
- Focus state: blue border glow

### 6.4 Message hover actions

On hover, show floating action bar (right side, above message):

```html
<div class="message-actions">
  <button class="action-btn" data-action="copy" title="Copy">📋</button>
  <button class="action-btn" data-action="retry" title="Retry">↻</button>
</div>
```

Appears with `opacity: 0 → 1` transition on `.message:hover`.

### 6.5 Validation

- Messages render in new full-width style
- Hover shows action buttons
- Copy action copies message text
- Composer shows context chips
- Streaming indicator shows blue pulsing dot
- Workflow cards render consistently in new blue theme

---

## 7. Phase 5: Inspector Panel

### 7.1 Extract from app.ts

Move these function groups into separate modules:

| Source (app.ts lines) | Target module | Functions |
|---|---|---|
| 890-983 | `InspectorPanel.ts` | `renderRunInspector()`, tab switching |
| 985-1005 | `InspectorPanel.ts` | `renderApprovalCard()` |
| 1007-1237 | `GraphView.ts` | `renderGraph()`, `buildGraphSvg()`, `attachGraphHandlers()`, `applyGraphTransform()` |
| 1031-1047 | `TimelineView.ts` | `renderTimeline()` |
| 1049-1133 | `LogsView.ts` | `renderLogs()`, `filterEvents()`, `attachLogsHandlers()` |
| 1135-1188 | `OutputsView.ts` | `renderOutputs()`, `renderAttempts()` |
| 1594-1715 | `NodeDrawer.ts` | `renderNodeDrawer()` |

Each module exports a render function that takes `(container: HTMLElement, runId: string, state: AppState)` and returns nothing (renders into container).

### 7.2 Tab sliding underline

Replace static `.active` class with a sliding `<div class="tab-indicator">` that animates `left` and `width` on tab switch:

```typescript
function updateTabIndicator(activeTab: HTMLElement): void {
  const indicator = document.querySelector('.tab-indicator') as HTMLElement;
  if (!indicator) return;
  indicator.style.left = `${activeTab.offsetLeft}px`;
  indicator.style.width = `${activeTab.offsetWidth}px`;
}
```

### 7.3 Approval highlight

Nodes in `waiting-approval` state use amber accents:

```css
.approval-card {
  background: var(--amber-muted);
  border: 1px solid var(--amber);
  border-radius: var(--radius-lg);
  padding: 12px;
}
```

This is the **only** place warm amber appears prominently — it draws the eye.

### 7.4 Validation

- Inspector slides in/out with Cmd+I
- All 5 tabs render correctly
- Tab indicator slides between tabs
- Graph nodes use new color system
- Approval card uses amber accent
- Node drawer opens on graph node click

---

## 8. Phase 6: Micro-Interactions & Motion

### 8.1 Universal hover states

Add to `main.css`:

```css
/* Every interactive element */
button, [role="button"], .nav-item, .run-row, .workflow-row,
.message, .card, .tab, .menu-row {
  transition: background var(--dur-fast) var(--ease-out),
              border-color var(--dur-fast) var(--ease-out),
              color var(--dur-fast) var(--ease-out),
              transform var(--dur-fast) var(--ease-out),
              box-shadow var(--dur-fast) var(--ease-out);
}
```

### 8.2 List stagger reveals

Use `IntersectionObserver` for first-paint stagger:

```typescript
function setupListStagger(container: HTMLElement): void {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry, i) => {
      if (entry.isIntersecting) {
        const el = entry.target as HTMLElement;
        el.style.animationDelay = `${Math.min(i * 30, 150)}ms`;
        el.classList.add('stagger-in');
        observer.unobserve(el);
      }
    });
  }, { threshold: 0.1 });

  container.querySelectorAll('.list-item').forEach(el => observer.observe(el));
}
```

### 8.3 Accordion slide-down

For expandable sections (tool call output, log entries):

```typescript
function toggleAccordion(trigger: HTMLElement, content: HTMLElement): void {
  const isOpen = content.classList.contains('accordion--open');

  if (isOpen) {
    const height = content.scrollHeight;
    content.style.height = `${height}px`;
    requestAnimationFrame(() => {
      content.style.height = '0';
      content.style.opacity = '0';
    });
    content.classList.remove('accordion--open');
  } else {
    content.classList.add('accordion--open');
    content.style.height = '0';
    content.style.opacity = '0';
    requestAnimationFrame(() => {
      content.style.height = `${content.scrollHeight}px`;
      content.style.opacity = '1';
    });
    content.addEventListener('transitionend', () => {
      content.style.height = 'auto';
    }, { once: true });
  }
}
```

### 8.4 Modal animation

```css
.modal-backdrop {
  animation: fade-in var(--dur-normal) var(--ease-out);
}
.modal {
  animation: modal-in var(--dur-smooth) var(--ease-spring);
}
@keyframes fade-in {
  from { opacity: 0; }
}
@keyframes modal-in {
  from {
    opacity: 0;
    transform: scale(0.97) translateY(8px);
  }
}
```

### 8.5 Toast animation

```css
.toast {
  animation: toast-in var(--dur-smooth) var(--ease-spring);
}
@keyframes toast-in {
  from {
    transform: translateY(12px) scale(0.96);
    opacity: 0;
  }
}
.toast--hide {
  opacity: 0;
  transform: translateY(6px);
  transition: all var(--dur-normal) var(--ease-out);
}
```

### 8.6 Validation

- Hover on any interactive element produces visible feedback
- Nav items lift slightly on hover
- Lists stagger on first render
- Expandable sections slide open/closed smoothly
- Modals animate in with scale + opacity
- Toasts slide up from bottom
- `prefers-reduced-motion` disables all of this

---

## 9. Migration Strategy

### Approach: Big Bang Token Swap, Incremental Layout

Phase 1 (tokens) can ship as a single commit. It changes colors everywhere but doesn't touch functionality. This is the fastest way to validate the new identity.

Phases 2-6 should be done sequentially, with each phase leaving the app in a working state.

### Branch strategy

```
main
  └── feat/v2-redesign
        ├── Phase 1: tokens + colors      (PR #1)
        ├── Phase 2: tri-pane layout       (PR #2)
        ├── Phase 3: shortcuts + palette   (PR #3)
        ├── Phase 4: chat overhaul         (PR #4)
        ├── Phase 5: inspector             (PR #5)
        └── Phase 6: motion + polish       (PR #6)
```

### Keeping both CSS files in sync

`views/main/main.css` is the built/deployed version. `src/webview/main.css` is the source. Currently they're nearly identical but have diverged slightly (border-radius differences). **Consolidate to one source file** and copy it during build, or import one from the other.

Recommended: make `src/webview/main.css` the source of truth. In `electrobun.config.ts` or a build script, copy it to `views/main/main.css`.

### Build verification

After each phase:

```bash
cd apps/desktop
bun run dev           # Electrobun dev mode
# OR
bun run build && open build/dev-macos-arm64/Smithers-dev.app
```

---

## 10. Testing Plan

### Manual testing checklist (per phase)

**Phase 1**:
- [ ] App loads, no white flash
- [ ] All text readable (contrast check)
- [ ] No orange/warm colors except approvals
- [ ] Dark mode is default
- [ ] Syntax highlighting works in code blocks

**Phase 2**:
- [ ] Nav rail visible on left
- [ ] Clicking nav items switches views
- [ ] Chat view is default
- [ ] Inspector opens/closes
- [ ] Responsive at 1200px, 900px breakpoints
- [ ] Window resizing is smooth

**Phase 3**:
- [ ] Cmd+K opens palette
- [ ] Search filters palette items
- [ ] Arrow keys navigate palette
- [ ] Enter executes palette action
- [ ] g+c/r/w/s navigates
- [ ] j/k works in run list
- [ ] Shortcuts don't fire in text inputs
- [ ] Esc closes modals in correct order
- [ ] Chord indicator appears and times out

**Phase 4**:
- [ ] Messages render in new layout
- [ ] User messages have panel-2 background
- [ ] Assistant messages have blue left border
- [ ] Streaming indicator works
- [ ] Send/Stop button works
- [ ] Workflow cards render in chat
- [ ] Hover actions appear on messages

**Phase 5**:
- [ ] Inspector shows run details
- [ ] Tab switching works
- [ ] Tab indicator slides
- [ ] Graph renders with new colors
- [ ] Node click opens drawer
- [ ] Approve/Deny works
- [ ] Logs search and filter work

**Phase 6**:
- [ ] Hover effects on all interactive elements
- [ ] List items stagger on first render
- [ ] Panels slide smoothly
- [ ] Modals animate in/out
- [ ] Toasts animate in/out
- [ ] `prefers-reduced-motion` disables animations

### Playwright tests

The project has a `playwright.config.ts` at root. Add basic smoke tests:

```typescript
test('app loads with new dark theme', async ({ page }) => {
  // Verify background color
  const bg = await page.evaluate(() =>
    getComputedStyle(document.body).backgroundColor
  );
  expect(bg).toContain('11'); // #0B0D10
});

test('command palette opens with Cmd+K', async ({ page }) => {
  await page.keyboard.press('Meta+k');
  await expect(page.locator('#command-palette')).toBeVisible();
});

test('navigation chord g+c goes to chat', async ({ page }) => {
  await page.keyboard.press('g');
  await page.keyboard.press('r');
  await expect(page.locator('#view-runs')).toHaveClass(/active/);
  await page.keyboard.press('g');
  await page.keyboard.press('c');
  await expect(page.locator('#view-chat')).toHaveClass(/active/);
});
```

---

## 11. Risk Register

| Risk | Impact | Mitigation |
|---|---|---|
| **Shadow DOM CSS variables**: `ChatPanel` uses shadow DOM, CSS vars must pierce it | Styles don't apply | Use `::part()` or ensure all colors reference `var()` tokens that inherit through shadow boundary. Test immediately in Phase 1. |
| **Electrobun webview compatibility**: WKWebView may not support `color-mix()`, `:has()` | Layout breaks | Avoid `color-mix()` in critical paths. Use `rgba()` fallbacks. Test `:has()` early — if unsupported, use JS class toggling. |
| **app.ts is 2159 lines**: extracting modules risks breaking references | Runtime errors | Extract one module at a time. Each extraction is its own commit. Run the app after each extraction. |
| **Two CSS files diverged**: `src/webview/main.css` vs `views/main/main.css` | Inconsistency | Unify to single source in Phase 1. |
| **Keyboard shortcut conflicts**: j/k stealing from text inputs | Broken text editing | `ShortcutManager` always checks `isInput` before single-key shortcuts. `allowInInput` defaults to false. |
| **Over-animation causing sluggishness** | Perceived slow app | Stick to duration guardrails: hover ≤ 100ms, panels ≤ 260ms. Profile in WKWebView. |
| **Hardcoded colors in SVG graph** | Graph still shows old colors | `stateColor()` and `buildGraphSvg()` both need updating. Both are in app.ts so easy to find. |

---

## Appendix A: Effort Estimates

| Phase | Estimated Effort | Dependencies |
|---|---|---|
| Phase 1: Tokens & CSS | 2-4 hours | None |
| Phase 2: Tri-Pane Layout | 6-10 hours | Phase 1 |
| Phase 3: Shortcuts & Palette | 4-6 hours | Phase 2 |
| Phase 4: Chat Overhaul | 4-6 hours | Phase 1 |
| Phase 5: Inspector | 4-6 hours | Phase 2 |
| Phase 6: Motion & Polish | 3-4 hours | Phases 1-5 |
| **Total** | **23-36 hours** | |

Phases 4 and 5 can be parallelized (independent components).

## Appendix B: Files to grep for hardcoded colors

```bash
# Find all hardcoded hex colors that need token replacement
grep -rn --include='*.ts' --include='*.css' --include='*.html' \
  -E '#[0-9a-fA-F]{3,8}' \
  apps/desktop/src/ apps/desktop/views/ \
  | grep -v node_modules \
  | grep -v 'var(--' \
  | grep -v '// '
```

Any match that isn't inside a CSS `var()` declaration or a comment needs to be tokenized.

## Appendix C: Command Palette Item Sources

```typescript
function getPaletteItems(): PaletteItem[] {
  return [
    // From ShortcutManager
    ...shortcuts.getAllBindings().map(b => ({
      id: b.label,
      title: b.label,
      category: b.category ?? 'Actions',
      shortcut: formatShortcut(b),
      action: () => b.handler(new KeyboardEvent('keydown')),
    })),

    // From runs
    ...state.runs.map(run => ({
      id: `run-${run.runId}`,
      title: `${run.workflowName} #${run.runId.slice(0, 6)}`,
      subtitle: run.status,
      category: 'Runs',
      action: () => { navigateTo('runs'); focusRun(run.runId); },
    })),

    // From workflows
    ...state.workflows.map(wf => ({
      id: `wf-${wf.path}`,
      title: wf.name ?? wf.path,
      subtitle: wf.path,
      category: 'Workflows',
      action: () => openRunDialog(wf),
    })),

    // From sessions
    ...state.sessions.map(s => ({
      id: `session-${s.sessionId}`,
      title: s.title ?? s.sessionId.slice(0, 8),
      category: 'Sessions',
      action: () => { navigateTo('chat'); bootstrapSession(s.sessionId); },
    })),
  ];
}
```
