/**
 * Conservative provable-statelessness analysis for unbound step callbacks.
 * DIAGNOSTIC-ONLY since anonymous executable identities were retired (the
 * builder rejects every unbound callback; this scan only selects between
 * RUNNER_BINDING_AMBIGUOUS and RUNNER_BINDING_REQUIRED so authors learn WHY
 * their callback could never have carried a content-addressed identity).
 *
 * JavaScript does not expose a closure environment, so a source digest can
 * never distinguish `make("A")` from `make("B")` when both produce
 * byte-identical source. And byte-identical source is not enough on its own:
 * evaluation must also be independent of AMBIENT MUTABLE INTRINSICS, or two
 * fresh processes with different prototype state produce different traces from
 * the same replay identity (`() => [] + []` diverges under a mutated
 * `Array.prototype.toString`). A sound anonymous replay identity would at
 * minimum have required callbacks written in an intentionally tiny,
 * coercion-free grammar:
 *
 *   - own parameters, sound local declarations, string/number literals,
 *     reserved-word literals (`true`/`false`/`null`), and `undefined`-free
 *     control flow (`return`, `if`/`else`, `while`, `switch`, `try`);
 *   - strict equality (`===`/`!==`), boolean logic (`!`, `&&`, `||`, `??`,
 *     `?:`), `typeof`/`void`, and plain assignment to locals — none of which
 *     can invoke ToPrimitive/ToNumber/Symbol.toPrimitive on an object;
 *   - calls of bare parameters/locals and empty-parameter nested arrows.
 *
 * Everything else is UNPROVABLE or intrinsic-reaching and must carry an
 * explicit caller-supplied runnerBinding, which is part of the canonical AST
 * and therefore of the replay identity. In particular:
 *
 *   - EVERY form of member access is capability acquisition, not mere
 *     property reading: `({}).constructor.constructor("…")()` and its
 *     computed twin evaluate arbitrary source that can read process state;
 *   - object and array ALLOCATION (`{…}`, `[…]`) is excluded because any
 *     allocated object flows through mutable prototype methods at the first
 *     coercion or serialization boundary (`toString`, `valueOf`, `toJSON`,
 *     thenable `then` adoption);
 *   - every coercion-capable operator (`+ - * / % < > <= >= == != & | ^ ~`
 *     and their compound forms) is excluded because ToPrimitive on an object
 *     operand invokes mutable intrinsics — and operand types are not provable
 *     from source (`/` additionally opens regular-expression literals);
 *   - `async`/`await` are excluded because promise resolution performs
 *     thenable adoption (a mutable `then` lookup) on the settled value;
 *   - `new`, `delete`, `in`, `instanceof`, and `throw` reach constructor,
 *     property, and serialization protocols the scan cannot bound.
 *
 * The analysis is deliberately fail-closed: any construct it cannot prove is
 * treated as captured state. Over-rejection costs a runnerBinding; under-
 * rejection silently corrupts replay identity across processes.
 */

