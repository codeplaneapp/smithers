# Notes: documentation style references, distilled for GENERATED REFERENCE pages

Scope: API/package reference, CLI verb reference, config/rule reference. Rules below are the
ones that survive the trip from prose style guides to auto-generated or LLM-generated
reference pages. Quotes are verbatim from the source unless marked otherwise.

Sources read: `~/docs-skills/references/{README.md, diataxis, google-developer-documentation-style-guide,
google-technical-writing-courses, vale-style-rule-packages, keep-a-changelog, readme-guidance}`.

Gap found in the library: the Google pages **Documenting command-line syntax**
(`/style/code-syntax`) and **Formatting placeholders** (`/style/placeholders`) are referenced
by four stored files but are **not stored**. They are the two pages that define `[optional]`,
`{a|b}`, `...`, and `UPPER_SNAKE` placeholders. I fetched both from the live primary source;
their rules are marked `(fetched)` below. Worth adding to that folder.

---

## Diátaxis — the reference quadrant

Source: `diataxis/reference.rst`, `reference-explanation.rst`, `map.rst`, `compass.rst`,
`quality.rst`, `foundations.rst`, `start-here.rst`, `how-to-use-diataxis.rst`. CC BY-SA 4.0.

**What reference is**

- "Reference guides are **technical descriptions** of the machinery and how to operate it.
  Reference material is **information-oriented**."
- "The only purpose of a reference guide is to describe, as succinctly as possible, and in an
  orderly way."
- "Whereas the content of tutorials and how-to guides are led by needs of the user, reference
  material is led by the product it describes." Reference is product-led, not user-led.
- Reference serves the user **at work** (application of skill), not at study. Compass row:
  content that "informs cognition" + serves "application of skill" ⇒ reference.
- Map row for reference: what it does = "state, describe, inform"; answers = "What is...?";
  oriented to = "information"; purpose = "to describe the machinery"; form = "dry
  description"; analogy = "information on the back of a food packet".
- "Your users need reference material because they need truth and certainty — firm platforms
  on which to stand while they work."

**Describe, don't instruct**

- "*Neutral description* is the key imperative of technical reference."
- "It should be **austere**. One hardly *reads* reference material; one *consults* it."
- "There should be no doubt or ambiguity in reference; it should be wholly authoritative."
- Style and form, verbatim list: "austere and uncompromising / neutrality, objectivity,
  factuality / structured according to the structure of the machinery itself".
- The four things that must NOT leak in: "to explain, instruct, discuss, opine, and all these
  things run counter to the needs of technical reference, which instead demands accuracy,
  precision, completeness and clarity."
- "It can be tempting to introduce instruction and explanation, simply because description can
  seem too inadequate to be useful... Instead, link to how-to guides, explanation and
  introductory tutorials." ⇒ the fix for a missing explanation is a link, never a digression.
- "Although reference should not attempt to show how to perform tasks, it can and often needs
  to include a description of how something works or the correct way to use it."

**Consistency and standard patterns**

- "**Reference material is useful when it is consistent.** Standard patterns are what allow us
  to use reference material effectively. Your job is to place the material that your user needs
  where they expect to find it, in a format that they are familiar with."
- "There are many opportunities in writing to delight your readers with your extensive
  vocabulary and command of multiple styles, but reference material is definitely not one of
  them." ⇒ vocabulary variation is a defect in reference, not a virtue.

**Structure mirrors the product**

- "**the structure of the documentation should mirror the structure of the product**, so that
  the user can work their way through them at the same time."
- "If a method is part of a class that belongs to a certain module, then we should expect to
  see the same relationship in the documentation too."
- "It doesn't mean forcing the documentation into an unnatural structure."
- Corollary from `quality.rst`: mirroring the code architecture "makes gaps in the
  documentation much more clearly visible" — the structure is itself the completeness check.

**Examples in reference**

- "**Examples** are valuable ways of providing illustration that helps readers understand
  reference, while avoiding the risk of becoming distracted from the job of describing. For
  example, an example of usage of a command can be a succinct way of illustrating it and its
  context, without falling into the trap of trying to explain or instruct."
- Warning: "examples are fun things to develop, and it can be tempting to develop them into
  explanation (using them to say *why*, or show *what if*, or how it came to be)."

**The language of reference guides** (`reference.rst` gives three sentence patterns)

1. State facts about the machinery and its behaviour — e.g. "Django's default logging
   configuration inherits Python's defaults. It's available as
   ``django.utils.log.DEFAULT_LOGGING`` and defined in ``django/utils/log.py``".
2. "List commands, options, operations, features, flags, limitations, error messages, etc." —
   e.g. "Sub-commands are: a, b, c, d, e, f."
3. "Provide warnings where appropriate." — e.g. "You must use a. You must not apply b unless c.
   Never d." (modal `must` / `must not` / `never` is the sanctioned imperative form here.)

**Reference vs explanation**

- Rules of thumb: "**If it's boring and unmemorable** it's probably *reference*." "**Lists of
  things** (such as classes or methods or attributes), and **tables of information**, will
  generally turn out to belong in *reference*." "if you can imagine reading something in the
  bath, probably, it's *explanation*."
- The test: "is this something someone would turn to while working... Or is it something they'd
  need once they have stepped away from the work, and want to think about it?"
- Explanatory material sprinkled into reference "is bad for the reference, interrupted and
  obscured by digressions. But it's bad for the explanation too, because it's not allowed to
  develop appropriately and do its own work."

**Auto-generated reference**

- "Some reference material (such as API documentation) can be generated automatically by the
  software it describes, which is a powerful way of ensuring that it remains faithfully
  accurate to the code."
- Immediately followed by the sidebar: "Unfortunately, too many software developers think that
  auto-generated reference material is all the documentation required." ⇒ generation buys
  accuracy, not completeness; the four quadrants still need filling.

**Quality**

- Functional quality = "*accuracy*, *completeness*, *consistency*, *usefulness*, *precision*",
  objective, measurable, independent of one another. "any failure to meet all of these
  standards is readily apparent to the user."
- "**Diátaxis cannot address functional quality in documentation.**" It exposes lapses; it does
  not supply them. For generated reference, functional quality is the generator's job.

---

## Google developer documentation style guide

Source: `google-developer-documentation-style-guide/*` (CC BY 4.0), plus two pages fetched live.

### API reference code comments (`api-reference-comments.md`) — the load-bearing page

- "provide a complete API reference, typically generated from source code using document
  comments that describe all public classes, methods, constants, and other members."
- The API reference **must** provide a description for each of:
  - "Every class, interface, struct, and any other similar member of the API".
  - "Every constant, field, enum, and typedef."
  - "Every method, with a description for each parameter, the return value, and any exceptions
    thrown."
- "extremely strong suggestions":
  - "On each unique page (for a class, interface, etc.), include a code sample (~5-20 lines) at
    the top."
  - "Put all API names, classes, methods, constants, and parameters in code font, and link each
    name to the corresponding reference page."
  - "Put string literals in code font, and enclose them in double quotation marks."
  - Class-name spelling must match the code, "with capital letters and no spaces".
  - "Don't make class names plural (`Intents`, `Activities`); instead, add a plural noun
    (`Intent` objects, `Activity` instances)."
- First sentence of a class/interface description: "briefly state the intended purpose or
  function of the class or interface with information that can't be deduced from the class name
  and signature."
  - "Don't repeat the class name in the first sentence."
  - "Don't say 'this class will/does ...'"
  - "Don't use a period before the actual end of the sentence, because some document generators
    naively terminate the 'short description' at the first period." ⇒ this is why *e.g.* is
    banned in a first sentence; "use *for example* instead".
  - "make the first sentence unique and descriptive, yet short" (generators extract it for
    index pages).
- Members (constants and fields): "Make descriptions for members (constants and fields) as
  brief as possible. Be sure to link to relevant methods that use the constant or field."
- Methods, first sentence: "briefly state what action the method performs." Then "explain why
  and how to use the method, state any prerequisites that must be met before calling it, give
  details about exceptions that may occur, and specify any related APIs."
- "Document any dependencies... and how the method behaves if such a dependency is missing."
- "Use present tense for all descriptions" — "Adds a new bird to the ornithology list.",
  "Returns a bird."
- **Method first-verb table** (mechanical, checkable):
  - operation + returns data ⇒ start with the operation verb: "Adds a new bird to the
    ornithology list and returns the ID of the new entry."
  - getter returning boolean ⇒ "Checks whether ...."
  - getter returning non-boolean ⇒ "Gets the ...."
  - no return value ⇒ "Sets the ....", "Updates the ....", "Deletes the ....", "Registers ...."
  - callback (`on*` methods) ⇒ "Called by ....", then "Subclasses implement this method to ...."
  - convenience constructor ⇒ "Creates a ...."
- **Parameters**:
  - "Capitalize the first word, and end the sentence or phrase with a period."
  - "Begin descriptions of non-boolean parameters with 'The' or 'A' if possible" — "The ID of
    the bird you want to get."
  - Boolean parameter that instructs the API: "state what the API does if the parameter is true
    and if it's false" — "`enableCertificateValidation`: If true, validates the SSL certificate
    before proceeding. If false, trusts the certificate without validating it."
  - Boolean parameter that declares state: "use the format 'True if ...; false otherwise.'"
  - "In this context, don't put the words 'true' and 'false' in code font or quotation marks."
  - Defaults: "explain what the behavior is for each value or range of values, and then say what
    the default value is. Use the format *Default:* to explain the default value."
- **Return values**: "Be as brief as possible in the return value's description; put any
  detailed information in the class description." Non-boolean ⇒ start with "The ...";
  boolean ⇒ "True if ...; false otherwise."
- **Exceptions**: if the generator inserts "Throws", "begin your description with 'If ...'"
  ("If no key is assigned."); otherwise "begin with 'Thrown when ...'".
- **Deprecations**: "When something is deprecated, tell the user what to use as a replacement.
  (If you track your API with version numbers, mention which version it was first deprecated
  in.)" "Only the first sentence of a description appears in the summary section and index, so
  put the most important information there." Examples: "Deprecated. Use #CameraPose instead.";
  "Deprecated. Access this field using the `getField` method."

### Command-line syntax (fetched: developers.google.com/style/code-syntax)

- Optional: "Use square brackets around an argument to indicate that it's optional." —
  `gcloud dns GROUP [GLOBAL_FLAG] [FILENAME]`
- Mutually exclusive: "Use curly braces to indicate that the reader must choose one—and only
  one—of the items inside the braces... To separate each choice, use a pipe (`|`)." — `{FILE_1|FILE_2}`
- Repetition: "Use three dots and no spaces (`...`) to indicate that the reader can specify
  multiple values for the argument." — `gcloud dns GROUP [GLOBAL_FLAG ...]`
- Line breaks: "When a line exceeds 80 characters, you can safely add a line break before some
  characters, such as a single hyphen, double hyphen, underscore, or quotation marks."
