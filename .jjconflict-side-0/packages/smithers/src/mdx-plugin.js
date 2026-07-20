import { plugin } from "bun";
import mdx from "@mdx-js/esbuild";
export function mdxPlugin() {
    plugin(mdx());
}
