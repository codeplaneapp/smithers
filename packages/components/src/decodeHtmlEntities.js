/**
 * Reverse the HTML-entity escaping that renderToStaticMarkup applies to text
 * (& < > " '). Without this, a prompt like `a < b && c` reaches the agent as
 * `a &lt; b &amp;&amp; c`, and injected JSON schema hints (`"key"`) arrive as
 * `&quot;key&quot;`, both of which corrupt the agent-facing text.
 * `&amp;` is decoded last so an escaped literal (`&amp;lt;`, meaning the source
 * text `&lt;`) is not double-decoded into `<`.
 * @param {string} html
 * @returns {string}
 */
export function decodeHtmlEntities(html) {
  return html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