/** Words that can never be variable references (reserved words + literals). */
const RESERVED = new Set([
  "return", "if", "else", "for", "while", "do", "switch", "case", "default",
  "break", "continue", "typeof", "void",
  "try", "catch", "finally", "debugger", "enum",
  "const", "let", "var", "true", "false", "null",
]);
/** Tokens whose presence makes the source unprovable regardless of context. */
const UNPROVABLE = new Set([
  "this", "arguments", "class", "super", "import", "export", "with", "eval", "function",
  // Coercion- and protocol-reaching reserved words: `await` adopts thenables,
  // `new` invokes constructors, `in`/`instanceof` walk prototype protocols,
  // `delete` mutates, `throw`/`yield` hand values to serialization boundaries
  // outside the grammar. `async` is contextual but only ever introduces an
  // async binder here, so it fails closed too.
  "await", "async", "new", "delete", "in", "instanceof", "throw", "yield",
]);
const SIMPLE_PARAMS = /^\s*(?:[A-Za-z_$][\w$]*\s*(?:,\s*[A-Za-z_$][\w$]*\s*)*,?\s*)?$/;
/** Numeric literals, neutralised before token analysis so `1.5`/`1e+5` are never mistaken for member access or operators. */
const NUMERIC_LITERALS = /(?<![\w$.])(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/g;
/** Single characters that are coercion-capable operators (or open one) and therefore outside the grammar. */
const COERCION_CHARS = new Set(["+", "-", "*", "%", "~", "^", "<", ">", "[", "]"]);
/** Keywords after which `{` opens a BLOCK, never an object literal. */
const BLOCK_KEYWORDS = new Set(["else", "do", "try", "finally", "catch"]);
const isIdentStart = (ch: string): boolean => /[A-Za-z_$]/.test(ch);
const isIdentPart = (ch: string): boolean => /[\w$]/.test(ch);

/** Replace string literals and comments with neutral filler; null on template literals. */
const stripLiterals = (source: string): string | null => {
  let out = "";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === "`") return null;
    if (ch === '"' || ch === "'") {
      out += "0";
      for (i++; i < source.length && source[i] !== ch; i++) if (source[i] === "\\") i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") { for (; i < source.length && source[i] !== "\n"; i++); out += " "; continue; }
    if (ch === "/" && source[i + 1] === "*") { i += 2; for (; i + 1 < source.length && !(source[i] === "*" && source[i + 1] === "/"); i++); i++; out += " "; continue; }
    out += ch;
  }
  return out;
};

const matchingParen = (text: string, openIndex: number): number => {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i;
  }
  return -1;
};
const nextNonSpace = (text: string, index: number): number => { let i = index; while (i < text.length && /\s/.test(text[i]!)) i++; return i; };
const prevNonSpace = (text: string, index: number): number => { let i = index; while (i >= 0 && /\s/.test(text[i]!)) i--; return i; };
const wordEndingAt = (text: string, lastIndex: number): string => {
  let start = lastIndex;
  while (start > 0 && isIdentPart(text[start - 1]!)) start--;
  return text.slice(start, lastIndex + 1);
};

type OuterForm = Readonly<{ params: readonly string[]; body: string; blockBody: boolean }>;

const parseOuterForm = (stripped: string): OuterForm | null => {
  const text = stripped.trim();
  // `async` outer forms are rejected outright: an async runner's returned
  // promise performs thenable adoption on its settled value, which is a
  // mutable `Object.prototype.then` lookup outside the provable grammar.
  if (text.startsWith("function")) {
    let cursor = 8;
    cursor = nextNonSpace(text, cursor);
    if (text[cursor] === "*") cursor = nextNonSpace(text, cursor + 1);
    if (isIdentStart(text[cursor] ?? "")) { while (cursor < text.length && isIdentPart(text[cursor]!)) cursor++; cursor = nextNonSpace(text, cursor); }
    if (text[cursor] !== "(") return null;
    const close = matchingParen(text, cursor);
    if (close < 0) return null;
    const paramsText = text.slice(cursor + 1, close);
    if (!SIMPLE_PARAMS.test(paramsText)) return null;
    const bodyStart = nextNonSpace(text, close + 1);
    if (text[bodyStart] !== "{") return null;
    return { params: paramsText.match(/[A-Za-z_$][\w$]*/g) ?? [], body: text.slice(bodyStart), blockBody: true };
  }
  if (text.startsWith("(")) {
    const close = matchingParen(text, 0);
    if (close < 0) return null;
    const paramsText = text.slice(1, close);
    if (!SIMPLE_PARAMS.test(paramsText)) return null;
    const arrow = nextNonSpace(text, close + 1);
    if (text.slice(arrow, arrow + 2) !== "=>") return null;
    const body = text.slice(nextNonSpace(text, arrow + 2));
    return { params: paramsText.match(/[A-Za-z_$][\w$]*/g) ?? [], body, blockBody: body.startsWith("{") };
  }
  if (isIdentStart(text[0] ?? "")) {
    let cursor = 0;
    while (cursor < text.length && isIdentPart(text[cursor]!)) cursor++;
    const param = text.slice(0, cursor);
    if (param === "async") return null;
    const arrow = nextNonSpace(text, cursor);
    if (text.slice(arrow, arrow + 2) !== "=>") return null;
    const body = text.slice(nextNonSpace(text, arrow + 2));
    return { params: [param], body, blockBody: body.startsWith("{") };
  }
  return null;
};