- Continuation: "When you split a command line with a line break, each line except the last line
  must end with the command-continuation character." Linux/Cloud Shell: "A backslash typically
  preceded with a space (`\`)". Windows: "A caret preceded with a space (`^`)".
- Prompt: "When you're showing a one-line command, the command prompt (the `$` symbol) is
  optional. However, if your document includes both multi-line and one-line commands, then we
  recommend using the command prompt for all of the commands in the document for consistency."
- Output: "If your command-line instructions include a combination of input and output lines, we
  recommend using separate code blocks for input and output."
- Link the command: "Provide an inline link to the command reference. A good place for that link
  is in the text that introduces the command or a series of steps."
- "Provide a click-to-copy command example that the reader doesn't need to edit after they copy
  it."

### Placeholders (fetched: developers.google.com/style/placeholders)

- "Use uppercase characters with underscore delimiters." Recommended: `API_NAME`, `METHOD_NAME`.
  Not recommended, all of: `API-name`, `API_name`, `API name`, `api_name`, `api-name`, `apiName`.
- "Don't include possessive adjectives in placeholders." Not recommended: `MY_API_NAME`,
  `YOUR_API_NAME`.
- Markup: HTML `<code><var>PLACEHOLDER_NAME</var></code>`; Markdown inline uses backticks +
  italics; inside a fenced block, plain uppercase text (no formatting available).
- One placeholder: "Replace PLACEHOLDER with a description of what the placeholder represents."
- Several: "Replace the following:" then a bulleted list **ordered by appearance in the sample**,
  each item `PLACEHOLDER_NAME`: description.
- `text-formatting.md` corroborates: "Use all-capitals for placeholders."

### Code samples (`code-samples.md`)

- "**Wrap lines** at 80 characters."
- "**Mark code blocks as preformatted text**. In HTML, use a `pre` element; in Markdown, indent
  every line of the code block by four spaces." (fences are the modern equivalent)
- "**Indicate omitted code by using a comment** in the syntax of the language of your code
  sample. Don't use three dots or the ellipsis character (`…`). If a code block contains an
  omission, don't format the block as click-to-copy."
- "Follow the indentation guidelines in the relevant code style guide... using spaces instead of
  tabs and using two spaces for each indentation level."
- "In most cases, precede a code sample with an introductory sentence or paragraph. The
  introduction can end with a colon or a period; usually a colon if it immediately precedes the
  sample, usually a period if there's more material... between the introduction and the sample."
- Not recommended pattern, explicitly: an introduction ending in a colon when a link sentence
  intervenes before the sample.

### Code in text (`code-in-text.md`)

- Code font signals three things: "the text is meant to be entered verbatim", "where the
  boundaries of the text to enter are", and separation from surrounding text.
- **In code font** (non-exhaustive, the whole list matters for reference pages): attribute names
  and values; class names; command output; command-line utility names (`gcloud`, `kubectl`);
  data types; database row/column names; defined constant values; DNS record types; HTML/XML
  element names; enum names; environment variable names; filenames, extensions and paths;
  folders and directories; HTTP content-type values; HTTP status codes; HTTP verbs; IAM role
  names; IP addresses; language keywords; method and function names; namespace aliases;
  placeholder variables; package names; port numbers; query parameter names and values; strings
  used in commands and code; text input; UI elements rendered from entered text.
- **Not in code font**: domain names; names of products, services and organizations; "URLs that
  the reader is supposed to follow in a browser".
- "When you refer to an element name, don't put angle brackets (`<>`) around the element name."
- "Generally, don't put quotation marks around code unless the quotation marks are part of the
  code."
- Booleans: "If you refer directly to a Boolean data type value (such as `true` or `false`...),
  format the value as code. If you refer to the evaluation of a Boolean condition as true or
  false, then refer to the evaluation in non-code font."
- Method names in text: "omit the class name except where including it would prevent ambiguity."
  Recommended "call its `get` method", not "call its `animal.get` method".
- HTTP status codes: "call it a *status code* instead of a *response code* or *error code*, and
  put the number and the name in code font" — "an HTTP `400 Bad Request` status code". Ranges
  use `2xx` form, or `200`-`299`.
- **Grammatical treatment of code elements** (highest-value rule for generated reference):
  "don't use code elements such as keywords and filenames as if they were English verbs or
  nouns. Don't inflect the name of a code element, such as to make it plural or possessive.
  Instead, include a noun after the name of the code element, and inflect that noun."
  - Recommended: "The `ADDRESS` constant's value is defined in the `settings.h` file." /
    "To add the data, send a `POST` request."
  - Not recommended: "`ADDRESS`'s value is defined in `settings.h`." / "`POST` the data." /
    "Retrieve information by `GET`ting the data." / "`Close`ing the file requires you to have
    `open`ed it first."
  - Also: "Takes an array of extended ASCII code points (an array of `INT64` values) and returns
    `BYTES` values." beats "Takes an array of extended ASCII code points (ARRAY of INT64) and
    returns BYTES."

### Headings and titles (`headings.md`)

- "Use sentence case for headings and titles."
- Task heading ⇒ bare infinitive: "Create an instance", not "Creating an instance".
- Conceptual heading ⇒ noun phrase not starting with `-ing`: "Migration to Google Cloud", not
  "Migrating to Google Cloud". Reference section headings are noun phrases.
- "When possible, avoid using *-ing* verb forms as the first word in any heading or title."
  Reason given: "inconsistently translated... and they increase character count".
- "Use a unique level-1 heading (`h1`) for each page... and only use a level-1 heading once on a
  page."
- "Avoid repeating the exact page title in a heading on the page."
- "**Don't use numbers in headings** to indicate a sequence of sections."
- "**Avoid code items in headings**. If you must mention a code item in a heading, add a
  descriptive noun to the item in code font."
- "**Don't put links in headings**."
- "**Maintain logical order**. Don't skip levels of the heading hierarchy."
- "**Don't use empty headings**. Make sure headings are followed by content."
- Optional sections use the prefix form: "Optional: Customize your alias", not
  "Customize your alias (optional)".
- Group intro: use "the following sections", never "this section"/"these sections".
- Vale enforces: no end period on a heading (`Google.HeadingPunctuation`), sentence case
  (`Google.Headings`), no acronyms in headings (`Microsoft.HeadingAcronyms`).

### Lists (`lists.md`) and tables (`tables.md`)

- **List vs table decision table** (verbatim intent): each item is a single unit ⇒ numbered/
  lettered/bulleted list. Each item is a **pair** of related data ⇒ description list (or
  sometimes a table). Each item is **three or more** pieces of related data — "A set of
  parameters, where each parameter has a name, a data type, and a description" ⇒ **use a table**.
  This is the canonical justification for the parameter table on a reference page.
- "Don't use a list to show only one item."
- "Introduce a list with a complete sentence, not a partial one that's completed by the list
  items." Recommended "Use the **Submit** button for any of the following purposes:" — not
  "Use the **Submit** button to:".
- Colon vs period: colon "if it immediately precedes the list", period "if there's more material
  ... between the introduction and the list".
- "Use the same syntax/structure for all list items in a given list, if possible." (parallelism)
- Capitalization/punctuation: start each item with a capital; end each with a period **except**
  when "the item consists of a single word", "the item doesn't include a verb", "the item is
  entirely in code font", or "the item is entirely link text or a document title".
- Run-in headings (`**Term**: description`): "Start the run-in heading with a capital letter.";
  end it with a period or a colon, consistently; text after a colon starts lowercase, after a
  period starts capitalized; "Don't use a dash to set off a description from an item in a
  description list."
- "Avoid ending a list with *etc.* or phrases like *and so on*. Instead, introduce the list in a
  way that makes it clear that the list isn't all-inclusive."
- Tables: "Introduce tables with a complete sentence that describes the purpose of the table
  because not all screen readers preannounce tables."
- "If you have only one column in your table, turn the table into a list."
- "Don't use tables to lay out code snippets." "Don't merge cells. Don't use `colspan` or
  `rowspan` attributes."
- "Sort rows in a logical order, or alphabetically if there is no logical order."
- Column heads: sentence case; concise; "Don't end with punctuation, including a period, an
  ellipsis, or a colon."
- Captions: form "**Table NUMBER.** DESCRIPTION", sentence case, no trailing period; only needed
  when a document has several tables in proximity.
- "try to refer to the table's position, using a phrase like *the following table* or *the
  preceding table*." Never *above*/*below*.

### Cross-references (`cross-references.md`)

- "Be selective about which links you include on a page. Each link creates a decision for the
  reader, adding cognitive load."
- "When possible, provide help in context rather than linking elsewhere" — define a term, briefly
  explain a concept, give a couple of steps, on the page.
- "within a given page, don't provide duplicate links to the same destination."
- Link text = the exact page title, or a descriptive phrase. "Place important words at the
  beginning of the link text." "Don't use the same link text in the same document for different
  target pages." "Keep link text short."
- "Write link text that makes sense without the surrounding text. Don't use phrases such as
  *this document*, *this article*, or *click here*."
- "In general, don't use a URL as link text."
- Standard link sentence: "For more information, see..." or "For more information about..., see...".
  "Don't use *on* instead of *about*." "Use *see* to refer to links and cross-references."
- Commands: put the descriptive noun inside the link text — "run the `gcloud instances create`
  command with the [`--hostname` flag](...)", not "[`--hostname`](...) flag".
  Also: "This service supports the `GET`, `HEAD`, and `OPTIONS` methods." beats repeating
  "method" after each.
- "Don't force links to open in a new tab or window."

### Voice, person, tense, tone

- Active voice: "make clear who's performing the action." Recommended "Send a query to the
  service. The server sends an acknowledgment."; not "The service is queried, and an
  acknowledgment is sent." Sanctioned passive exceptions: emphasize object over action; de-
  emphasize the actor; reader doesn't need to know who acted.
- Present tense: "Use present tense for statements that describe general behavior that's not
  associated with a particular time." "Don't use future tense to describe how a product or
  feature will work after the next release." "avoid the hypothetical future *would*."
- Second person: "use *you* or *your* instead of *we*, *our*, or *us*." "Use the word *user*
  only to refer to the user of the software that your reader is developing."
- Key split for reference specifically: "use the second person to address what the reader does,
  but use the third person for what the software or an end user does... in API documentation,
  you can use the third person when you state facts about programming elements, but address the
  reader as *you* when you tell them what to do with them."
- Tone, the avoid list, verbatim items relevant here: "Placeholder phrases like *please note*
  and *at this time*"; "Choppy or long-winded sentences"; "Starting all sentences with the same
  phrase (such as *You can* or *To do*)"; "Exclamation marks"; "Phrasing in terms of *let's* do
  something"; "Using phrases like *simply*, *It's that simple*, *It's easy*, or *quickly*";
  internet abbreviations such as *tl;dr* or *ymmv*.
- "using *please* in a set of instructions is overdoing the politeness."

### Text formatting (`text-formatting.md`)

- Bold: "only for UI elements and run-in headings, including at the beginning of notices."
  Prefer `**` over `__` in Markdown.
- Italic: "use italics sparingly"; for terms being defined and words-as-words; prefer `_` over
  `*` in Markdown. Italicize version variables — "version 1.4._x_".
- Underline: "Reserve underlining for link text."
- Code font for code in text; code blocks for samples. "Do not override or modify font styles
  inline."
- All-capitals for placeholders. Sentence case in all headings, titles and navigation.
- "Don't use ampersands (&) as conjunctions or shorthand for *and*."

### Procedures (`procedures.md`) — applies to CLI verb pages with steps

- "Make sure that the first sentence in a procedural step includes an imperative verb."
- "State the location of the action before stating the action." "State the purpose or goal of the
  action before stating the action."
- Optional step form: "Optional:" as the first word, not "(Optional)".
- "Don't use directional language to orient the reader, such as *above*, *below*, or *right-hand
  side*."
- "Avoid using *run the following command* to introduce code. Instead, focus on what the command
  does." Recommended "In Cloud Shell, deploy the load generator:", not "...by running the
  following command:".
- Order of components inside one step: 1. describe the action, 2. the command, 3. explain the
  placeholders, 4. explain the command, 5. the output, 6. the result — in that order.
- "When there's more than one way to do something, give only the best way."
- Single-step procedure ⇒ a bulleted item, not a numbered list of one.

### Accessibility (`accessibility.md`)

- "Use shorter sentences. Try to use fewer than 26 words per sentence."
- "Define acronyms and abbreviations on first usage and if they're used infrequently."
- "Place distinguishing and important information of a paragraph in the first sentence."
- "Avoid the use of double negatives and exceptions for exceptions." Recommended "You can
  continue without a path."; not "A missing path won't prevent you from continuing."
- "Avoid when possible camel case and all caps. Some screen readers read capitalized letters
  individually."
- "Don't use images of text, code samples, or terminal output. Use actual text."
- "Don't force line breaks (hard returns) within sentences and paragraphs."
- "avoid when possible the use of exclamation marks, question marks, and semicolons."

### Global audience (`translation.md`)

- "Don't use words like *utilize* or *leverage* when you mean *use*." "don't use a phrase like
  *a number of* when you can use *some* or *many*."
- "Avoid phrasal verbs when possible." Recommended "This document uses the following terms:";
  not "This document makes use of the following terms:". Exceptions: *set up*, *log in*,
  *sign in*.
- "don't use more than two nouns as modifiers of another noun."
- "place a word like *only* immediately before the word or phrase that it relates to."
  Recommended "Request only one token."; not "Only request one token."
- "Avoid participles and gerunds (that is, *verbing*)." "You must configure the VPC firewall
  rules before you deploy the VM instance." beats "Configuring the VPC firewall rules is
  required before deploying the VM instance."
- "Don't use the same word to mean different things. In particular, avoid using the same word as
  both a noun and a verb in close proximity." Named offenders: *once*, *while*, *as*, *since*.
- "Use qualifying nouns for technical keywords... call it the *`example.yaml` file* and not
  *`example.yaml`* by itself."
- "Use helper words. Helper words such as *then*, *that*, and *of* are frequently left out of
  conversational English. Use these words to avoid ambiguity." — "If the attribute key is not
  found, then the default value is returned."
- "Don't omit relative pronouns... use relative pronouns such as *that* and *which*." — "the
  rules that you previously defined", not "the rules you previously defined".
- "If you use a particular term for a concept in one place, then use that exact same term
  elsewhere, including the same capitalization."
- "Use standard English word order. Sentences follow the *subject + verb + object* order."
- "Use the conditional clause first." (Conditions before instructions.)
- "Avoid colloquialisms, idioms, or slang." "Avoid humor."

### Inclusive language (`inclusive-documentation.md`)

- Replace: *sanity-check* ⇒ "final check"; *crazy* ⇒ "baffling"; *cripples* ⇒ "slows down";
  *dummy variable* ⇒ "placeholder"; *hangs* ⇒ "doesn't respond"; *hit* ⇒ "click"; *hover over*
  ⇒ "point to"; *man-hours* ⇒ "person-hours"; *mankind* ⇒ "humanity".
- Established non-inclusive terms (*whitelist*, *master*): name the old term once in parentheses
  on first use, then use the inclusive term throughout.
- Code keywords you cannot rename: "Don't use a non-inclusive name or keyword unless it's in
  code font." Refer to it once in code font and in parentheses — "create a parent node (which is
  named `master` in the file)" — then use the preferred term.

---

## Google Technical Writing One and Two

Source: `google-technical-writing-courses/one-00..one-12`, `two-00..two-06` (CC BY 4.0).
Three claims in the common folklore are **not** in this curriculum, and should not be cited to it:
there is no "by zombies" passive-voice test (the test is `form of be + past participle`, with a
trailing preposition as the actor clue); terms are introduced in **boldface**, not italics; and
there is **no recommended maximum sentence length in words** here. The only numeric guidance is
paragraph length and table-cell length.

**Terminology**

- "If the term already exists, link to a good existing explanation. (Don't reinvent the wheel.)"
  Otherwise define it. "If your document is introducing many terms, collect the definitions into
  a glossary." ⇒ a reference set gets one glossary, not per-page redefinitions.
- "if you rename a term in the middle of a document, your ideas won't compile (in your users'
  heads)." "apply the same unambiguous word or term consistently throughout your document. Once
  you've named a component **thingy**, don't rename it **thingamabob**."
- Never two words for one thing: "When I encounter two words that seem to be synonyms, I wonder
  if the author is trying to signal a subtle distinction that I need to track down and
  understand." (Fairbanks)
- Short forms: introduce the long name once with the short form in parentheses — "**Protocol
  Buffers** (or **protobufs** for short)" — then use the short form throughout.
- Acronyms: "On the initial use of an unfamiliar acronym within a document or a section, spell out
  the full term, and then put the acronym in parentheses. Put both … in boldface." "Do not cycle
  back-and-forth between the acronym and the expanded version in the same document."
- Acronym gate (both conditions required): "The acronym is significantly shorter than the full
  term" AND "The acronym appears many times in the document." "Don't define acronyms that would
  only be used a few times." Reference pages are short, so most acronyms fail this — spell out.
- Acronyms cost the reader: "readers must mentally expand recently learned acronyms," so an
  acronym "actually takes a little longer to process than the full term."
- Pronouns: "Using pronouns improperly causes the cognitive equivalent of a null pointer error in
  your readers' heads." "Only use a pronoun _after_ you've introduced the noun." Testable
  distance rule: "if more than five words separate your noun from your pronoun, consider
  repeating the noun instead of using the pronoun." And: "If you introduce a second noun between
  your noun and your pronoun, reuse your noun." Fix for *this*/*that*: "Replace **this** or
  **that** with the appropriate noun" or "Place a noun immediately after **this** or **that**."
  ⇒ in a parameter description, repeat the parameter name rather than writing *it*.

**Active voice**

- The formulas: "Active Voice Sentence = actor + verb + target"; "Passive Voice Sentence = target
  + verb + actor".
- Detector: "passive verb = form of be + past participle verb". Second clue: "If the phrase
  contains an actor, a preposition ordinarily follows the passive verb."
- "Sentences that start with an imperative verb are typically in active voice… The implied actor
  is **you**."
- "Good sentences in technical documentation identify who is doing what to whom."
- "The vast majority of sentences in technical writing should be in active voice." But: "Use the
  passive voice sparingly" — not zero.
- Reference-page pattern: name the API surface as the actor — "The Op registration process
  generates a wrapper."
- "Place conditions before instructions, not after." "Format code-related text as code font."
  "Write in the second person. Refer to your audience as 'you', not 'we'."

**Words and verbs**

- "choose precise, strong, specific verbs. Reduce imprecise, weak, or generic verbs" — forms of
  *be*, *occur*, *happen*.
- Weak→strong table, verbatim:

  | Weak Verb | Strong Verb |
  |---|---|
  | The exception **occurs** when dividing by zero. | Dividing by zero **raises** the exception. |
  | This error message **happens** when... | The system **generates** this error message when... |
  | We **are** very careful to ensure... | We carefully **ensure**... |

- "generic verbs often signal other problems, such as: An imprecise or missing actor in a
  sentence [or] A passive voice sentence." But "a form of _be_ is sometimes the best choice."
- "Reduce there is / there are" — they "marry a generic noun to a generic verb." The canonical
  parameter-description repair: "There is a variable called `met_trick` that stores the current
  accuracy." ⇒ "The `met_trick` variable stores the current accuracy."
- "adjectives and adverbs tend to be too loosely defined and subjective for technical readers,"
  and "can make technical documentation sound dangerously like marketing material." The fix is
  numbers: "Refactor amorphous adverbs and adjectives into objective numerical information" —
  "screamingly fast" ⇒ "225-250% faster."
- "Don't confuse educating your readers (technical writing) with publicizing or selling a
  product (marketing writing)."
- "prefer simple words over complex words." "Keep your writing culturally neutral." Idioms are
  "another form of the curse of knowledge."

**Short sentences**

- "Shorter documentation reads faster"; "easier to maintain"; "Extra lines of documentation
  introduce additional points of failure."
- "Focus each sentence on a single idea, thought, or concept. Just as statements in a program
  execute a single task, sentences should execute a single idea."
- Two list triggers: "When you see the conjunction **or** in a long sentence, consider
  refactoring that sentence into a bulleted list." "When you see an embedded list of items or
  tasks within a long sentence, consider refactoring that sentence into a bulleted or numbered
  list."
- "Many sentences contain filler—textual junk food that consumes space without nourishing the
  reader."
- The published wordy→concise table has exactly three rows:

  | Wordy | Concise |
  |---|---|
  | at this point in time | now |
  | determine the location of | find |
  | is able to | can |

  Additional reductions demonstrated in the worked exercises: "causes the triggering of" ⇒
  *triggers*; "provides a detailed description of" ⇒ *describes*; "In spite of the fact that" ⇒
  *Although*; "enhances the clarification of" ⇒ *clarifies*; "causes the production of" ⇒
  *produces*.
- Subordinate clauses: ask whether a clause "*extend*[s] the single idea or … *branch[es] off*
  into a separate idea"; split if the latter.
- *That* vs *which*: "reserve **which** for nonessential subordinate clauses, and use **that**
  for an essential subordinate clause that the sentence can't live without." Audible test: a
  heard pause ⇒ *which*. Mechanical, lintable rule: "Place a comma before **which**; do not
  place a comma before **that**."

**Lists and tables**

- "when writing, seek opportunities to convert prose into lists."
- "Use a **bulleted list** for _unordered_ items; use a **numbered list** for _ordered_ items."
  Test: "If you rearrange the items in a _bulleted_ list, the list's meaning does not change."
- "Generally speaking, embedded lists are a poor way to present technical information. Try to
  transform embedded lists into either bulleted lists or numbered lists."
- Parallelism has four checkable axes: "Grammar / Logical category / Capitalization /
  Punctuation." "The first item in a list establishes a pattern that readers expect to see
  repeated in subsequent items." ⇒ the first flag or parameter description sets the shape for
  all the others. Mixed voice also breaks parallelism.
- "Consider starting all items in a numbered list with an imperative verb."
- "If a list item is a sentence, use appropriate sentence-ending punctuation." Fragments take no
  period; be consistent within a list.
- Tables: "Label each column with a meaningful header. Don't make readers guess what each column
  holds." Hard ceiling: "Avoid putting too much text into a table cell. If a table cell holds
  more than two sentences, ask yourself whether that information belongs in some other format."
- "strive for parallelism _within_ individual columns" — a Default column holds defaults only.
- Rendering warning: "a table that looks great on your laptop may look awful on your phone."
- Lead-in: "introduce each list and table with a sentence that tells readers what the list or
  table represents… Terminate the introductory sentence with a colon rather than a period."
  "we recommend putting the word **following** into the introductory sentence."
- "You should almost always use commas, not semicolons, to separate items in an embedded list."
- Serial comma: "technical writing requires picking the least ambiguous solution."
- Parentheses: "keep parentheses to a minimum in technical writing." En dashes: "Don't use."

**Paragraphs**

- "The opening sentence is the most important sentence of any paragraph. Busy readers focus on
  opening sentences and sometimes skip over subsequent sentences." "Good opening sentences
  establish the paragraph's central point." ⇒ a reference entry's first sentence is about the
  item being documented, never its neighbor.
- "A paragraph should represent an independent unit of logic. Restrict each paragraph to the
  current topic." "Don't describe what will happen in a future topic or what happened in a past
  topic." "ruthlessly delete (or move to another paragraph) any sentence that doesn't directly
  relate to the current topic."
- The only numeric guidance in the curriculum: "Readers generally welcome paragraphs containing
  three to five sentences, but will avoid paragraphs containing more than about seven sentences."
  One-sentence paragraphs are also a defect: "If your document contains plenty of one-sentence
  paragraphs, your organization is faulty."
- The three questions a paragraph answers: "**What** are you trying to tell your reader?"; "**Why**
  is it important for the reader to know this?"; "**How** should the reader use this knowledge?"
  The worked example is a function-reference paragraph — what it returns, why to care, when to
  call it, how to read the value. That is the target shape for an API description block.

**Audience**

- "good documentation = knowledge and skills your audience needs to do a task − your audience's
  current knowledge and skills."
- Roles are "an essential first-order approximation", but "you must also consider your audience's
  _proximity_ to the knowledge", which decays with time and project distance.
- "Write down a list of everything your target audience needs to learn to accomplish goals",
  phrased as tasks.
- Curse of knowledge: "their expert understanding of a topic ruins their explanations to
  newcomers." "From the novice's point of view, the curse of knowledge is a 'File not found'
  linker error due to a module not yet compiled."
- "As your target audience widens, assume that you must explain more." Generated reference pages
  have the widest audience in a doc set, so team abbreviations must not appear in them.

**Documents and large documents**

- "A good document begins by defining its scope." "A better document additionally defines its
  non-scope—the topics not covered that the target audience might reasonably expect your document
  to cover", limited to "information that users would reasonably expect the document to cover."
- Scope is a working test: "if the contents of your document veer away from the scope statement …
  then you must either refocus your document or modify your scope statement." "When reviewing
  your first draft, delete any sections that don't help satisfy the scope statement."
- "A good document explicitly specifies its audience," including prerequisite knowledge.
- Front-load: "ensure that the start of your document answers your readers' essential questions."
- Reference pages are explicitly endorsed as long and as scan targets: "In-depth tutorials, best
  practice guides, and command-line reference pages can work well as lengthier documents." "users
  typically scan through a reference page to search for an explanation of a command or flag."
  Conversely, "How-to guides, introductory overviews, and conceptual guides often work better as
  shorter documents."
- Introduction states three things: "What the document covers. / What prior knowledge you expect
  readers to have. / What the document doesn't cover."
- Navigation checklist: "introduction and summary sections / a clear, logical development of the
  subject / headings and subheadings … / a table of contents menu that shows users where they
  are / links to related resources … / links to what to learn next."
- Headings: "Choose a heading that describes the task your reader is working on. Avoid headings
  that rely on unfamiliar terminology or tools." Sibling headings must be parallel in form.
- "Avoid placing a level three heading immediately after a level two heading." (no stacked
  headings — same as Google's style-guide "no empty headings" rule)
- Progressive disclosure: introduce terminology "near the instructions that rely on them"; "Break
  up large walls of text" with tables, diagrams, lists and headings; "Start with simple examples
  … and add progressively more interesting and complicated techniques."

**Editing (two-01) — the five-step checklist**

1. "Adopt a style guide" — an existing one, or "the highlights are all you need" for a small
   project.
2. "Think like your audience" — "Make sure the purpose of your document is clear, and provide
   definitions for any terms or concepts that might be unfamiliar." Caveat: "relying too heavily
   on a persona (or two) can result in a document that is too narrowly focused."
3. "Read it out loud" — "Listen for awkward phrasing, too-long sentences, or anything else that
   doesn't feel natural." A screen reader is an accepted substitute.
4. "Come back to it later" — set the draft aside and reread "with fresh eyes". Also "Change the
   context": print it, or change font, size and color.
5. "Find a peer editor" — "Your peer editor doesn't need to be a subject matter expert … but they
   do need to be familiar with the style guide you follow."

The unit's own answer key doubles as a compact reference-page checklist: "Use active voice
instead of passive voice. / Consider using simpler words that mean the same thing. / Include
links to background information. / Break long sentences into shorter sentences or lists."

**Sample code (two-04)**

- "Good sample code is often the best documentation." Target: "Good samples are **correct** and
  **concise** code that your readers can **quickly understand** and **easily reuse** with
  **minimal side effects**."
- Correctness, all four criteria: "Build without errors. / Perform the task it claims to perform.
  / Be as production-ready as possible… / Follow language-specific conventions."
- "Always test your sample code… Be prepared to test and maintain sample code as you would any
  other code."
- Samples are normative: "sample code should set the best way to use your product."
- Don't reuse tests: "The primary goal of a unit test is to test; the only goal of a sample
  program is to educate."
- Snippet warning, aimed straight at generated reference pages: "Snippet-heavy documentation
  often degrades over time because teams tend not to test snippets as rigorously as full sample
  programs."
- "Good documents explain how to run sample code" — libraries to install, env vars, IDE settings.
- "Writers should consider describing the expected output or result of sample code."
- "Sample code should be short, including only essential components… never use bad practices to
  shorten your code; always prefer correctness over conciseness." "Irrelevant code can distract
  and confuse your audience."
- Understandability: "Pick descriptive class, method, and variable names. / Avoid confusing your
  readers with hard-to-decipher programming tricks. / Avoid deeply nested code."
- "use highlighting judiciously—too much highlighting means the reader won't focus on anything."
- **Don't make readers guess** — spell out named parameters: `go.so.Level(rank=5, dimension=28,
  opacity=48)`; "omitting parameter names makes it harder for novices to learn."
- Comments: "Keep comments short, but always prefer clarity over brevity"; "Avoid writing comments
  about _obvious_ code"; for expert audiences "don't explain _what_ the code is doing, explain
  _why_."
- The placement rule that decides comment vs prose: "readers who copy-and-paste a snippet gather
  not only the code but also any embedded comments. So, put any descriptions that belong in the
  pasted code into the code comments." Long or tricky concepts go **before** the sample.
- If brevity costs production-readiness, "explain your decisions in the comments."
- Anti-examples earn their place when a rule is surprising: show "A valid string assignment"
  beside "An invalid string assignment," each labeled in a comment.
- "A good sample code set demonstrates **a range of complexity**… Resist the temptation to _rush_
  towards very complex sample programs."

**Illustrations (two-03)**

- "providing any graphics—good or bad—makes readers like the document more; however, only
  _instructive_ graphics help readers learn."
- "It is often helpful to write the caption _before_ creating the illustration."
- Captions "are **brief**… explain the **takeaway**… **focus** the reader's attention." "By
  convention, the caption always follows the diagram."
- One idea per illustration: "don't put more than one paragraph's worth of information in a single
  diagram"; "avoid illustrations that require more than five bulleted items to explain."
- Accessibility is a graded defect: insufficient contrast "makes the diagram inaccessible for some
  people with low vision or certain types of color blindness."
- "it is usually best to export the files as Scalable Vector Graphics (SVG)."
- No alt-text rule lives in this unit; alt text is in the separate accessibility course.

**LLM lesson (two-05)**

- The unit is about *using* an LLM to write docs, not about writing docs for machines. It contains
  **no** guidance on prompt-ready docs, RAG chunking, or structuring for retrieval — do not cite
  it for that.
- The transferable claim: "In general, writing good prompts requires following good technical
  writing principles."
- The LLM knows only its pre-training plus what you pass it — "an LLM doesn't know about the
  Python function that you wrote this morning unless you pass that source code within a prompt."
  ⇒ a generated reference page must carry its source of truth, not assume it.
- Grounding pattern: "Only use information from the following text in your response." Source-driven
  generation: "Base the documentation on the attached source code." Caveat: "An LLM might
  mistakenly assume that the bugs in attached source code are actually features."
- "Responses sometimes contain errors. Always check responses carefully."
- Usable as CI-ish checks on generated pages: "Identify any passive voice in the following
  passage"; "Replace any passive voice sentences … with their active voice equivalents"; "How does
  the attached document deviate from the writing principles in Google's Technical Writing One
  course?"
- "We recommend fixing organizational issues before editing grammar and style issues."
- "LLM responses tend to be too long. Consider telling the LLM to abbreviate a response." The
  default LLM shape (bullets plus short paragraphs) "is usually an appropriate style for technical
  writing" — and is also the reference-page shape.
- The honest counterpoint: "When you rely on an LLM to create a first draft, you lose the
  _benefits_ of the writing process… Clear technical writing is the byproduct of clear technical
  thought."

---

## Google developer style guide word list (A-Z, 3,433 lines)

Source: `google-developer-documentation-style-guide/word-list.md`. Only the entries that bear on
generated reference pages are kept. Quotes verbatim.

**Filler and puffery — delete or replace**

- *please*: "Don't use *please* in the normal course of explaining how to use a product." Also
  "Don't use the phrase *please note*."
- *simple / simply*: "What might be simple for you might not be simple for others." Try deleting.
- *easy / easily*, *quick / quickly*: "Try eliminating this word from the sentence."
- *just*: "Usually, *just* is a filler word that you can delete without affecting your meaning."
- *leverage*: "Avoid using if you mean *use*." *utilize / utilization*: "Don't use *utilize* when
  you mean *use*" (OK only for resource-quantity senses: CPU utilization).
- *in order to*: "Avoid *in order to*; instead, use *to*."
- *actionable* ⇒ "that you can act on" or "useful". *functionality* ⇒ *capabilities*/*features*.
  *performant* ⇒ "a more precise term". *traditional*, *best effort* ⇒ more precise wording.
  *single pane of glass* ⇒ "single interface" or "unified interface".

**Latin, abbreviations, connectives**

- *e.g.* "Don't use. Instead, use phrases like *for example* or *such as*." *i.e.* "Don't use.
  Instead, use phrases like *that is*."
- *etc.*, *and so forth*, *and so on*: "Avoid … wherever possible."
- *via*: "Don't use." *vs.*: "Don't use *vs.* as an abbreviation for *versus*." *aka*: write out
  "also known as". *vice versa*: "Don't use. Write out the relationship explicitly."
- *and/or*: "Don't use unless space is limited, such as in a table."
- *&*: "Don't use *&* instead of *and* in headings, text, navigation, or tables of contents."
- *tl;dr*, *RTFM*, *ymmv*, *voila*: "Don't use."
- *for instance*: avoid "to avoid confusion with the noun *instance*."

**Modals and tense — the core set for reference prose**

- *can* = permission, ability, an optional action, or "a possible outcome".
- *might* = "possibility or an uncertain outcome". *may* = "reserve for official policy or legal
  considerations"; possibility ⇒ *can*/*might*, permission ⇒ *can*.
- *must* = "a required action or state".
- *should / should be*: "Generally avoid… *should* is ambiguous by definition."
- *could*, *would*: "Instead, use *can* where possible." *shall*: "Avoid … except under advice
  from a lawyer." *will*: "Avoid. Applies equally to its past tense, *would*."
- *possible / impossible*: "Don't use *possible* or *impossible* to mean *you can* or *you can't*."

**Time-bound words — all break a timeless reference page**

- *currently*, *presently*, *at present*, *as of this writing*, *now*: all avoid, "because this
  word is implied" — "Windows isn't supported", not "isn't currently supported".
- *soon*, *eventually*, *future / in the future*: can become outdated and may "prematurely
  disclose product or feature strategy". *does not yet*: avoid.
- *latest*: if used, "give the reader a reference point—for example, a version number or release
  date". *new / newer* ⇒ *later*. *old / older* ⇒ *earlier*.

**Positional and version words**

- Version ranges use *earlier* / *later*, never *above*, *below*, *higher*, *lower*, *under*, or
  `2.2+`. "Use version 2.2 or later."
- Document position uses *preceding* / *following*, never *above* / *below*.
- *left-nav*, *right-nav*, *scroll up*: "Don't use directional language."

**Person and address**

- *we / our / us*: "Don't use *we* … to address the reader." *let's*: "Don't use if at all
  possible."
- *you*: "Use *you* instead of *user* to address the reader." *user*: "Use the word *user* only to
  refer to the user of the software that your reader is developing."
- *he / she / his / hers*, *he/she*, *(s)he*: don't use; use singular *they*. *guys* ⇒ *everyone*.
- *man hours / manmade / manned / manpower* ⇒ *person hours / artificial / staffed / staff*.
- *man-in-the-middle (MITM)* ⇒ *on-path attacker* or *person-in-the-middle (PITM)*.

**Ableist, violent, and non-inclusive terms common in API and CLI prose**

- *abort*, *kill*, *terminate*: "Instead, use words like *stop*, *exit*, *cancel*, or *end*."
  Documented exception: Linux signals, where the literal name is correct.
- *hang / hung* ⇒ "stop responding" / "not responding".
- *disable / disabled*: "Don't use … to describe something that's broken." Use *inactive*,
  *unavailable*, *deactivate*, *turn off*, *deselect*.
- *enable* / *allows you to*: "Don't use. Instead, use *lets you*." — "The API lets you detect
  features in images."
- *master*: "Use with caution. Never use in conjunction with *slave*." ⇒ *primary*, *main*,
  *parent*, *controller*, *leader*. *slave*: "Don't use" ⇒ *worker*, *replica*.
- *blacklist / whitelist / graylist*: "Don't use" ⇒ *denylist*/*blocklist*, *allowlist*/*safelist*,
  *provisional list*. And "Don't use as a verb. Instead, rewrite to improve clarity."
- *sanity check* ⇒ *quick check* / *confidence check*. *sane* ⇒ *valid* / *sensible*.
- *dummy variable*: "Don't use to refer to placeholders. Instead, use *placeholder*."
- *crazy / insane / mad / lunatic* ⇒ *complicated*, *complex*, *baffling*, *unexpected*, "and only
  for inanimate objects".
- *cripple*, *lame*, *blind writes*, *grandfathered* (⇒ *legacy* / *exempt*), *first-class
  citizen*, *native* (⇒ *built-in*), *black-box / white-box* (⇒ *opaque-box* / *clear-box*),
  *health check / healthy* (⇒ non-figurative: "being responsive"), *war room*, *blast radius*,
  *break-glass*, *tribal knowledge*, *guru*, *ninja*: all avoid or replace.

**Verbs and constructions**

- *execute* ⇒ *run*: "When the meaning is the same, use the simpler word *run* instead."
- *type* ⇒ *enter*: "In general, use *enter* instead of *type*."
- *interface*: "OK to use as a noun. Don't use as a verb." Same shape for *email*, *screenshot*,
  *ssh*, *RDP*, *Google* — nouns, not verbs.
- *display*: "Don't use as an intransitive verb" — "The area appears" or "is displayed".
- *persist*: "Don't use as a transitive verb." *surface*: avoid as a transitive verb.
- *comprise*: "Don't use. Instead, use *consist of*, *contain*, or *include*."
- *impact*: "Use only as a noun" — use *affect*. *access* as a verb: prefer *see*, *edit*, *find*,
  *use*, *view*. *ingest* ⇒ *import*, *load*, *copy*. *spin up* ⇒ *create*, *start*.
- *Create a new …*: "Instead, use *Create a …*"

**Connectives that mislead in reference prose**

- *once* ⇒ *after*. *since* ⇒ *because* ("*Since* is ambiguous"). *as* ⇒ *because*. *while* used
  for contrast ⇒ *although*.
- *then*: "you should include helper words like *then* in technical documentation" (`if…then`).
- *this / that*: "Where possible, put a noun after *this* or *that* for clarity."
- *using*: "Where *using* might have more than one interpretation, use *by using* or *that use*."
- *about versus on*: "For more information about indexes", not "on indexes".
- *each* is not a synonym for *all*; *neither A nor B*, not *neither A or B*; *either* takes
  parallel syntax.
- *per*: "Avoid *per* in contexts other than rate units."
- *following*: "in the following code sample", "do the following:".

**UI verbs (for pages that reference a console)**

- *click on* ⇒ *click*; hyphenate *right-click*, *double-click*. *click here*: "Don't use."
- *hit* ⇒ *click* / *press*. *hover* ⇒ "hold the pointer over". *check* a checkbox ⇒ *select*;
  *uncheck / deselect* ⇒ *clear*. *desire / wish* ⇒ *want* / *need*.
- *drop-down*: often omit and just use *list* or *menu*. *pop-up*: "Don't use" ⇒ *dialog* / *menu*.
  *text box* ⇒ *box* (or *field*).

**Technical terms and preferred spellings (reference vocabulary)**

- *API*: "Use *API* to refer to either a web API or a language-specific API. Don't use *API* when
  referring to a method or a class."
- *parameter*: "In our API documentation, *parameter* is usually short for *query parameter*; it's
  a `NAME=VALUE` pair" appended to a URL in a `GET` request.
- *CLI*: "Don't use *CLI* generically to refer to a command-line interface. Instead, refer to the
  specific command-line interface." *sub-command*: "Not *subcommand*."
- *config*: "spell out the full word when it's used in a non-code sense: *configuration*" — except
  when naming a real code item verbatim.
- *boolean*: "use code font and the exact spelling and capitalization of the programming keyword";
  lowercase for the abstract data type; uppercase for *Boolean logic*.
- *data*: singular — "*the data is*"; mass noun — "*less data*, not *fewer data*".
- *data type* (not *datatype*), *data source*, *datastore*, *data center*, *endpoint* (not *end
  point*), *filename* (not *file name*), *file system* (not *filesystem*), *hostname*,
  *namespace*, *codebase*, *backend* / *frontend*, *lifecycle*, *whitespace*, *wildcard*,
  *timestamp*, *checkbox*, *inline*, *hardcode / hardcoded* (no hyphen).
- *path*: "Avoid using *filepath*, *file path*, *pathname*, or *path name* if possible."
- *directory* vs *folder*: "use *directory* in a command-line context, and *folder* in a GUI
  context. When in doubt, default to *directory*."
- *key-value pair*: "Use instead of *key/value pair* or *key value pair*." (Distinct from *key
  pair*.) *key*: "Don't use as an adjective in the sense of *crucial*."
- *ID*: "Not *Id* or *id*, except in string literals or enums."
- *element* vs *tag*: "a tag is a component of an element"; don't call a whole element a tag.
- *method*: "avoid also using the word generically to mean 'approach' or 'manner.'"
- *client*: in REST/RPC docs it means the client app; "Don't use *client* as an abbreviation for
  *client library*; instead, use *library*."
- *limits* / *quota*: prefer *usage limit* or *service limit*.
- *deprecate*: "To *deprecate* an item is to recommend against the item's use"; "Don't use
  *deprecated* to mean *removed*, *deleted*, *shut down*, or *turned down*."
- *regex*: "Don't use. Instead, use *regular expression*." *repo* ⇒ *repository*. *admin* ⇒
  *administrator*. *N/A* spelled out on first reference.
- *runtime* (the environment) vs *run time* (during execution).
- *plugin* (noun) / *plug-in* (adjective) / *plug in* (verb); *setup / set up*; *login / log in*;
  *sign-in / sign in* ("Not *log in*"); *timeout / time out*; *failover / fail over*.
- *sign into* ⇒ *sign in to*. *read-only*: "Always hyphenate."
- *port*: "Use *listen on* (not *to*)."
- *this document*: "use *this document*, and not *this article*, *this topic*, *this doc*, or
  *this page*."
- Plurals: *appendixes*, *indexes*, *matrixes*, *emoji* (both numbers).
- *curl* (not *cURL*), *k8s* ⇒ *Kubernetes*, *authN/authZ* ⇒ *authentication*/*authorization*.
- Placeholder names: *foo / bar / baz* — "use a clearer and more meaningful placeholder name".

**Formatting, capitalization, hyphenation**

- Prefixes close up: *anti-*, *auto-*, *co-*, *meta-*, *multi-*, *non-*, *pre-*, *re-* — e.g.
  *autoscaling*, *prebuilt*, *preemptible*, *subtree*, *ecommerce*, *microservices*. Established
  exceptions: *multi-cluster*, *multi-region*, *multi-tenancy*, *non-key*, *pre-existing*,
  *sub-command*.
- The standard formula "Lowercase except at the beginning of a sentence, heading, or list item"
  applies to *access token*, *client ID*, *client secret*, *base64*, *bare metal*, *big-endian*,
  *error-prone*, *persistent disk*, *internet*, *web*, *egress*/*ingress*.
- Noun vs adjective hyphenation pairs: *high availability* / *high-availability*; *load balancing*
  / *load-balancing*; *time zone* / *time-zone*; *third party* / *third-party*; *clickthrough*
  (noun) / *click through* (verb).
- Always hyphenated: *read-only*, *big-endian*, *little-endian*, *error-prone*, *on-premises*,
  *denial-of-service (DDoS)*, *pre-shared key*, *Unix-like*.
- Capitalization: *Markdown*, *Unicode* (not UNICODE), *HTTPS* (not HTTPs), *NoSQL*, *OAuth 2.0*
  (not OAuth2), *IPsec*, *SHA-1* (not SHA1 "except in string literals/enums"), *UTF-8* with the
  hyphen, *I/O*, *IoT*, *DevOps*.
- Article by pronunciation: "a SQL" (not *an SQL*), "an SAP system", "a FHIR". General rule: "Use
  *a* when the next word starts with a consonant *sound*, regardless of what letter it starts
  with."
- "A dash (`—`) isn't the same character as a hyphen (`-`)… don't use the word *dash* to refer to
  a hyphen."
- Keyboard: "To refer to a Control character, use Control+CHARACTER." Not *Ctl-S*.
- *AM / PM*: "use all caps, no periods, and a space before". *RFC 2318* takes a space. *US*, not
  *U.S.*
- Rates: "use *per* instead of the division slash (/)" — *requests per day*, not *requests/day*.
  Byte-rate units are *GBps* / *Gbps* / *MBps* / *Mbps*, never *GB/s*.
- Code-font escape hatch: literal `master`, `slave`, `whitelist`, `SHA1`, `Id` are correct only
  "in direct reference to the code items (formatted as code)", and the preferred term is used
  thereafter.

**Terms the word list does not cover** (so their rules must come from `code-in-text.md`,
`code-syntax`, or `api-reference-comments.md`, not from here): *argument*, *flag*, *option*,
*switch*, *callback*, *default*, *enum*, *environment variable*, *field*, *function*, *JSON*,
*library/package/module*, *null/empty/zero*, *object*, *property*, *return/returns*, *string*,
*type*, *URL/URI*, *value*, *variable*, *assure/ensure/insure*, *that vs which*, *obsolete*,
*invalid*, *illegal*, and plurals of acronyms.

---

## Vale style rule packages — Google and Microsoft, as a lint checklist

Source: `vale-style-rule-packages/{Google,Microsoft}/*.yml` and its `SOURCE.md`. MIT.
Counts from `SOURCE.md`: Google 36 rules, Microsoft 47, plus write-good 8, proselint 34,
alex 11, Joblint 17, Splunk 66, Elastic 32, Canonical 27 (277 total).
Rule anatomy: `extends` (`existence`, `substitution`, `occurrence`, `conditional`,
`capitalization`), `level` (suggestion / warning / error), `message`, tokens or a swap table.
"The `substitution` files are the most useful as prose: they are literal 'write X, not Y' tables."

### Google package (36 rules) — id, level, what it flags

| Rule | Level | Flags |
|---|---|---|
| `Google.Acronyms` | suggestion | A 3-5 letter all-caps acronym never expanded as `Words (ACRO)`. Large exception list (API, CLI, CPU, CSS, CSV, GET, GUI, HTML, HTTP, JSON, PDF, PATH, ...). |
| `Google.AMPM` | error | Time not written as `AM`/`PM` preceded by a space. |
| `Google.Anthropomorphism` | suggestion | `sees`, `tells` — human qualities attributed to software. |
| `Google.Colons` | warning | A capitalized word right after a colon mid-sentence (Note:/Caution:/Warning:/Success: exempt). |
| `Google.Contractions` | suggestion | Expanded forms; swaps `are not`→`aren't`, `cannot`→`can't`, `do not`→`don't`, `does not`→`doesn't`, `is not`→`isn't`, `it is`→`it's`, `that is`→`that's`, `should not`→`shouldn't`, `how is`→`how's`, `has not`/`have not`/`did not`/`could not`. Google *wants* contractions. |
| `Google.DateFormat` | error | Any date not in `July 31, 2016` form. |
| `Google.Ellipses` | warning | Literal `...` — "In general, don't use an ellipsis." Directly conflicts with elided code; use a comment instead. |
| `Google.EmDash` | error | A space before or after an em/en dash: `\s[—–]\s`. |
| `Google.ExcessiveClaims` | suggestion | `best` (not `best practices`), `simplest`, `fastest`, `guarantee(s)`. |
| `Google.Exclamation` | error | Exclamation points in text. |
| `Google.FirstPerson` | warning | `I`, `I'm`, `me`, `my`, `mine`. |
| `Google.Gender` | error | `he/she`, `s/he`, `(s)he`. |
| `Google.GenderBias` | error | Gendered job nouns: `airman`→`pilot`, `cameraman`→`camera operator`, `freshman`→`first-year student`, `fireman`→`firefighter`, `alumnus`→`graduate`, etc. |
| `Google.HeadingPunctuation` | warning | A trailing period on a heading (scope: heading). |
| `Google.Headings` | warning | Heading not in sentence case (scope: heading), with an exception list (Azure, CLI, Docker, gRPC, JSON, Kubernetes, Linux, macOS, MongoDB, REPL, TypeScript, URLs, VS, Windows...). |
| `Google.Jargon` | suggestion | `break-glass`, `camel case`, `out-of-the-box`, `swim lane`. |
| `Google.Latin` | error | `e.g.`/`eg` ⇒ **for example**; `i.e.`/`ie` ⇒ **that is**. |
| `Google.LyHyphens` | error | `\b[^\s-]+ly-\w+\b` — an `-ly` adverb hyphenated to the next word ("externally-facing"). |
| `Google.OptionalPlurals` | error | `\b\w+\(s\)` — "Don't use plurals in parentheses". |
| `Google.Ordinal` | error | `1st`, `2nd`, `3rd` — "Spell out all ordinal numbers in text." |
| `Google.OxfordComma` | warning | A three-item series missing the serial comma. |
| `Google.Parens` | suggestion | Any parenthetical that isn't a bare 3-5 letter acronym. |
| `Google.Passive` | suggestion | `be/am/is/are/was/were/been/being` + a past participle (a long irregular list plus `\w+ed`). "In general, use active voice instead of passive voice." |
| `Google.Periods` | error | Periods inside acronyms: `\b(?:[A-Z]\.){3,}`. |
| `Google.Quotes` | error | A comma or period placed **outside** a closing quotation mark. |
| `Google.Ranges` | warning | `from 5-10`, `between 5-10` — don't add *from*/*between* to a numeric range. |
| `Google.Semicolons` | suggestion | Any `;` in a sentence — "Use semicolons judiciously." |
| `Google.Slang` | error | `tl;dr`, `ymmv`, `rtfm`, `imo`, `fwiw`. |
| `Google.Spacing` | error | Double spaces. |
| `Google.Spelling` | warning | British spellings: `-nise(d)`, `colour`, `labour`, `centre`. |
| `Google.Timeless` | suggestion | `currently`, `latest`, `soon` — time-anchored words in product docs. |
| `Google.Units` | error | Missing space between number and unit: `10GB`, `500ms`, `30s`. |
| `Google.We` | warning | `we`, `we've`, `we're`, `our`, `ours`, `us`, `let's`. |
| `Google.Will` | warning | The word `will` — future tense. |
| `Google.WordList` | warning | Product/term swaps: `CLI`⇒`command-line tool`, `url`⇒`URL`, `HTTPs`⇒`HTTPS`, `k8s`⇒`Kubernetes`, `Ajax`⇒`AJAX`, `android`⇒`Android`, `World Wide Web`⇒`web`, `authN`⇒`authentication`, `authZ`⇒`authorization`, `SHA1`⇒`SHA-1`. |
| `Google.WordListCase` | warning | Casing variants of the same product terms. |

### Microsoft package (47 rules) — the ones that matter for reference pages

| Rule | Level | Flags |
|---|---|---|
| `Microsoft.Accessibility` | suggestion | Disability-first language: `disabled`, `handicapped`, `crippled`, `dumb`, `lame`, `normal person`, `hearing-impaired`, `a victim of`, ... |
| `Microsoft.Acronyms` | suggestion | An acronym with "no definition". |
| `Microsoft.Adverbs` | warning | ~250 `-ly` adverbs ("Remove '%s' if it's not important to the meaning"). Action = remove. |
| `Microsoft.Avoid` | error | `and so on`, `backend`, `backbone`, `application file`, `contiguous selection`, `outdent`, ... |
| `Microsoft.Auto` | error | Hyphenated `auto-*` — write `autoscale`, not `auto-scale`. |
| `Microsoft.BiasFree` | warning | `master/slave`⇒`master/subordinate`, `sanity check`⇒`quick check`, `DMZ`⇒`perimeter network`, `hangs`⇒`stops responding`. |
| `Microsoft.Contractions` | error | Same swaps as Google's, plus `they are`→`they're`; and the reverse at end of sentence. |
| `Microsoft.Dashes` | error | Spaces around a dash. |
| `Microsoft.Ellipses` | warning | `...`. |
| `Microsoft.FirstPerson` / `Microsoft.We` | warning | First person singular / plural. |
| `Microsoft.Foreign` | error | Non-English phrases (`e.g.`, `i.e.`, `etc.` family). |
| `Microsoft.Gender` / `GenderBias` | error | Gendered pronouns and job nouns. |
| `Microsoft.GeneralURL` | warning | `URL` for a general audience — prefer `address`. Not applicable to developer reference; suppress it. |
| `Microsoft.HeadingAcronyms` | warning | `[A-Z]{2,4}` inside a heading. Frequently a false positive on API reference headings (`GET`, `JSON`); suppress or extend exceptions. |
| `Microsoft.HeadingColons` | error | Lowercase word after a colon in a heading. |
| `Microsoft.HeadingPunctuation` | warning | End punctuation in headings. |
| `Microsoft.Headings` | suggestion | Sentence-style capitalization for headings. |
| `Microsoft.Hyphens` | warning | `-ly` adverb hyphenated to the next word. |
| `Microsoft.Jargon` | suggestion | `bucketize`⇒`group`, `glyph`⇒`symbol`, `leverage`⇒`take advantage of`. |
| `Microsoft.Militaristic` | suggestion | `attacker`⇒`cyberattacker`, `blast radius`⇒`impact`, `locked down`⇒`secured`, `adversary`⇒`threat actor`. |
| `Microsoft.Negative` | error | A hyphen used for a negative number instead of an en dash. |
| `Microsoft.Ordinal` | error | `-ly` on an ordinal (`firstly`). |
| `Microsoft.OxfordComma` | suggestion | Missing serial comma. |
| `Microsoft.Passive` | suggestion | Same regex family as `Google.Passive`. |
| `Microsoft.Percentages` | error | A spelled-out number with `percent` instead of a numeral plus units. |
| `Microsoft.Plurals` | error | `(s)` or `(es)` appended to a singular noun. |
| `Microsoft.QuestionMarks` | suggestion | Any `?` — "Use questions sparingly." Kills FAQ-style reference headings. |
| `Microsoft.RangeTime` | error | A dash in a time range; use `to`. |
| `Microsoft.Semicolon` | suggestion | Any `;` — "Try to simplify this sentence." |
| `Microsoft.SentenceLength` | suggestion | `occurrence`, max 30 words per sentence: "Try to keep sentences short (< 30 words)." The single most useful numeric gate. |
| `Microsoft.Spacing` | error | Double spaces. |
| `Microsoft.Suspended` | warning | Suspended hyphens: `\w+- and \w+-` ("read- and write-access"). |
| `Microsoft.Terms` | warning | ~100 term swaps, incl. `pathname`⇒`path`, `spec`⇒`specification`, `end user`⇒`user`, `home directory`⇒`root directory`, `keypress`⇒`keystroke`, `read-write`⇒`read/write`, `different to`⇒`different from`, `a URL`⇒`an URL`(sic: article rules), `gb`⇒`GB`, `kb`⇒`KB`, `zeroes`⇒`zeros`, `it is recommended`⇒`we recommend`. |
| `Microsoft.UIVerbs` | warning | `click`, `click on`, `swipe` — use `select`. |
| `Microsoft.Units` | error | A spelled-out number before a unit. |
| `Microsoft.Uppercase` | suggestion | Two or more consecutive ALL-CAPS words used for emphasis. **Fires on placeholder runs** like `PROJECT_ID REGION` outside code font — a reason to keep placeholders in code font. |
| `Microsoft.Vocab` | suggestion | Words needing an A-Z check: `above`, `allow(s)`, `and/or`, `as well as`, `assure`, `ensure`, `insure`, `alias`, `alert`, `beta`, `he`, `she`, `sample`, `specify`, `set a/an/the`, `against`, `actionable`, `author`, `avg`. |
| `Microsoft.Wordiness` | suggestion | ~120 phrase swaps. Highest-yield for generated prose: `in order to`⇒`to`, `utilize`/`make use of`⇒`use`, `has the ability to`⇒`can`, `due to the fact that`/`because of the fact that`⇒`because`, `in the event that`⇒`if`, `prior to`/`previous to`⇒`before`, `subsequent to`⇒`after`, `a large number of`⇒`many`, `whether or not`⇒`whether`, `with regard to`⇒`regarding`, `at this point in time`⇒`at this point`, `take into account`⇒`consider`, `not possible`⇒`impossible`, `except when`⇒`unless`, `during the time that`⇒`while`, `in many cases`⇒`often`, `in most cases`⇒`usually`, `an estimated`⇒`about`, `as a result of`⇒`because of`, `pertaining to`⇒`about`, `with the exception of`⇒`except for`, `until such time as`⇒`until`. |

**Conflicts to resolve before adopting both packages on reference pages**

- `Google.Contractions` / `Microsoft.Contractions` *require* contractions; many house styles ban
  them. Pick one and disable the other direction.
- `Google.Ellipses` vs the elided-code convention: Google's own `code-samples.md` already forbids
  `...` in code, so the rule agrees — but it fires on the CLI repetition notation `[FLAG ...]`.
  Scope the rule out of code blocks.
- `Microsoft.Uppercase` vs `UPPER_SNAKE` placeholders: scope out of code spans.
- `Microsoft.HeadingAcronyms` vs API reference headings named after HTTP verbs and formats.
- `Microsoft.GeneralURL` (`URL`⇒`address`) does not apply to developer reference.
- `Google.Will` and `Google.Passive` are `warning`/`suggestion` for a reason: passive is
  sanctioned for "The file is saved." and future is sanctioned for genuinely deferred actions.

---

## Keep a Changelog

Source: `keep-a-changelog/keep-a-changelog-1.1.0.md` and `-2.0.0.md` (MIT). 2.0.0 is current;
1.1.0 is what most projects link to. Relevant here because a generated reference site's release
notes, deprecation notices and `Deprecated`/`Removed` markers on reference pages must agree
with the changelog.

- Guiding principles (2.0.0): "Changelogs are _for humans_, not machines." "Every version should
  have an entry." "Group changes of the same type." "Make versions and sections linkable."
  "List the latest version first." "Show the release date of each version." "Note which
  versioning scheme you use." "Write plainly. Many of your readers are not native speakers, so
  favor clear, concise wording."
- Exactly six types, no more: "`Added` for new features. `Changed` for changes in existing
  functionality. `Deprecated` for soon-to-be removed features. `Removed` for now removed
  features. `Fixed` for bug fixes. `Security` for vulnerabilities."
- Disambiguation: "`Fixed`: the behavior was wrong, and is now correct. `Changed`: the behavior
  worked as intended, and now works differently."
- "There are only six types on purpose." Dependencies are not a type; known issues are not a
  type; `Performance`, `Improved`, `New`, `Internal` are rejected.
- Breaking changes: "Add a short `**Breaking:**` marker so they stand out, and keep them with the
  type of change they are" — e.g. `- **Breaking:** parse() now returns a result object instead of
  raising.` "Say what breaks... a command line, a library API, a network protocol, a file format,
  or a configuration schema. State which one your versioning scheme covers."
- Long migration steps belong elsewhere: "A long procedure buries what changed and turns a
  scannable record into a how-to: a different kind of document" — the Diátaxis boundary, restated.
- Version heading form: `## [1.0.0] - 2017-07-17`, `YYYY-MM-DD`, ISO 8601. Square brackets make
  it a Markdown reference link resolved at the bottom of the file, each version pointing at a
  comparison with the previous one; `[Unreleased]` compares the latest tag to `HEAD`.
- Yanked: `## [0.0.5] - 2014-12-13 [YANKED]`.
- File name: `CHANGELOG.md`. Fixed preamble: "All notable changes to this project will be
  documented in this file." plus the two convention links, with the Keep a Changelog link pinned
  to the version followed.
- Deprecation policy that binds reference pages: "mark it `Deprecated` in one release, and only
  `Removed` in a later one, so anyone upgrading meets the warning before the change. Say which
  version will remove it." (Matches Google's deprecation rule: name the replacement and the
  version.)
