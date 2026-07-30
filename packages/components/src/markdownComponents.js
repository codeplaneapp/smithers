import React from "react";
/**
 * @param {...any} parts
 */
function fragment(...parts) {
  return React.createElement(React.Fragment, null, ...parts);
}
/** @type {Record<string, React.FC<any>>} */
export const markdownComponents = {
  h1: ({ children }) => fragment("# ", children, "\n\n"),
  h2: ({ children }) => fragment("## ", children, "\n\n"),
  h3: ({ children }) => fragment("### ", children, "\n\n"),
  h4: ({ children }) => fragment("#### ", children, "\n\n"),
  h5: ({ children }) => fragment("##### ", children, "\n\n"),
  h6: ({ children }) => fragment("###### ", children, "\n\n"),
  p: ({ children }) => fragment(children, "\n\n"),
  blockquote: ({ children }) => fragment("> ", children, "\n"),
  hr: () => fragment("---\n\n"),
  ul: ({ children }) => fragment(children, "\n"),
  ol: ({ children, start }) => {
    // Number the items so ordered lists keep their `1.`/`2.` labels: each
    // direct child element gets the ordinal it renders with, counting from
    // the HTML `start` attribute when the source list did not begin at 1.
    const first = Number(start);
    let ordinal = Number.isFinite(first) ? first : 1;
    const items = React.Children.map(children, (child) =>
      React.isValidElement(child) ? React.cloneElement(child, { ordinal: ordinal++ }) : child,
    );
    return fragment(items, "\n");
  },
  li: ({ children, ordinal }) => fragment(typeof ordinal === "number" ? `${ordinal}. ` : "- ", children, "\n"),
  code: ({ children, className }) => {
    const lang = typeof className === "string" ? /(?:^|\s)language-(\S+)/.exec(className)?.[1] : undefined;
    if (lang) {
      return fragment("```", lang, "\n", children, "\n```\n\n");
    }
    return fragment("`", children, "`");
  },
  pre: ({ children }) => fragment(children),
  strong: ({ children }) => fragment("**", children, "**"),
  em: ({ children }) => fragment("*", children, "*"),
  a: ({ href, children }) => fragment("[", children, "](", href, ")"),
  br: () => fragment("\n"),
  img: ({ alt, src }) => fragment("![", alt ?? "", "](", src, ")"),
  table: ({ children }) => fragment(children, "\n"),
  thead: ({ children }) => fragment(children),
  tbody: ({ children }) => fragment(children),
  tr: ({ children }) => fragment("| ", children, "\n"),
  th: ({ children }) => fragment(children, " | "),
  td: ({ children }) => fragment(children, " | "),
  div: ({ children }) => fragment(children, "\n"),
  section: ({ children }) => fragment(children, "\n"),
  span: ({ children }) => fragment(children),
};
