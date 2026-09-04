# Reference-page structure: notes from the docs exemplars

Source tree: `/Users/williamcory/docs-skills/exemplars/`. Every quoted block below is
copied literally from the file cited above it. The goal is a set of shapes an LLM can
follow when writing reference pages for a Starlight (Astro) docs site.

The single most repeated pattern across all eight exemplars: **a reference page is a
list of named entries, each entry is a heading, and directly under the heading is a
fixed metadata block (type / default / required / related) before any prose.** Nobody
puts the type inside a sentence. Nobody makes the reader parse a paragraph to find a
default. The variation between sites is only whether the metadata block is bold labels,
a bullet list, or a table.

---

## stripe

Files read: `/Users/williamcory/docs-skills/exemplars/stripe/pages/api.md`,
`/Users/williamcory/docs-skills/exemplars/stripe/pages/api/payment_intents/create.md`,
`/Users/williamcory/docs-skills/exemplars/stripe/pages/api/payment_intents/object.md`,
`/Users/williamcory/docs-skills/exemplars/stripe/pages/api/errors.md`,
`/Users/williamcory/docs-skills/exemplars/stripe/pages/payments.md`,
`/Users/williamcory/docs-skills/exemplars/stripe/style/how-stripe-builds-docs-markdoc.md`.

Note the licence: closed source, all rights reserved, study sample only. Copy the shape,
never the prose.

### Page shape

An operation page (`api/payment_intents/create.md`) in exact order:

```
# Create a PaymentIntent          <- imperative verb phrase, the operation
<one-line deck>                   <- "Creates a PaymentIntent object."
<2-3 paragraphs of orientation, heavily cross-linked>
## Request                        <- runnable curl, credentials as <<YOUR_SECRET_KEY>>
### Response                      <- the full literal JSON body, not an excerpt
## Returns                        <- one sentence
## Parameters                     <- the flat entry list, rest of page
```

An object page (`api/payment_intents/object.md`) is the same skeleton minus the request:

```
# The PaymentIntent object
### The PaymentIntent object      <- the literal JSON example first
## Attributes
```

An errors page (`api/errors.md`):

```
# Errors
<prose on the 2xx/4xx/5xx convention>
### HTTP Status Code Summary      <- table
### Error Types                   <- table
## Attributes                     <- same entry list format as everywhere else
```

The ordering rule worth naming: **example before schema.** The reader sees a working
request and a real response body before the first parameter definition.

### Per-entry format

One parameter or attribute, literal from `api/payment_intents/create.md`:

```md
- `amount` (integer, required)
  Amount intended to be collected by this PaymentIntent. A positive integer representing how much to charge in the [smallest currency unit](https://docs.stripe.com/currencies.md#zero-decimal) (e.g., 100 cents to charge $1.00).

- `setup_future_usage` (enum, optional)
  Indicates that you intend to make future payments with this PaymentIntent's payment method.
Possible enum values:
  - `off_session`
    Use `off_session` if your customer may or may not be present in your checkout flow.
  - `on_session`
    Use `on_session` if you intend to only reuse the payment method when your customer is present.

- [`shipping`](https://docs.stripe.com/api/payment_intents/create.md?query=shipping) (object, optional)
  Shipping information for this PaymentIntent.
```

Three rules encoded in that: the signature line is `` `name` (type, required|optional|nullable) ``
with the type parenthesised, never a separate line; enum members are a nested list where
every member gets its own sentence; and a nested-object parameter has its **name
hyperlinked to its own expansion** rather than being inlined.

Tables are used only for closed, small, tabular sets (HTTP status codes, error types),
and Stripe's `.md` rendition drops the header row entirely:

```md
| 200 | OK | Everything worked as expected. |
| 400 | Bad Request | The request was unacceptable, often due to missing a required parameter. |
```

### Cross-link conventions

- Every internal link is an absolute URL ending in `.md`:
  `[confirm](https://docs.stripe.com/api/payment_intents/confirm.md)`. The `.md`
  endpoint is the canonical machine form of every page, so links resolve for both a
  human and an agent.
- Deep anchors into another page's parameter list:
  `.../api/charges/object.md#charge_object-payment_method_details-card_present-generated_card`.
  Anchor ids are `<object>_<object>-<path>-<to>-<field>`, i.e. derived from the field
  path, so they are stable and machine-derivable.
- Hub pages are pure routing tables. From `pages/payments.md`:

```md
#### Online

[Build a checkout page](https://docs.stripe.com/checkout/quickstart.md): Use Checkout to set up a Stripe-hosted page, embed a payment form, or embed components.

[Build an advanced integration](https://docs.stripe.com/payments/quickstart.md): Learn how to embed a custom Stripe payment form in your website or application.
```

  The pattern is `[Title](url): one sentence saying who this is for`. Nobody has to open
  a page to learn whether it is the right page.
- `nav/llms.txt` uses the *identical* line format, so the machine index and the human hub
  page are one convention, not two:

