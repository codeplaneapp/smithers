import React from "react";

function fragment(...parts: any[]) {
  return React.createElement(React.Fragment, null, ...parts);
}

export const markdownComponents: Record<string, React.FC<any>> = {
  h1: ({ children }: any) => fragment("# ", children, "\n\n"),
  h2: ({ children }: any) => fragment("## ", children, "\n\n"),
  h3: ({ children }: any) => fragment("### ", children, "\n\n"),
  h4: ({ children }: any) => fragment("#### ", children, "\n\n"),
  h5: ({ children }: any) => fragment("##### ", children, "\n\n"),
  h6: ({ children }: any) => fragment("###### ", children, "\n\n"),
  p: ({ children }: any) => fragment(children, "\n\n"),
  blockquote: ({ children }: any) => fragment("> ", children, "\n"),
  hr: () => fragment("---\n\n"),
  ul: ({ children }: any) => fragment(children, "\n"),
  ol: ({ children }: any) => fragment(children, "\n"),
  li: ({ children }: any) => fragment("- ", children, "\n"),
  code: ({ children, className }: any) => {
    if (className) {
      const lang = className.replace("language-", "");
      return fragment("```", lang, "\n", children, "\n```\n\n");
    }
    return fragment("`", children, "`");
  },
  pre: ({ children }: any) => fragment(children),
  strong: ({ children }: any) => fragment("**", children, "**"),
  em: ({ children }: any) => fragment("*", children, "*"),
  a: ({ href, children }: any) => fragment("[", children, "](", href, ")"),
  br: () => fragment("\n"),
  img: ({ alt, src }: any) => fragment("![", alt ?? "", "](", src, ")"),
  table: ({ children }: any) => fragment(children, "\n"),
  thead: ({ children }: any) => fragment(children),
  tbody: ({ children }: any) => fragment(children),
  tr: ({ children }: any) => fragment("| ", children, "\n"),
  th: ({ children }: any) => fragment(children, " | "),
  td: ({ children }: any) => fragment(children, " | "),
  div: ({ children }: any) => fragment(children, "\n"),
  section: ({ children }: any) => fragment(children, "\n"),
  span: ({ children }: any) => fragment(children),
};