- Changelog ≠ release notes: "A changelog is the complete, ongoing record... Release notes are an
  announcement for a single release."
- Against generation: "a raw commit history is not a changelog." "**machines can draft, but humans
  curate**." "A generated changelog is raw material at best."
- The brief to give a model, verbatim: "summarize notable, user-facing changes; do not paste a
  git log; sort each change into one of the six types; explain the reason in the text; mark
  breaking changes; and remove anything not worth reading."
- Do not gate every change on a changelog edit: "That teaches people to add a line to pass the
  check, which fills the changelog with noise."

---

## Standard Readme

Source: `readme-guidance/standard-readme-spec.md` (MIT). A *checkable* spec, so it reads as a
lint target. Relevant to a generated docs site because per-package README and the generated
package reference page share a contract.

- "A compliant README must satisfy all the requirements listed below." Named `README` with the
  format extension; i18n variants as `README.de.md` (BCP 47), `README.md` reserved for English
  when several exist.
- "Sections must appear in order given below. Optional sections may be omitted." "Sections must
  have the titles listed below."
- "Must not contain broken links."
- "If there are code examples, they should be linted in the same way as the code is linted in the
  rest of the project." ⇒ examples on reference pages are code, and get the code toolchain.
- Order: Title → Banner → Badges → Short Description → Long Description → Table of Contents →
  Security → Background → Install → Usage → Extra Sections → **API** → Maintainers → Thanks →
  Contributing → License.
