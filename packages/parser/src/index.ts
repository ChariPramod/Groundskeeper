import { createHash } from "node:crypto";
import type { Claim } from "@groundskeeper/contracts";
import GithubSlugger from "github-slugger";
import type { Root, RootContent } from "mdast";
import { toString as nodeText } from "mdast-util-to-string";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";

type Node = Root | RootContent;
type Reference = NonNullable<Claim["references"]>[number];

function references(node: Node, definitions: Map<string, string>): Reference[] {
  const found = new Map<string, Reference>();
  const add = (kind: Reference["kind"], value: string) => {
    if (value) found.set(`${kind}:${value}`, { kind, value });
  };
  function walk(current: Node) {
    if (current.type === "link" || current.type === "image") {
      add(/^[a-z][a-z\d+.-]*:/i.test(current.url) ? "url" : "path", current.url);
    }
    if (current.type === "linkReference" || current.type === "imageReference") {
      const url = definitions.get(current.identifier.toUpperCase());
      if (url) add(/^[a-z][a-z\d+.-]*:/i.test(url) ? "url" : "path", url);
    }
    if (current.type === "inlineCode" || current.type === "code") {
      for (const match of current.value.matchAll(/--[a-zA-Z][\w-]*/g)) add("flag", match[0]);
      for (const match of current.value.matchAll(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g)) {
        add("identifier", match[0]);
      }
    }
    if ("children" in current) for (const child of current.children) walk(child as Node);
  }
  walk(node);
  return [...found.values()];
}

/** Parse syntax only. MDX expressions/imports are never evaluated. */
export function extractClaims(source: string, page: string): Claim[] {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter);
  const tree = /\.mdx$/i.test(page)
    ? processor.use(remarkMdx).parse(source)
    : processor.parse(source);
  const claims: Claim[] = [];
  const slugs = new GithubSlugger();
  const occurrences = new Map<string, number>();
  const definitions = new Map<string, string>();
  for (const node of tree.children) {
    if (node.type === "definition") definitions.set(node.identifier.toUpperCase(), node.url);
  }
  let anchor = "";

  function visit(node: Node, siblings: readonly Node[] = [], index = 0) {
    if (node.type === "heading") anchor = slugs.slug(nodeText(node));
    const kind =
      node.type === "paragraph"
        ? node.children.length === 1 && node.children[0]?.type === "image"
          ? "image"
          : "paragraph"
        : node.type === "code"
          ? "code"
          : node.type === "tableRow"
            ? "table_row"
            : undefined;
    if (kind && node.position) {
      const metadata = node.type === "code" ? (node.meta?.split(/\s+/) ?? []) : [];
      const runnable = node.type === "code" && metadata.includes("groundskeeper:run");
      const sessionMarkers = metadata.filter((token) => token.startsWith("groundskeeper:session"));
      let session: string | null = null;
      if (sessionMarkers.length) {
        const match = sessionMarkers[0]?.match(
          /^groundskeeper:session=([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/,
        );
        if (sessionMarkers.length !== 1 || !match) {
          throw new Error(
            `Invalid groundskeeper:session metadata at ${page}:${node.position.start.line}`,
          );
        }
        if (node.type !== "code" || !runnable || !["python", "py"].includes(node.lang ?? "")) {
          throw new Error(
            `Tutorial sessions require a python/py groundskeeper:run fence at ${page}:${node.position.start.line}`,
          );
        }
        session = match[1] ?? null;
      }
      // Output fences are evidence for the preceding block, not executable claims.
      if (node.type === "code" && node.lang === "output") return;
      const text = node.type === "code" ? node.value : nodeText(node);
      const next = siblings[index + 1];
      const language = node.type === "code" ? (node.lang ?? null) : null;
      const expectedOutput =
        node.type === "code" && next?.type === "code" && next.lang === "output" ? next.value : null;
      const claimReferences = references(node, definitions);
      // Identity includes the assertion's targets and execution contract, not just display text.
      const identity = JSON.stringify([
        page,
        anchor,
        kind,
        text,
        claimReferences,
        language,
        runnable,
        expectedOutput,
        ...(session === null ? [] : [session]),
      ]);
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      claims.push({
        id: createHash("sha256").update(`${identity}\0${occurrence}`).digest("hex"),
        page,
        anchor,
        kind,
        text,
        position: {
          start_line: node.position.start.line,
          start_column: node.position.start.column,
          end_line: node.position.end.line,
          end_column: node.position.end.column,
        },
        references: claimReferences,
        language,
        runnable,
        session,
        expected_output: expectedOutput,
        status: "unknown",
        last_verified: null,
        verification_method: null,
      });
      return; // A paragraph/table row owns its inline children; avoid duplicate claims.
    }
    if ("children" in node) {
      const children = node.children as Node[];
      children.forEach((child, i) => {
        visit(child, children, i);
      });
    }
  }
  visit(tree);
  return claims;
}