/**
 * True only when the runner source provably references nothing beyond its own
 * parameters, sound local declarations, reserved words, and literals — AND
 * provably cannot invoke a mutable intrinsic (prototype method, coercion
 * protocol, thenable adoption) while evaluating.
 */
export const provablyStatelessSource = (rawSource: string): boolean => {
  const stripped = stripLiterals(rawSource);
  if (stripped === null) return false;
  // The tokenizer below only sees ASCII identifiers. Any codepoint outside
  // printable ASCII (a Unicode identifier, exotic whitespace, a bidi control)
  // and any backslash (a `\u` identifier escape or a regex literal) would be
  // skipped as non-identifier noise while possibly referencing a captured
  // binding, so both fail closed.
  if (stripped.includes("\\") || !/^[\t\n\r\x20-\x7E]*$/.test(stripped)) return false;
  // This scan does not lex regular-expression literals, and distinguishing a
  // regex literal from division needs a real JS lexer: `()=>[/var value/,
  // value]` would otherwise credit the regex TEXT `var value` as a local
  // declaration and admit the captured `value`. Comments are already stripped
  // and every genuine regex literal starts with a `/` the stripper keeps, so
  // any remaining `/` (division, `/=`, or a regex literal) fails closed;
  // division is a coercion-capable operator and outside the grammar anyway.
  if (stripped.includes("/")) return false;
  const outer = parseOuterForm(stripped);
  if (outer === null) return false;
  const locals = new Set(outer.params);
  const body = outer.body;

  // Token-level bans run on the neutralised body (numeric literals collapsed
  // to `0`) so `1.5` is never mistaken for member access and `1e+5` never for
  // an operator. Member access of ANY form is capability acquisition (see
  // module header): a provable body may contain no `.` at all (dot access,
  // optional chaining, spread, meta-properties).
  const neutralized = body.replace(NUMERIC_LITERALS, "0");
  if (neutralized.includes(".")) return false;
  for (let i = 0; i < neutralized.length; i++) {
    const ch = neutralized[i]!;
    // Coercion-capable operator characters and array brackets fail closed:
    // `[` allocates (or computes access on) an object whose first coercion or
    // serialization walks mutable prototypes — Sol's `() => [] + []`
    // counterexample diverged across fresh processes under a mutated
    // `Array.prototype.toString` while sharing one anonymous identity.
    // (`>` as part of `=>` is consumed by the `=` case below.)
    if (COERCION_CHARS.has(ch)) return false;
    if (ch === "!") {
      // `!` consumes its trailing `=` run as ONE token: a bare `!` is boolean
      // not and `!==` is the coercion-free strict inequality, but `!=` is
      // loose inequality — ToPrimitive on an object operand walks the mutable
      // `Symbol.toPrimitive`/`valueOf`/`toString` protocol (Sol's
      // `(_runtime, input) => input != "A"` diverged across fresh processes
      // under a mutated `Object.prototype[Symbol.toPrimitive]` while sharing
      // one anonymous identity). Leaving the `=` for the assignment arm below
      // was exactly the adjacency heuristic that admitted it.
      let j = i;
      while (neutralized[j + 1] === "=") j++;
      const equalsRun = j - i;
      if (equalsRun !== 0 && equalsRun !== 2) return false;
      i = j;
      continue;
    }
    if (ch === "=") {
      if (neutralized[i + 1] === ">") { i++; continue; }
      let j = i;
      while (neutralized[j + 1] === "=") j++;
      const runLength = j - i + 1;
      // `===` is the coercion-free strict comparison and a single `=` is
      // plain assignment to a local (member-access targets are already
      // banned). Loose `==` applies ToPrimitive to object operands. `!==` and
      // `!=` never reach this arm: the `!` case above consumes them whole.
      if (!(runLength === 3 || runLength === 1)) return false;
      i = j;
      continue;
    }
    if (ch === "&" || ch === "|") {
      // Only the boolean forms `&&`/`||` (and via a trailing `=`, their
      // logical-assignment forms) are coercion-free; single `&`/`|` are
      // ToNumber bitwise operators.
      if (neutralized[i + 1] !== ch) return false;
      i++;
      continue;
    }
    if (ch === "{") {
      // `{` may only open a BLOCK. An object literal allocates, and the scan
      // proves block-ness by position: body start, after `)` (`if (x) {`),
      // after another block boundary, after `=>`, or after a block keyword.
      const prevIndex = prevNonSpace(neutralized, i - 1);
      if (prevIndex < 0) continue;
      const prev = neutralized[prevIndex]!;
      if (prev === ")" || prev === "{" || prev === "}" || prev === ";") continue;
      if (prev === ">" && neutralized[prevIndex - 1] === "=") continue;
      if (isIdentPart(prev) && BLOCK_KEYWORDS.has(wordEndingAt(neutralized, prevIndex))) continue;
      return false;
    }
  }

  // Declaration crediting is sound only inside a single function scope. A
  // nested binder (`=>` anywhere in the body — `function`/`class` are already
  // unprovable) opens a scope this token scan cannot attribute declarations
  // to: `(() => { var value = 0; })()` must never bind the outer runner's
  // `value`. With a nested binder present, only parameters are credited and
  // any declaration keyword fails closed.
  if (body.includes("=>")) {
    if (/\b(?:var|let|const)\b/.test(body)) return false;
  } else {
    // Sound local declarations only: `var` is function-scoped; const/let count
    // only at the body's top block level. A block-nested const/let can shadow a
    // capture inside its block while the same name resolves to the capture
    // outside it, so depth > 1 declarations are never credited.
    let depth = 0;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i]!;
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (isIdentStart(ch) && (i === 0 || !isIdentPart(body[i - 1]!))) {
        let end = i;
        while (end < body.length && isIdentPart(body[end]!)) end++;
        const word = body.slice(i, end);
        // A for-head const/let (`for (const x of …)`) is scoped to the loop, not
        // the body block, so it is never credited: a same-named use after the
        // loop can resolve to an outer capture.
        const headDeclaration = body[prevNonSpace(body, i - 1)] === "(";
        if (word === "var" || ((word === "const" || word === "let") && !headDeclaration && depth === (outer.blockBody ? 1 : 0))) {
          const nameStart = nextNonSpace(body, end);
          if (isIdentStart(body[nameStart] ?? "")) {
            let nameEnd = nameStart;
            while (nameEnd < body.length && isIdentPart(body[nameEnd]!)) nameEnd++;
            if (word === "var" || body[nextNonSpace(body, nameEnd)] === "=") locals.add(body.slice(nameStart, nameEnd));
          }
        }
        i = end - 1;
      }
    }
  }

  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "(") {
      const close = matchingParen(body, i);
      if (close < 0) return false;
      const after = nextNonSpace(body, close + 1);
      if (body.slice(after, after + 2) === "=>") {
        // Nested binders are allowed only with an empty parameter list: a
        // parameterised nested binder would require scope-aware analysis to
        // distinguish its bindings from same-named outer captures.
        if (body.slice(i + 1, close).trim() !== "") return false;
      }
      continue;
    }
    if (!isIdentStart(ch) || (i > 0 && isIdentPart(body[i - 1]!))) continue;
    let end = i;
    while (end < body.length && isIdentPart(body[end]!)) end++;
    const word = body.slice(i, end);
    i = end - 1;
    if (UNPROVABLE.has(word)) return false;
    if (RESERVED.has(word)) {
      // A reserved word followed by `.` is a meta-property access.
      // `new.target` is LEXICAL state: byte-identical arrow source answers
      // differently depending on how the enclosing function was invoked
      // (called versus constructed), so it can never carry an anonymous
      // content-addressed identity. No provable-stateless body needs any
      // `<reserved>.` sequence, so every such form fails closed.
      if (body[nextNonSpace(body, end)] === ".") return false;
      continue;
    }
    if (locals.has(word)) continue;
    // A single-identifier arrow parameter (`x => ...`) is a parameterised
    // nested binder; reject it for the same scope-soundness reason. Every
    // other unrecognised identifier — including object-literal keys, which no
    // longer exist in the grammar now that object literals are banned — is a
    // possible capture and fails closed.
    return false;
  }
  return true;
};