- Required: Title, Short Description, Table of Contents (optional under 100 lines), Install,
  Usage, Contributing, License. License "Must be last section."
- Title: "must match repository, folder and package manager names" or carry them in italics and
  parentheses — `# Standard Readme Style _(standard-readme)_`.
- Short Description: "Must not have its own title. Must be less than 120 characters. Must not
  start with `> `. Must be on its own line. Must match the description in the packager manager's
  `description` field." ⇒ a testable equality between README, `package.json`, and the repo
  description.
- Table of Contents: "Must link to all sections in the file... Must be at least one-depth: must
  capture all level two headings."
- **API section** (the reference contract): "Describe exported functions and objects."
  Suggestions: "Describe signatures, return types, callbacks, and events. Cover types covered
  where not obvious. Describe caveats. If using an external API generator (like go-doc, js-doc,
  or so on), point to an external `API.md` file."
- Usage: "Code block illustrating common usage." "If CLI compatible, code block indicating common
  usage." A `CLI` subsection is "Required if CLI functionality exists."
- Install: "Code block illustrating how to install." `Dependencies` subsection required "if there
  are unusual dependencies or dependencies that must be manually installed."
- License: "State license full name or identifier, as listed on the SPDX license list."
- Long-description guidance quoted from perlmodstyle: "This should describe your module in broad
  terms, generally in just a few paragraphs; more detail of the module's routines or methods,
  lengthy code examples, or other in-depth material should be given in subsequent sections."

