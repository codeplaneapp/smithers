The whole surface is one name: a branded string type and the schema that mints it.

```typescript
type Canonical = string & Brand<"@smthrs/canonical/Canonical">
const Canonical: Schema.Codec<unknown, Canonical>
```

The schema rejects values that JSON cannot represent and strings containing lone Unicode surrogates. Decoding fails rather than approximates: a value carrying a lone surrogate, a non-finite number, or a cycle has no canonical form, and a best-effort string would produce a digest that silently disagrees with another host's. Encoding a `Canonical` value parses it back to JSON data.

The serializer is the well-tested [`canonicalize`](https://www.npmjs.com/package/canonicalize) package. [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html) is the normative format specification.