```
## Docs

- [Testing](https://docs.stripe.com/testing.md): Simulate payments to test your integration.
- [Stripe SDKs](https://docs.stripe.com/sdks.md): Libraries and tools for interacting with your Stripe integration.
```

  Its preamble is addressed to agents directly ("When installing Stripe packages, always
  check the npm registry for the latest version rather than relying on memorized version
  numbers"), and `llms.txt` carries a whole "Instructions for Large Language Model
  Agents" section. Stripe treats the agent as a first-class reader of the same corpus.

### Generated vs written

Not visible from outside — Stripe is closed source. What the sample proves is that the
parameter lists are machine-uniform (every entry has the same three-part shape, the same
optionality vocabulary, the same enum nesting) while the deck, the orientation
paragraphs, and the hub descriptions are clearly hand-written. The boundary is
*within* the page: generated schema below `## Parameters`, written prose above it.
`style/how-stripe-builds-docs-markdoc.md` calls this "documentation as data" and notes a
validation step over the Markdoc AST.

### Worth copying

1. **Example before schema.** Lead the page with a runnable call and the literal
   response, then define the fields. A reader who only wants to copy-paste never scrolls.
2. **`` `name` (type, required) `` on one line**, description indented under it. It reads
   the same whether rendered or grepped, and it survives being flattened into an
   `llms.txt`.
3. **Hub pages as `[Title](url): purpose` lists.** Free routing, zero prose maintenance.
4. **One canonical machine rendition of every page.** Stripe's is `<url>.md`; the
   Starlight equivalent is the `llms.txt` bundle. Keep it the same artifact, not an export.

---

## react

Files read: `/Users/williamcory/docs-skills/exemplars/react/content/reference/react/useState.md`,
`/Users/williamcory/docs-skills/exemplars/react/content/reference/react/Suspense.md`,
`/Users/williamcory/docs-skills/exemplars/react/content/reference/react/hooks.md`,
`/Users/williamcory/docs-skills/exemplars/react/content/reference/eslint-plugin-react-hooks/lints/exhaustive-deps.md`,
`/Users/williamcory/docs-skills/exemplars/react/content/errors/377.md`,
`/Users/williamcory/docs-skills/exemplars/react/SOURCE.md`.

### Page shape

The fixed spine, from `content/reference/react/useState.md` (heading text and the
explicit anchor slugs are literal):

```
---
title: useState
---

<Intro>
`useState` is a React Hook that lets you add a [state variable](/learn/...) to your component.

```js
const [state, setState] = useState(initialState)
```
</Intro>

<InlineToc />

---

## Reference {/*reference*/}

### `useState(initialState)` {/*usestate*/}
<one-paragraph "call it like this" + code block>
[See more examples below.](#usage)

#### Parameters {/*parameters*/}
#### Returns {/*returns*/}
#### Caveats {/*caveats*/}

---

### `set` functions, like `setSomething(nextState)` {/*setstate*/}
#### Parameters {/*setstate-parameters*/}
#### Returns {/*setstate-returns*/}
#### Caveats {/*setstate-caveats*/}

---

## Usage {/*usage*/}
### <task phrased as a gerund, e.g. "Adding state to a component">
### Updating state based on the previous state
...

---

## Troubleshooting {/*troubleshooting*/}
### I've updated the state, but logging gives me the old value
### I'm getting an error: "Too many re-renders"
```

Three-part spine: `## Reference` → `## Usage` → `## Troubleshooting`. Counted over the
127 files under `content/reference/`: 87 carry `## Reference`, 90 carry `## Usage`, 54
carry `## Troubleshooting`, and 97 pages open with `<InlineToc />`. Within
`content/reference/react/` alone the ratio is 44 of 49. Corpus-wide the callout
vocabulary is three tags and only three: `<Note>` 207 uses, `<Pitfall>` 95, `<DeepDive>`
87, against 750 `<Sandpack>` editors. A page
with several callables (the hook and its returned setter) repeats the whole
Parameters/Returns/Caveats block once per callable, under its own `###`, separated by a
horizontal rule.

A component page (`Suspense.md`) swaps Parameters for Props:

```
## Reference
### `<Suspense>`
#### Props
#### Caveats
## Usage
## Troubleshooting
```

An overview page (`hooks.md`) is a themed routing list, no Reference/Usage spine:

```
---
title: "Built-in React Hooks"
---
<Intro>…this page lists all built-in Hooks in React.</Intro>
---
## State Hooks
<one paragraph explaining the category>
* [`useState`](/reference/react/useState) declares a state variable that you can update directly.
* [`useReducer`](/reference/react/useReducer) declares a state variable with the update logic inside a reducer function.
```js …tiny illustrative snippet… ```
---
## Context Hooks
```

A lint-rule page uses a different, rule-shaped spine:

```
## Rule Details
## Common Violations
### Invalid          <- "Examples of incorrect code for this rule:" + ❌-commented snippets
### Valid            <- "Examples of correct code for this rule:" + ✅-commented snippets
## Troubleshooting
```

### Per-entry format

Parameters and returns are bullet lists, not tables, because each entry needs a
paragraph and sub-bullets. Literal from `useState.md`:

```md
#### Parameters {/*parameters*/}

* `initialState`: The value you want the state to be initially. It can be a value of any type, but there is a special behavior for functions. This argument is ignored after the initial render.
  * If you pass a function as `initialState`, it will be treated as an _initializer function_. It should be pure, should take no arguments, and should return a value of any type. [See an example below.](#avoiding-recreating-the-initial-state)

#### Returns {/*returns*/}

`useState` returns an array with exactly two values:

1. The current state. During the first render, it will match the `initialState` you have passed.
2. The [`set` function](#setstate) that lets you update the state to a different value and trigger a re-render.

#### Caveats {/*caveats*/}

* `useState` is a Hook, so you can only call it **at the top level of your component** or your own Hooks. You can't call it inside loops or conditions.
* In Strict Mode, React will **call your initializer function twice** in order to [help you find accidental impurities.](#my-initializer-or-updater-function-runs-twice) This is development-only behavior and does not affect production.
```

Props carry stability markers inline, from `Suspense.md`:

```md
#### Props {/*props*/}
* `children`: The actual UI you intend to render. If `children` suspends while rendering, the Suspense boundary will switch to rendering `fallback`.
* <ExperimentalBadge /> **optional** `defer`: A boolean. When `true`, React may show the `fallback` first … Defaults to `false`.
```

`<CanaryBadge />` and `<ExperimentalBadge />` also appear inside `###` headings, so
release status is visible in the page's own table of contents.

Troubleshooting entries are headed by the reader's own words — a symptom in the first
person, not a cause: `### I've updated the state, but the screen doesn't update`,
`### My initializer or updater function runs twice`. These are search queries.

### Cross-link conventions

- Every heading carries an explicit anchor comment `{/*slug*/}` so an anchor never
  changes when the heading text is edited. Sub-blocks are prefixed by their owner
  (`{/*setstate-parameters*/}`) to keep them unique on a multi-callable page.
- Reference → Usage links are forward and by anchor: `[See more examples below.](#usage)`,
  `[See an example below.](#avoiding-recreating-the-initial-state)`. Caveats link forward
  to the Troubleshooting entry that explains them.
- Root-absolute site links: `/learn/state-a-components-memory`,
  `/reference/react-dom/flushSync`. Never relative paths.
- `<InlineToc />` sits directly after the `<Intro>` on long reference pages.
- Sections are separated by `---` horizontal rules — a visual reset between entries.

### Generated vs written

Nothing is generated. All 223 pages are hand-written Markdown and all five sidebars are
hand-maintained JSON trees (`{ title, path, routes: [...] }`), per
`/Users/williamcory/docs-skills/exemplars/react/SOURCE.md`. The filesystem is never
consulted for order. The one dynamic element is a `{{version}}` token used as a
sidebar section header and stamped at build time. Uniformity here is achieved by
convention and review, not by a generator — which is exactly the case a rule-following
LLM is good at.

### Worth copying

1. **The three-part spine `Reference` → `Usage` → `Troubleshooting`**, in that order,
   with a horizontal rule between them. It separates "what it is" from "what to do with
   it" from "why it went wrong" so a reader can stop at the level they need.
2. **`Parameters` / `Returns` / `Caveats` as a required trio**, repeated per callable.
   `Caveats` is the highest-value section and the one most docs omit: it is where Strict
   Mode double-invocation, batching, and identity stability get stated once, in bullets.
3. **Troubleshooting headings written as the reader's symptom in the first person.**
   They are the search query, so the page is findable from a failure.
4. **A closed callout vocabulary** — react.dev ships only `<Note>`, `<Pitfall>`,
   `<DeepDive>` across 483k words. The Starlight equivalent is `<Aside type="note|tip|caution|danger">`;
   pick a subset and never invent a fourth kind.

---

## vite

Files read: `/Users/williamcory/docs-skills/exemplars/vite/docs/config/server-options.md`,
`/Users/williamcory/docs-skills/exemplars/vite/docs/config/shared-options.md`,
`/Users/williamcory/docs-skills/exemplars/vite/docs/config/index.md`,
`/Users/williamcory/docs-skills/exemplars/vite/docs/guide/cli.md`,
`/Users/williamcory/docs-skills/exemplars/vite/SOURCE.md`.

### Page shape

A config page is a flat option record — no nesting, no grouping headings, one `##` per
option in source-declaration order. From `docs/config/server-options.md`:

```
# Server Options

Unless noted, the options in this section are only applied to dev.   <- scope sentence

## server.host
- **Type:** …
- **Default:** …
<prose>
::: tip NOTE … :::

## server.allowedHosts
## server.port
## server.strictPort
…
```

The heading is the **fully qualified option path** (`server.host`, `css.transformer`,
`resolve.tsconfigPaths`), not the leaf name. That makes every heading globally unique,
makes the anchor `#server-host` self-describing, and lets a reader search the docs for
the exact string they typed in their config file.

The whole config surface is eight files split by config namespace:
`index.md` (how to write a config file at all), `shared-options`, `server-options`,
`build-options`, `preview-options`, `dep-optimization-options`, `ssr-options`,
`worker-options`. No generator.

The CLI page (`docs/guide/cli.md`) is the cleanest command-reference shape in the whole
exemplar set:

```
# Command Line Interface

## Dev server
### `vite`
Start Vite dev server in the current directory. `vite dev` and `vite serve` are aliases for `vite`.
#### Usage
```bash
vite [root]
```
#### Options
| Options | |
| --- | --- |
| `--host [host]` | Specify hostname (`string`) |

## Build
### `vite build`
…
## Others
### `vite optimize`
**Deprecated**: the pre-bundle process runs automatically and does not need to be called.
```

Commands are grouped by lifecycle stage (`## Dev server`, `## Build`, `## Others`), each
command is a `###`, and every command has exactly two sub-sections: `#### Usage` with a
copyable synopsis line, and `#### Options` with a two-column table.

### Per-entry format

One config option, literal from `docs/config/shared-options.md`:

```md
## base

- **Type:** `string`
- **Default:** `/`
- **Related:** [`server.origin`](/config/server-options.md#server-origin)

Base public path when served in development or production. Valid values include:

- Absolute URL pathname, e.g. `/foo/`
- Full URL, e.g. `https://bar.com/foo/`
```

The metadata block is a bullet list of bold labels immediately under the heading, before
any prose. The label vocabulary is closed and its order is fixed. Counted across all
eight files in `docs/config/`, which hold 121 `##` option entries between them:
117 `**Type:**`, 69 `**Default:**`, 19 `**Related:**`, 8 `**Experimental:**`,
6 `**Deprecated**`, and exactly one each of `**Recommended**` and `**Example:**`. Type
is effectively mandatory; default appears only when there is one.

Lifecycle markers are the first bullet, above `Type`:

```md
## css.transformer

- **Experimental:** [Give Feedback](https://github.com/vitejs/vite/discussions/13835)
- **Type:** `'postcss' | 'lightningcss'`
- **Default:** `'postcss'`
```

```md
## esbuild

- **Type:** `ESBuildOptions | false`
- **Deprecated**

This option is converted to `oxc` option internally. Use `oxc` option instead.
```

`**Experimental:**` is not a bare word — it links to the feedback discussion, so the
marker is actionable.

A CLI flag is a table row, with the type in backticks at the end of the description and
the default inline:

```md
| Options | |
| --- | --- |
| `--host [host]` | Specify hostname (`string`) |
| `-c, --config <file>` | Use specified config file (`string`) |
| `--base <path>` | Public base path (default: `/`) (`string`) |
| `--minify [minifier]` | Enable/disable minification, or specify minifier to use (default: `"oxc"`) (`boolean \| "oxc" \| "terser" \| "esbuild"`) |
| `--app` | Build all environments, same as `builder: {}` (`boolean`, experimental) |
```

Note the argument-metavar convention carried into the flag name itself:
`<required>` vs `[optional]`, and short/long aliases joined by a comma in one cell.

Callouts are VitePress container syntax, and the `details` variant is used to fold an
FAQ-length digression inside an option entry without breaking the record:

```md
::: tip NOTE
There are cases when other servers might respond instead of Vite.
:::

::: details What hosts are safe to be added?
Hosts that you have control over which IP addresses they resolve to are safe to add.
:::

::: danger
Setting `server.allowedHosts` to `true` allows any website to send requests to your dev server through DNS rebinding attacks. See [GHSA-vg6x-rcgg-rjx6](…) for more details.
:::
```

### Cross-link conventions

- Root-absolute with the file extension and an anchor:
  `[`server.origin`](/config/server-options.md#server-origin)`. Anchors are the
  kebab-cased fully-qualified option name, derived mechanically from the heading.
- `**Related:**` is a first-class metadata row, so "see also" never gets buried in prose.
  It also points off-site when that is the honest answer:
  `- **Related:** [esbuild#preserve-symlinks](https://esbuild.github.io/api/#preserve-symlinks)`.
- `themeConfig.sidebar` is a **map keyed by URL prefix** (`/guide/`, `/config/`,
  `/changes/`), so the left rail swaps entirely at a section boundary instead of showing
  one global tree that is mostly irrelevant. In Starlight terms, this is the argument for
  a `Reference` group whose contents are just the reference, not the whole site.
- `themeConfig.outline.level = [2, 3]` — the on-page ToC shows `h2` and `h3` only, which
  is why a config page can have 40 `##` entries and still have a usable right rail.
- Nav labels are computed from the package version (`` `Migration from v${major-1}` ``)
  so they cannot go stale.

### Generated vs written

Everything is hand-written. Eight files cover the entire config surface with no
generator, which is the point: the format is strict enough that consistency is
achievable by convention. `/changes/` is the other structural idea — breaking changes
are a first-class docs section with **Current / Future / Past** groups kept in the nav
even when empty, so the deprecation lifecycle is visible rather than implied.

### Worth copying

1. **Heading = fully qualified option path.** `## server.host`, not `## host`. Unique
   anchors, greppable, matches what the user typed.
2. **A closed metadata vocabulary in fixed order** directly under the heading:
   `Experimental` / `Deprecated` → `Type` → `Default` → `Related`, then prose. Omit a row
   rather than writing "n/a".
3. **`Related` as a metadata row, not a trailing "See also" paragraph.** It survives
   edits to the prose.
4. **The CLI shape: `### \`cmd\`` → `#### Usage` (synopsis fence) → `#### Options`
   (two-column table).** The table cell carries description, default, and type together,
   which stays readable at 20 flags where a heading-per-flag would not.

---

## starlight

Files read: `/Users/williamcory/docs-skills/exemplars/starlight/content/reference/frontmatter.md`,
`/Users/williamcory/docs-skills/exemplars/starlight/content/reference/configuration.mdx`,
plus all twelve `content/components/*.mdx`, `content/guides/sidebar.mdx`,
`nav/astro.config.mjs`, `SIDEBAR.md`, `SOURCE.md`.

This is the exemplar to imitate most closely, because it is the framework `apps/site`
runs on: whatever shape it uses is known to render.

### Page shape

`content/reference/frontmatter.md`:

```
---
title: Frontmatter Reference
description: An overview of the default frontmatter fields Starlight supports.
---

<one paragraph of orientation + one worked example code fence>

## Frontmatter fields
### `title` (required)
### `description`
### `slug`
### `editUrl`
### `head`
### `tableOfContents`
### `template`
### `hero`
#### `HeroConfig`            <- the TypeScript interface for a compound value
### `banner`
### `lastUpdated`
### `prev`
### `next`
### `pagefind`
### `draft`
### `sidebar`
#### `SidebarConfig`         <- interface first
#### `label`                 <- then one h4 per sub-field
#### `order`
#### `hidden`
#### `badge`
#### `attrs`

## Customize frontmatter schema
### `extend`
```

`content/reference/configuration.mdx`:

```
## Configure the `starlight` integration
### `title` (required)
### `description`
### `logo`
#### `LogoConfig`
### `tableOfContents`
### `editLink`
### `sidebar`
#### Sorting                 <- prose sub-topics interleaved with the type blocks
#### Collapsing groups
#### Translating labels
#### `SidebarItem`           <- the type, last
#### `BadgeConfig`
### `locales`
#### `LocaleConfig`
#### Root locale
… (one ### per option, in the order the options appear in the config object)
## Configure content collections
### Loaders
#### `docsLoader()`
#### `i18nLoader()`
### Schemas
#### `docsSchema()`
#### `i18nSchema()`
```

Two levels only for entries: `###` for a top-level option, `####` for a nested type or
sub-field of that option. Compound values get their TypeScript interface printed
verbatim in a `ts` fence as a `####` named after the type, and the parent's `**type:**`
row links to it by anchor.

A component page (`content/components/*.mdx`) has its own fixed spine:

```
---
title: Tabs
description: Learn how to create tabbed interfaces in Starlight to group equivalent information.
---

import { Tabs, TabItem } from '@astrojs/starlight/components';
<one-sentence purpose + live <Preview> of the component>

## Import
```tsx
import { Tabs, TabItem } from '@astrojs/starlight/components';
```

## Usage
### <variation 1, e.g. "Sync tabs">
### <variation 2, e.g. "Add icons to tabs">

## `<Tabs>` Props
**Implementation:** [`Tabs.astro`](https://github.com/withastro/starlight/blob/main/packages/starlight/src/user-components/Tabs.astro)
The `<Tabs>` component … accepts the following props:
### `syncKey`

## `<TabItem>` Props
**Implementation:** [`TabItem.astro`](…)
### `label`
### `icon`
```

`## Import` → `## Usage` → `` ## `<Name>` Props `` is used on all twelve component pages
without exception, including the two that have no props at all, which say so explicitly:
"The `<Steps>` component does not accept any props."

### Per-entry format

The literal template, from `content/reference/frontmatter.md` and every component page.
Note the two trailing spaces after the type line — that is a hard line break, and it is
how `**type:**` and `**default:**` end up on consecutive lines:

```md
### `tableOfContents`

**type:** `false | { minHeadingLevel?: number; maxHeadingLevel?: number; }`

Overrides the [global `tableOfContents` config](/reference/configuration/#tableofcontents).
Customize the heading levels to be included or set to `false` to hide the table of contents on this page.

```md
---
# src/content/docs/example.md
title: Page with only H2s in the table of contents
tableOfContents:
  minHeadingLevel: 2
  maxHeadingLevel: 2
---
```
```

With a default (the `··` marks two literal trailing spaces):

```md
### `template`

**type:** `'doc' | 'splash'`··
**default:** `'doc'`

Set the layout template for this page.
Pages use the `'doc'` layout by default.
```

Required is expressed two ways, and both are in use. In the config/frontmatter
references it is part of the heading:

```md
### `title` (required)

**type:** `string | Record<string, string>`
```

In the component prop references it is its own bold line above the type:

```md
### `label`

**required**··
**type:** `string`

A tab item must include a `label` attribute set to the text that will be displayed in the tab.
```

When the type is another named type, the type row is a link, and the type gets its own
`####` with a fenced interface:

```md
### `sidebar`

**type:** [`SidebarConfig`](#sidebarconfig)

Control how this page is displayed in the [sidebar](/reference/configuration/#sidebar), when using an autogenerated link group.

#### `SidebarConfig`

```ts
interface SidebarConfig {
  label?: string;
  order?: number;
  hidden?: boolean;
  badge?: string | BadgeConfig;
  attrs?: Record<string, string | number | boolean | undefined>;
}
```
```

When the linked type lives on another page, the row is raw HTML so the link works inside
the inline code span:

```md
**type:** <code>string | <a href="/reference/configuration/#badgeconfig">BadgeConfig</a></code>
```

Every entry's example fence carries the target file path as its first comment line
(`# src/content/docs/example.md`, `// astro.config.mjs`, `// src/content.config.ts`), so
a snippet is never ambiguous about where it goes. Multiple short fences beat one long
fence: `prev` shows three separate three-line examples (hide / override text / override
both) rather than one combined block.

### Cross-link conventions

- Root-absolute, trailing slash, lowercase anchor:
  `[global `editLink` config](/reference/configuration/#editlink)`,
  `[one of Starlight's built-in icons](/reference/icons/#all-icons)`. The site sets
  `trailingSlash: 'always'` in `nav/astro.config.mjs`, so internal links must carry it.
- Anchors are the auto-slug of the heading: `` ### `title` (required) `` →
  `#title-required`; `` #### `BadgeConfig` `` → `#badgeconfig`.
- Frontmatter fields link to the config option they override, and the config option
  links back — the override relationship is documented from both ends.
- Component pages link the props section to the implementation file on GitHub:
  `**Implementation:** [`Aside.astro`](https://github.com/withastro/starlight/blob/main/packages/starlight/src/user-components/Aside.astro)`.
  Cheap, and it makes the doc auditable against the source.
- Cross-component links point at the *guide section* that shows the combination:
  "See the ["Group cards"](/components/card-grids/#group-cards) guide for an example",
  instead of duplicating the example on both pages.

### Generated vs written

Nothing in the docs tree is generated. What is derived is the **navigation**:
`nav/astro.config.mjs` declares five groups, one with an explicit ordered slug list and
four with `autogenerate: { directory }`. Within an autogenerated group the order is
`sidebar.order` frontmatter first, then alphabetical by the file `id`. So the ordering
policy is: promote the two-to-four pages that must come first with an explicit
`sidebar.order`, and let alphabetical absorb the tail. That is the cheapest scheme that
still lets an author intervene, and it means adding a reference page requires editing
zero config.

Reference is six files, one per config surface — `frontmatter`, `configuration`,
`overrides`, `plugins`, `route-data`, `icons` — and that is the whole API.

### Worth copying

1. **`**type:**` / `**default:**` / `**required**` as bold labels with a hard line break**,
   directly under the heading, before prose. This is the exact syntax that renders
   correctly in Starlight, and it is what the framework's own reference uses.
2. **A named type gets a `####` and a verbatim `ts` interface fence**, and the parent's
   type row links to it. Do not paraphrase a type in prose.
3. **Every example fence names its target file in a leading comment.** Several tiny
   examples, one per behavior, beat one combined example.
4. **The component page spine `## Import` → `## Usage` → `` ## `<Name>` Props ``**, and
   say "does not accept any props" rather than dropping the section.
5. **One reference file per config surface**, not one per option and not one giant page.

---

## Starlight framework facts

Everything in this section is quoted from
`/Users/williamcory/docs-skills/exemplars/starlight/content/reference/frontmatter.md`,
`.../content/reference/configuration.mdx`, `.../content/components/*.mdx`,
`.../content/guides/sidebar.mdx`, `.../content/guides/authoring-content.mdx`, and
`.../nav/astro.config.mjs`. Use it as the authoring contract for `apps/site`.

### Frontmatter fields (complete)

From `content/reference/frontmatter.md`, in the order the reference lists them.

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `title` | `string` | — | **Required.** Shown at the top of the page, in browser tabs, and in page metadata. |
| `description` | `string` | — | Page metadata; search engines and social previews. |
| `slug` | `string` | — | Overrides the page slug. |
| `editUrl` | `string \| boolean` | — | Overrides the global `editLink` config. `false` disables the "Edit page" link for this page; a string points it at an alternative URL. |
| `head` | `HeadConfig[]` | — | Extra tags in this page's `<head>`. |
| `tableOfContents` | `false \| { minHeadingLevel?: number; maxHeadingLevel?: number; }` | global `{ minHeadingLevel: 2, maxHeadingLevel: 3 }` | `false` hides the right-hand ToC on this page. |
| `template` | `'doc' \| 'splash'` | `'doc'` | `'splash'` is "a wider layout without any sidebars designed for landing pages". |
| `hero` | `HeroConfig` | — | "Works well with `template: splash`." |
| `banner` | `{ content: string }` | — | Announcement banner; `content` may contain HTML. |
| `lastUpdated` | `Date \| boolean` | global `lastUpdated` | A date must be a valid YAML timestamp and overrides Git history. |
| `prev` | `boolean \| string \| { link?: string; label?: string }` | global `pagination` | `false` hides; string replaces the text; object replaces both. |
| `next` | same as `prev` | global `pagination` | "Same as `prev` but for the next page link." |
| `pagefind` | `boolean` | `true` | `false` excludes the page from the search index. |
| `draft` | `boolean` | `false` | "not be included in production builds … only visible during development". Draft pages cannot be referenced by slug in the sidebar config; drafts in an autogenerated directory are excluded automatically in production. |
| `sidebar` | `SidebarConfig` | — | Only affects autogenerated groups. |
| `sidebar.label` | `string` | the page `title` | Label in an autogenerated group. |
| `sidebar.order` | `number` | — | "Lower numbers are displayed higher up in the link group." |
| `sidebar.hidden` | `boolean` | `false` | "Prevents this page from being included in an autogenerated sidebar group." |
| `sidebar.badge` | `string \| BadgeConfig` | — | String uses the accent color; object takes `text`, `variant`, `class`. |
| `sidebar.attrs` | `Record<string, string \| number \| boolean \| undefined>` | — | HTML attributes on the sidebar link. Merged with `autogenerate.attrs` when both are set. |

Literal frontmatter examples, quoted from that file:

```md
---
# src/content/docs/example.md
title: Page with only H2s in the table of contents
tableOfContents:
  minHeadingLevel: 2
  maxHeadingLevel: 2
---
```

```md
---
# src/content/docs/example.md
title: Page to display first
sidebar:
  order: 1
---
```

```md
---
# src/content/docs/example.md
title: Page with a badge
sidebar:
  badge:
    text: Experimental
    variant: caution
---
```

```md
---
# src/content/docs/example.md
title: Page opening in a new tab
sidebar:
  # Opens the page in a new tab
  attrs:
    target: _blank
---
```

The interfaces, quoted verbatim from `content/reference/frontmatter.md`:

```ts
interface SidebarConfig {
  label?: string;
  order?: number;
  hidden?: boolean;
  badge?: string | BadgeConfig;
  attrs?: Record<string, string | number | boolean | undefined>;
}
```

```ts
interface HeroConfig {
  title?: string;
  tagline?: string;
  image?:
    | { file: string; alt?: string }
    | { dark: string; light: string; alt?: string }
    | { html: string };
  actions?: Array<{
    text: string;
    link: string;
    variant?: 'primary' | 'secondary' | 'minimal';
    icon?: string;
    attrs?: Record<string, string | number | boolean>;
  }>;
}
```

Schema extension, from the same file:

```ts
// src/content.config.ts
import { defineCollection } from 'astro:content';
import { docsLoader, i18nLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
```

`docsSchema()` takes one option, `extend`: "**type:** Zod schema or function that returns
a Zod schema  **default:** `z.object({})`". A `type: 'tutorial' | 'guide' | 'reference'`
discriminator is the documented example of what to add:

```ts
schema: docsSchema({
  extend: z.object({
    description: z.string(),
    category: z.enum(['tutorial', 'guide', 'reference']).optional(),
  }),
}),
```

### Sidebar configuration

From `content/reference/configuration.mdx`. A sidebar item is defined by exactly one of
four properties, quoted:

- "`link` — a single link to a specific URL, e.g. `'/home'` or `'https://example.com'`. A link must also have a `label`."
- "`slug` — a reference to an internal page, e.g. `'guides/getting-started'`. The linked page's title will be used as the label by default."
- "`items` — an array containing more sidebar links, subgroups, and autogenerated entries. A group must also have a `label`."
- "`autogenerate` — an object specifying a directory of your docs to automatically generate links and subgroups for."

Literal config:

```js
starlight({
	sidebar: [
		// A single link item labelled “Home”.
		{ label: 'Home', link: '/' },
		// A group labelled “Start Here” containing four links.
		{
			label: 'Start Here',
			items: [
				// Using `slug` for internal links.
				{ slug: 'intro' },
				{ slug: 'installation' },
				// Or using the shorthand for internal links.
				'tutorial',
				'next-steps',
			],
		},
		// A group linking to all pages in the reference directory.
		{
			label: 'Reference',
			items: [{ autogenerate: { directory: 'reference' } }],
		},
	],
});
```

Collapsing, quoted: "Groups of links are expanded by default. You can change this
behavior by setting a group's `collapsed` property to `true`. Autogenerated subgroups are
also expanded by default. Set the `autogenerate.collapsed` property to collapse them."

```js
sidebar: [
  { label: 'Collapsed Links', collapsed: true, items: ['intro', 'next-steps'] },
  {
    label: 'Reference',
    items: [{ autogenerate: { directory: 'reference', collapsed: true } }],
  },
],
```

Group-wide HTML attributes, from `content/guides/sidebar.mdx`:

```js
starlight({
	sidebar: [
		{
			autogenerate: {
				directory: 'constellations',
				attrs: { style: 'font-style: italic' },
			},
		},
	],
});
```

"Individual pages can specify custom attributes using the `sidebar.attrs` frontmatter
field which will be merged with the `autogenerate.attrs` configuration."

Sorting, quoted from `configuration.mdx`: "Autogenerated sidebar groups are sorted by
filename alphabetically." And from `guides/sidebar.mdx`: "By default, pages are sorted in
alphabetical order according to the file `id`." `sidebar.order` frontmatter overrides
this per page; pages without an `order` fall back to alphabetical.

The types, verbatim from `configuration.mdx`:

```ts
type SidebarItem =
	| string
	| ({
			translations?: Record<string, string>;
			badge?: string | BadgeConfig;
	  } & (
			| { link: string; label: string; attrs?: Record<string, string | number | boolean | undefined> }
			| { slug: string; label?: string; attrs?: Record<string, string | number | boolean | undefined> }
			| { label: string; items: SidebarItem[]; collapsed?: boolean }
	  ))
	| {
			autogenerate: {
				directory: string;
				collapsed?: boolean;
				attrs?: Record<string, string | number | boolean | undefined>;
			};
	  };
```

```ts
interface BadgeConfig {
	text: string;
	variant?: 'note' | 'tip' | 'caution' | 'danger' | 'success' | 'default';
	class?: string;
}
```

Other integration options relevant to a reference section, from `configuration.mdx`:

- `tableOfContents` — "**type:** `false | { minHeadingLevel?: number; maxHeadingLevel?: number }`  **default:** `{ minHeadingLevel: 2, maxHeadingLevel: 3 }`". Only `h2` and `h3` show by default, which is why entries should be `###` and nested types `####`.
- `editLink` — "**type:** `{ baseUrl: string }`". "The final link will be `editLink.baseUrl` + the current page path." Example: `baseUrl: 'https://github.com/withastro/starlight/edit/main/docs/'`. Per-page `editUrl` frontmatter overrides it — this is the hook for pointing a generated page at its real source file.

### Components: exact imports and props

All built-ins come from one module: `import { X } from '@astrojs/starlight/components';`.
In Markdoc the same components are lowercase `{% x %}` tags and need no import.

**Aside** — `content/components/asides.mdx`

```mdx
import { Aside } from '@astrojs/starlight/components';

<Aside>Some content in an aside.</Aside>
<Aside type="caution">Some cautionary content.</Aside>
<Aside type="tip">Other content is also supported in asides.</Aside>
<Aside type="danger">Do not give your password to anyone.</Aside>
<Aside type="caution" title="Watch out!">A warning aside *with* a custom title.</Aside>
<Aside type="tip" icon="starlight">A tip aside *with* a custom icon.</Aside>
```

Props: `type` — "**type:** `'note' | 'tip' | 'caution' | 'danger'`  **default:** `'note'`";
`title` — `string`, falls back to the default title for the type; `icon` —
`StarlightIcon`. Colors, quoted: "`note` asides (the default) are blue … `tip` asides are
purple … `caution` asides are yellow … `danger` asides are red".

There is also a Markdown-native syntax (no import, works in plain `.md`), from
`content/guides/authoring-content.mdx`: "Aside blocks are indicated using a pair of
triple colons `:::` to wrap your content, and can be of type `note`, `tip`, `caution` or
`danger`."

```md
:::note
Starlight is a documentation website toolkit built with Astro.
:::

:::tip[Did you know?]
Custom title in square brackets after the type.
:::

:::tip{icon="heart"}
Custom icon in curly brackets after the type or after the custom title.
:::
```

**Tabs / TabItem** — `content/components/tabs.mdx`

```mdx
import { Tabs, TabItem } from '@astrojs/starlight/components';

<Tabs>
	<TabItem label="Stars">Sirius, Vega, Betelgeuse</TabItem>
	<TabItem label="Moons">Io, Europa, Ganymede</TabItem>
</Tabs>

<Tabs syncKey="constellations">
	<TabItem label="Orion" icon="star">Bellatrix, Rigel, Betelgeuse</TabItem>
</Tabs>
```

`<Tabs>` props: `syncKey` — `string`, "A key used to keep multiple tab groups
synchronized across multiple pages." All `<Tabs>` on a page with the same `syncKey` show
the same active label, and the choice persists across navigations — so package-manager
and OS tabs must share a `syncKey` and identical labels.
`<TabItem>` props: `label` — **required**, `string`; `icon` — `string`, a built-in icon name.

**Steps** — `content/components/steps.mdx`

```mdx
import { Steps } from '@astrojs/starlight/components';

<Steps>

1. Import the component into your MDX file:

   ```js
   import { Steps } from '@astrojs/starlight/components';
   ```

2. Wrap `<Steps>` around your ordered list items.

</Steps>
```

"The `<Steps>` component does not accept any props." It wraps a **standard Markdown
ordered list**; the blank lines around the list matter.

**Card / CardGrid** — `content/components/cards.mdx`, `card-grids.mdx`

```mdx
import { Card, CardGrid } from '@astrojs/starlight/components';

<Card title="Check this out">Interesting content you want to highlight.</Card>
<Card title="Stars" icon="star">Sirius, Vega, Betelgeuse</Card>

<CardGrid>
	<Card title="Check this out" icon="open-book">Interesting content.</Card>
	<Card title="Other feature" icon="information">More information.</Card>
</CardGrid>

<CardGrid stagger>…</CardGrid>
```

`<Card>` props: `title` — **required**, `string`; `icon` — `string`.
`<CardGrid>` props: `stagger` — `boolean`, "Defines whether to stagger the cards in the
grid or not." (Documented as a home-page device for key features.)

**LinkCard** — `content/components/link-cards.mdx`

```mdx
import { LinkCard } from '@astrojs/starlight/components';

<LinkCard title="Authoring Markdown" href="/guides/authoring-content/" />

<LinkCard
	title="Internationalization"
	href="/guides/i18n/"
	description="Configure Starlight to support multiple languages."
/>
```

Props: `title` — **required**, `string`; `href` — **required**, `string`; `description` —
`string`. "accepts the following props, as well as all other `<a>` element attributes".

**FileTree** — `content/components/file-tree.mdx`

```mdx
import { FileTree } from '@astrojs/starlight/components';

<FileTree>

- astro.config.mjs
- package.json
- src
  - components
    - **Header.astro**
    - Title.astro
  - pages/

</FileTree>
```

"The `<FileTree>` component does not accept any props." Conventions: a trailing `/` makes
a directory with no listed contents; `**bold**` highlights an entry; text after a name is
a comment ("`Header.astro` an **important** file"); `...` or `…` is a placeholder entry;
backticks escape special characters in a filename.

**Badge** — `content/components/badges.mdx`

```mdx
import { Badge } from '@astrojs/starlight/components';

<Badge text="Note" variant="note" />
<Badge text="Custom" variant="success" style={{ fontStyle: 'italic' }} />
<Badge text="New" size="small" />
```

Props: `text` — **required**, `string`; `variant` — "**type:** `'note' | 'danger' |
'success' | 'caution' | 'tip' | 'default'`  **default:** `'default'`" ("`note` (blue),
`tip` (purple), `danger` (red), `caution` (orange), `success` (green), or `default` (theme
accent color)"); `size` — `'small' | 'medium' | 'large'`. Also accepts any other `<span>`
attributes.

**Code** — `content/components/code.mdx`

```mdx
import { Code } from '@astrojs/starlight/components';

export const exampleCode = `console.log('This could come from a file or CMS!');`;

<Code code={exampleCode} lang="js" title="example.js" mark={['file', 'CMS']} />
```

```mdx
import { Code } from '@astrojs/starlight/components';
import importedCode from '/tsconfig.json?raw';

<Code code={importedCode} lang="json" title="tsconfig.json" />
```

Props: "accepts all the props documented in the Expressive Code 'Code Component' docs" —
the implementation is `astro-expressive-code`, not Starlight. Use `<Code>` only for code
that comes from a variable or an import; a plain fence is right for literal code. The
`?raw` import is the mechanism for embedding a real source file so it cannot drift.

**Icon** and **LinkButton**, for completeness:

```mdx
import { Icon, LinkButton } from '@astrojs/starlight/components';

<Icon name="star" />
<Icon name="starlight" label="The Starlight logo" size="2rem" color="goldenrod" />

<LinkButton href="/getting-started/">Get started</LinkButton>
<LinkButton href="https://docs.astro.build" variant="secondary" icon="external" iconPlacement="start">
	Related: Astro
</LinkButton>
```

`<Icon>`: `name` **required** (`StarlightIcon`), `label`, `size`, `color`, `class`.
`<LinkButton>`: `href` **required**; `variant` `'primary' | 'secondary' | 'minimal'`
default `'primary'`; `icon`; `iconPlacement` `'start' | 'end'` default `'end'`.

### Two more mechanics

Expressive Code fence meta, seen throughout the component pages, is available on any
fence: `` ```js {5,15} `` highlights lines, `` ```mdx 'syncKey="constellations"' ``
highlights a literal string, `` ```mdx /icon="\w+"/ `` highlights a regex match,
`` ```js [vite.config.js] `` (VitePress) / `title="example.js"` (Expressive Code) sets a
filename tab.

Disabling Starlight's content styles inside a custom component, from
`content/components/using-components.mdx`: "If these styles conflict with your
component's appearance, set the `not-content` class on your component to disable them."

---