---

## Distilled rubric

A shared style prompt for an LLM writing generated reference pages. 22 rules.

1. **Describe; never instruct or explain.** A reference page states what the thing is, what it
   accepts, what it returns, and how it fails. Send the reader to a how-to for procedures and to
   an explanation page for rationale; link, do not digress. (Diátaxis)
2. **Mirror the product's structure.** One page per real unit (module, class, command, config
   key), nested exactly as the code nests. Never invent a grouping the code does not have, and
   never merge two units onto one page to save space. (Diátaxis)
3. **Be austere and consistent, not expressive.** Every page of the same kind uses the same
   sections, in the same order, with the same wording for the same idea. Repeating a phrase
   verbatim across pages is correct; varying it is a defect.
4. **Completeness is enumerated, not implied.** Document every public class, interface, struct,
   constant, field, enum and typedef, and for every method every parameter, the return value and
   every exception thrown. A missing row is a bug. (Google)
5. **Use the fixed first-sentence forms.** A method that acts and returns starts with the action
   verb; a boolean getter starts "Checks whether"; a non-boolean getter starts "Gets the"; a
   void setter starts "Sets the"/"Updates the"/"Deletes the"/"Registers"; a callback starts
   "Called by"; a factory starts "Creates a". Never open with the item's own name, never write
   "This class does…", and put no period inside the first sentence (generators truncate there —
   so write "for example", never "e.g.").
6. **Parameter descriptions have a shape.** Capitalized, ends with a period; non-boolean ones
   begin "The" or "A"; an instructing boolean states what happens when true and when false; a
   state-declaring boolean uses "True if …; false otherwise."; defaults are given as
   `Default: VALUE` after the behavior for each value.
7. **Return and error sections are short and formulaic.** Non-boolean returns start "The …";
   boolean returns use "True if …; false otherwise."; exceptions begin "If …" when the generator
   supplies "Throws", otherwise "Thrown when …". Detail belongs in the type's own page.
8. **Present tense, active voice, subject-verb-object.** "Returns a bird." Not "A bird will be
   returned." Passive is allowed only to emphasize the object, de-emphasize the actor, or when
   the actor is irrelevant. Never use `will` for general behavior, and never use `would`.
9. **Second person for the reader, third person for the software.** State facts about the API in
   the third person; address the reader as *you* only where you tell them what to do. Never
   *we*, *our*, *us*, *let's*, or *the user* (reserve *user* for the reader's own end users).
10. **Never inflect a code identifier.** Add a noun and inflect that: "the `ADDRESS` constant's
    value", "send a `POST` request", "the `example.yaml` file" — not "`ADDRESS`'s value",
    "`POST` the data", "`example.yaml`".
11. **Code font is a contract.** Identifiers, types, filenames, paths, env vars, flags, HTTP
    verbs and status codes, ports, enum members, literal values and placeholders go in code font.
    Product names, org names, domain names and browser-facing URLs do not. No angle brackets
    around element names, no quotation marks around code.
12. **Placeholders are `UPPER_SNAKE_CASE` in code font**, never `<angle>`, `camelCase`,
    `kebab-case`, or possessive (`YOUR_*`, `MY_*`). After the sample, write "Replace the
    following:" and list every placeholder in order of appearance with a description.
13. **Command-line syntax uses the four notations and nothing else:** `[optional]`,
    `{a|b}` for exactly-one-of, `...` for repetition, `UPPER_SNAKE` for values the reader
    supplies. Break lines over 80 characters with `\` (POSIX) or `^` (Windows); use the `$`
    prompt consistently or not at all; put input and output in separate code blocks.
14. **Every page carries at least one runnable example** — 5-20 lines at the top of the page —
    and it illustrates use without explaining, teaching, or telling a story. Introduce it with a
    complete sentence ending in a colon. Mark omitted code with a language comment, never `...`.
15. **Structured data goes in a table, not prose.** Three or more facts per item (name, type,
    default, description) ⇒ table; a term and its definition ⇒ description list; a bare set ⇒
    bulleted list; an ordered sequence ⇒ numbered list. Never a one-column table, never a
    one-item list, never a table of code snippets.
16. **Headings are sentence-case noun phrases** — no gerund first word, no trailing period, no
    numbering, no links, no bare code identifiers (add a descriptive noun), one `h1` per page,
    no skipped levels, no empty headings.
17. **Introduce every list, table and code block with a complete sentence**, and refer to
    position as "the following" / "the preceding". Never *above*, *below*, or *right-hand side*.
18. **Keep list items parallel** in syntax, capitalization and end punctuation. Omit the period
    when an item is a single word, has no verb, is entirely code font, or is entirely link text.
19. **Link text stands alone.** Use the target's page title or a descriptive phrase with the
    important words first; never *here*, *this document*, *click here*, or a bare URL. Use the
    fixed sentence "For more information about X, see Y." Include the descriptive noun inside
    the link (`the [--hostname flag](…)`).
20. **Short sentences, one idea each.** Under 26 words is the target and 30 is the ceiling; cut
    `in order to`, `has the ability to`, `due to the fact that`, `utilize`, `leverage`, `a number
    of`, `please`, `simply`, `easy`, `just`, `note that`. No exclamation points, minimal
    semicolons and parentheses, no `etc.`/`and so on`, no `e.g.`/`i.e.` (write "for example",
    "that is").
21. **Use one term for one thing, forever.** Same word, same capitalization, everywhere; never
    the same word as both noun and verb nearby; avoid `once`, `while`, `as` and `since` where
    they are ambiguous; keep helper words (`then`, `that`, `of`) and relative pronouns rather
    than dropping them.
22. **State stability explicitly, and keep it in sync with the changelog.** Deprecated items say
    what replaced them and in which version they were deprecated, in the first sentence.
    Deprecation precedes removal by at least one release. Never pre-announce unreleased
    behavior, and never write `currently`, `latest`, `soon`, or `new` — the page must stay true
    without a re-read.
23. **Name the actor; never write `There is`/`There are` or a bare pronoun.** "The `met_trick`
    variable stores the current accuracy", not "There is a variable called `met_trick` that…".
    If more than five words separate a noun from its pronoun, or another noun intervenes, repeat
    the noun. Put a noun after every `this` and `that`.
24. **Quantify instead of praising.** No `fast`, `powerful`, `robust`, `seamless`, `simple`, or
    any adverb of degree in a reference page. Replace with a measured number and its conditions,
    or delete. Reference documents a product; it does not sell one.
25. **Every example is tested code, not a snippet.** Samples build, run, do what they claim, and
    follow language conventions; they are maintained like code and linted by the project's own
    toolchain. Spell out named parameters, comment only the non-obvious, put anything the reader
    would need after pasting into the code comments, and state the expected output.

---

## Lint checklist

Regex-able checks over generated Markdown. `IN_PROSE` means: after stripping fenced code blocks,
inline code spans, link URLs and HTML comments. Severities mirror the Vale packages.

**Structure**

| # | Check | Pattern / test | Level |
|---|---|---|---|
| S1 | Exactly one `h1` | `^# ` occurs exactly once | error |
| S2 | No skipped heading levels | consecutive heading depths never increase by >1 | error |
| S3 | No empty heading | a heading line followed by another heading with no body between | error |
| S4 | Heading is sentence case | `^#{1,6} \s*(?:[A-Z]\w*\s+){1,}[A-Z]\w*` with an allow-list of identifiers/acronyms | warning |
| S5 | No trailing period on a heading | `^#{1,6} .*[a-z0-9]\.\s*$` | warning |
| S6 | No numbered heading | `^#{1,6} \s*\d+[.)]\s` | error |
| S7 | No link in a heading | `^#{1,6} .*\]\(` | error |
| S8 | Heading not a bare code identifier | `^#{1,6} \s*\x60[^\x60]+\x60\s*$` | warning |
| S9 | Heading does not start with a gerund | `^#{1,6} \s*\w+ing\b` | warning |
| S10 | Optional-section prefix form | `\(optional\)\s*$` on a heading ⇒ rewrite as `Optional: ` | warning |
| S11 | Page title not repeated as a section heading | `^##+ \s*<h1 text>\s*$` | warning |
| S12 | Every parameter row has name, type and description | table rows with <3 non-empty cells under a Parameters heading | error |
| S13 | No one-column table | a table whose header row has a single cell | warning |
| S14 | No one-item list | a list block with exactly one item | warning |
| S15 | List/table/code block has an introducing sentence | the line before a list/table/fence is blank or a heading | warning |
| S16 | Intro line ends in `:` or `.` | the introducing line matches `[:.]\s*$` | warning |
| S17 | List items are parallel in end punctuation | within one list, mixed `\.$` and non-`\.$` items | warning |
| S18 | List items are parallel in opening word class | first words of items in one list mix imperative verbs, gerunds and nouns | warning |
| S19 | Table cell length | a table cell containing more than two sentences ("ask yourself whether that information belongs in some other format") | warning |
| S20 | Paragraph length | a paragraph of more than 7 sentences (target 3-5); or a run of consecutive 1-sentence paragraphs | suggestion |
| S21 | No stacked headings | a level-3 heading immediately after a level-2 heading with no text between | warning |
| S22 | Embedded prose list | a sentence containing `(?:first|second|third)ly?,` or 3+ comma-separated `and`-joined clauses ⇒ convert to a list | suggestion |
| S23 | Sibling headings are parallel | sibling headings at one level mix verb-first and noun-phrase forms | warning |

**Code, placeholders, commands**

| # | Check | Pattern / test | Level |
|---|---|---|---|
| C1 | Placeholder casing | in code spans: `\b[a-z][A-Za-z0-9]*_[A-Za-z0-9_]*\b` used as a placeholder, or `<[A-Za-z_]+>`, or `\{\{[^}]+\}\}` ⇒ must be `[A-Z][A-Z0-9_]*` | error |
| C2 | No possessive placeholder | `\b(?:YOUR|MY)_[A-Z0-9_]+\b` | error |
| C3 | Every placeholder is explained | each `[A-Z][A-Z0-9_]{2,}` in a fenced block appears in a following "Replace the following:" list | error |
| C4 | Placeholder list order | the explanation list order matches first-appearance order in the sample | warning |
| C5 | No literal ellipsis for elided code | `^\s*(?:\.\.\.|…)\s*$` inside a fence | error |
| C6 | Code lines ≤ 80 chars | any line inside a fence longer than 80 | warning |
| C7 | Continuation character on split commands | inside a shell fence, a non-final line not ending in `\` or `^` when the next line is indented | warning |
| C8 | Consistent prompt | `^\s*[$#]\s` present on some but not all commands in a page | warning |
| C9 | Input and output not mixed | a shell fence containing both a `$`-prefixed line and non-prompt output lines | warning |
| C10 | Fence has a language tag | `^\x60\x60\x60\s*$` | warning |
| C11 | CLI syntax uses the sanctioned notation | in a synopsis line, reject `<[a-z]+>`; require `\[[A-Z_ .]+\]`, `\{[^}]*\|[^}]*\}`, `\.\.\.` | warning |
| C12 | Identifier not inflected | IN_PROSE: `\x60[^\x60]+\x60(?:'s|s\b|ed\b|ing\b)` | error |
| C13 | No angle brackets around element names | IN_PROSE: `\x60<[A-Za-z][A-Za-z0-9-]*>\x60` when describing an element | warning |
| C14 | Quotes not wrapped around code | IN_PROSE: `"\x60[^\x60]+\x60"` | warning |
| C15 | Filename/keyword carries a qualifying noun | IN_PROSE: `\x60[\w./-]+\.(?:ya?ml|json|toml|ts|js|py)\x60(?!\s+(?:file|config|manifest))` | suggestion |
| C16 | HTTP status codes formatted | IN_PROSE: `\b[1-5]\d\d\b` not inside a code span | warning |

**Prose (mirrors Vale ids)**

| # | Check | Pattern (IN_PROSE, case-insensitive unless noted) | Vale id | Level |
|---|---|---|---|---|
| P1 | Future tense | `\bwill\b` | Google.Will | warning |
| P2 | Hypothetical future | `\bwould\b` | — | warning |
| P3 | Passive voice | `\b(?:am|are|is|was|were|be|been|being)\s+\w+ed\b` plus the irregular participle list | Google.Passive | suggestion |
| P4 | First-person plural | `\b(?:we|we're|we've|our|ours|us|let's)\b` | Google.We | warning |
| P5 | First-person singular | `(?<=^|\s)I(?=[\s,])\|\bI'm\b\|\bme\b\|\bmy\b\|\bmine\b` (case-sensitive) | Google.FirstPerson | warning |
| P6 | Latin abbreviations | `\b(?:e\.g\.|eg|i\.e\.|ie|etc\.|viz\.|cf\.)(?=[\s,;]|$)` | Google.Latin | error |
| P7 | `and so on` / `etc.` closing a list | `(?:,\s*(?:etc\.|and so on))\s*$` | Microsoft.Avoid | error |
| P8 | Politeness and minimizers | `\b(?:please|simply|simple|easy|easily|just|obviously|of course|note that|it should be noted)\b` | Google tone | warning |
| P9 | Excessive claims | `\bbest(?! practices?)\b\|\bsimplest\b\|\bfastest\b\|\bguarantees?\b` | Google.ExcessiveClaims | suggestion |
| P10 | Time-anchored words | `\b(?:currently|latest|soon|at this time|new(?:ly)? released)\b` | Google.Timeless | suggestion |
| P11 | Wordiness | `\bin order to\b\|\bdue to the fact that\b\|\bbecause of the fact that\b\|\bhas the ability to\b\|\bprior to\b\|\bsubsequent to\b\|\bin the event that\b\|\butilize\b\|\bmake use of\b\|\bleverage\b\|\ba (?:large )?number of\b\|\bwhether or not\b\|\bwith regard to\b\|\btake into account\b\|\bat this point in time\b\|\bwith the exception of\b` | Microsoft.Wordiness | suggestion |
| P12 | Sentence length | any sentence with > 30 words (target < 26) | Microsoft.SentenceLength | suggestion |
| P13 | Exclamation point | `!` outside code | Google.Exclamation | error |
| P14 | Semicolon | `;` outside code | Google.Semicolons | suggestion |
| P15 | Question mark | `\w\?(?:\s|$)` | Microsoft.QuestionMarks | suggestion |
| P16 | Ellipsis in prose | `\.\.\.\|…` | Google.Ellipses | warning |
| P17 | Optional plural | `\b\w+\(s\)\|\b\w+\(es\)` | Google.OptionalPlurals | error |
| P18 | Ordinal digits | `\b\d+(?:st|nd|rd|th)\b` | Google.Ordinal | error |
| P19 | `-ly` hyphen | `\b[^\s-]+ly-\w+\b` (case-sensitive) | Google.LyHyphens | error |
| P20 | Suspended hyphen | `\w+- and \w+-` | Microsoft.Suspended | warning |
| P21 | Acronym periods | `\b(?:[A-Z]\.){3,}` | Google.Periods | error |
| P22 | Unit spacing | `\b\d+(?:B\|kB\|MB\|GB\|TB\|ns\|ms\|min\|h\|d)\b` and `\b\d+s\b(?<!(?:19\|20)\d\ds)` | Google.Units | error |
| P23 | Numeric range wording | `(?:from\|between)\s\d+\s?-\s?\d+` | Google.Ranges | warning |
| P24 | Serial comma | three-item series without the comma before `and`/`or` | Google.OxfordComma | warning |
| P25 | Spaced dash | `\s[—–]\s` | Google.EmDash | error |
| P26 | Punctuation outside quotes | `"[^"]+"[.,]` | Google.Quotes | error |
| P27 | Double space | `\S {2,}\S` | Google.Spacing | error |
| P28 | Capital after mid-sentence colon | `(?<!Note: )(?<!Caution: )(?<!Warning: )(?<=:\s)[A-Z]\w+` | Google.Colons | warning |
| P29 | Directional language | `\b(?:above|below|to the (?:left|right)|right-hand side)\b` when not `the (?:preceding|following)` | Google procedures | warning |
| P30 | Vague link text | `\[(?:here|click here|this|this (?:document|article|page|link)|read more|more)\]\(` | Google.cross-references | error |
| P31 | Bare URL as link text | `\[(?:https?://[^\]]+)\]\(` | — | warning |
| P32 | Link introduction wording | `for more information on\b` ⇒ use `about`; `\bsee below\b` ⇒ position words | warning |
| P33 | British spelling | `\b\w+(?:nised?|isation)\b\|\bcolour\b\|\blabour\b\|\bcentre\b` | Google.Spelling | warning |
| P34 | Internet slang | `\btl;dr\b\|\bymmv\b\|\brtfm\b\|\bimo\b\|\bfwiw\b` | Google.Slang | error |
| P35 | Gendered pronoun forms | `\bhe/she\b\|\bs/he\b\|\(s\)he\b` | Google.Gender | error |
| P36 | Non-inclusive terms | `\b(?:whitelist|blacklist|master/slave|sanity check|dummy|crazy|cripple[sd]?|man-hours|mankind)\b` outside code font | Google.inclusive / Microsoft.BiasFree | error |
| P37 | Ableist/graphic verbs | `\b(?:hangs?|hit|abort|kill)\b` outside code font | Microsoft.BiasFree | warning |
| P38 | Anthropomorphism | `\b(?:sees|tells|knows|wants|thinks)\b` with a software subject | Google.Anthropomorphism | suggestion |
| P39 | Undefined acronym | first occurrence of `\b[A-Z]{3,5}\b` with no preceding `Words (ACRO)` and not in the allow-list | Google.Acronyms | suggestion |
| P40 | `click` as a verb | `\bclick(?:s|ed|ing)?(?: on)?\b` | Microsoft.UIVerbs | warning |
| P41 | Same term, two spellings | a term appearing as both `command-line` and `command line`, `filename`/`file name`, `config`/`configuration` within one page | Google.translation | warning |
| P42 | Sentence-opening repetition | more than 3 consecutive sentences starting with the same 2 words (`You can`, `This method`) | Google tone | suggestion |
| P43 | Existential opener | `^\s*There (?:is|are|was|were)\b` | TW-One one-02 | warning |
| P44 | Weak generic verb | `\b(?:occurs|happens|is performed|is done|takes place)\b` | TW-One one-02 | suggestion |
| P45 | Marketing adjective | `\b(?:powerful|robust|seamless|blazing|lightning[- ]fast|rich|flexible|intuitive|cutting[- ]edge|state[- ]of[- ]the[- ]art)\b` | TW-One one-02 | warning |
| P46 | `which` without a preceding comma | `[^,]\s+which\b` in a restrictive clause | TW-One one-05 | suggestion |
| P47 | `that` with a preceding comma | `,\s+that\b` | TW-One one-05 | suggestion |
| P48 | Bare demonstrative | `\b(?:This|That|These|Those)\s+(?:is|are|was|were|can|will|has|have)\b` (no noun after) | TW-One one-01 | warning |
| P49 | Modal ambiguity | `\b(?:should|shall|could|would|may)\b` — `should` "is ambiguous by definition"; prefer `can`, `might`, `must` | word list | warning |
| P50 | `allows you to` / `enables you to` | `\b(?:allows?\|enables?) (?:you\|users?) to\b` ⇒ `lets you` | word list | error |
| P51 | Ambiguous connective | `\bOnce\b` (⇒ *after*), `\bsince\b` (⇒ *because*), `\bwhile\b` used for contrast (⇒ *although*) | word list | warning |
| P52 | Version range wording | `\b(?:above\|below\|higher\|lower\|under)\s+(?:version\s+)?\d+\.\d+` or `\d+\.\d+\+` ⇒ *earlier*/*later* | word list | error |
| P53 | Rate written with a slash | `\b\w+/(?:s\|sec\|second\|min\|minute\|hour\|day)\b` ⇒ *per* | word list | warning |
| P54 | `Create a new` | `\bCreate a new\b` ⇒ `Create a` | word list | warning |
| P55 | Noun-as-verb | `\b(?:email\|screenshot\|ssh\|RDP\|Google\|interface\|architect\|impact)(?:s\|ed\|ing)?\b` in verb position | word list | warning |
| P56 | Spelling variants of one term in one page | both forms of any pair in `{command-line\|command line}`, `{filename\|file name}`, `{data type\|datatype}`, `{sub-command\|subcommand}`, `{sign in\|log in}`, `{backend\|back-end}` | word list | error |
| P57 | Undefined acronym used fewer than 3 times | acronym count < 3 on the page ⇒ spell it out instead | TW-One one-02 | suggestion |
| P58 | Ambiguous `using` | `\busing\b` immediately after a noun ⇒ `by using` / `that use` | word list | suggestion |
| P59 | Missing helper word | `\bIf [^,.]{5,60}, (?!then\b)` ⇒ insert `then` | Google.translation | suggestion |
| P60 | Dropped relative pronoun | `\bthe \w+ you (?:defined\|created\|set\|specified)\b` ⇒ insert `that` | Google.translation | suggestion |

**Cross-document consistency**

| # | Check | Test | Level |
|---|---|---|---|
| X1 | Every public symbol has a page | set difference between the exported-symbol manifest and the generated page index | error |
| X2 | Every documented symbol still exists | reverse of X1 | error |
| X3 | Every parameter in the signature has a row | signature arity vs parameter-table row count | error |
| X4 | Return and throws documented | a non-void signature with no Returns section; a signature with `throws`/`Result`/`Either` and no error section | error |
| X5 | Deprecated items name a replacement and a version | a `Deprecated` marker whose first sentence lacks `Use ` or a version string | error |
| X6 | Deprecations appear in the changelog | every `Deprecated` page marker has a `### Deprecated` changelog entry | warning |
| X7 | Breaking changes carry the marker | a changelog entry under `Changed`/`Removed` for a removed public symbol lacks `**Breaking:**` | warning |
| X8 | Changelog heading form | `^## \[[^\]]+\] - \d{4}-\d{2}-\d{2}(?: \[YANKED\])?$` | error |
| X9 | Changelog types are the six | any `^### ` under a version that is not Added/Changed/Deprecated/Removed/Fixed/Security | error |
| X10 | Every version link resolves | each `[x.y.z]` heading has a matching reference-link definition | error |
| X11 | No broken internal links | every relative link target exists | error |
| X12 | Examples compile | every fenced block tagged with a supported language is type-checked or executed in CI (Standard Readme: examples "should be linted in the same way as the code") | error |
| X13 | Short description agrees with the manifest | README short description == package `description` field, < 120 chars | error |
| X14 | Page structure is uniform | all pages of one kind expose the same ordered section set | warning |
