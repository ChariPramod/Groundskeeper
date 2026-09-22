import { describe, expect, it } from "vitest";
import { extractClaims } from "./index.js";

describe("claim extraction", () => {
  it("preserves standalone claim IDs when session metadata is absent", () => {
    const claim = extractClaims("```python groundskeeper:run\nprint(1)\n```", "guide.md")[0];
    expect(claim?.session).toBeNull();
    expect(claim?.id).toBe("832c9df7924853e3945546ebdd1733acaa0b71c973639f5ce3ce6562a02df783");
  });
  it("extracts opt-in Python tutorial sessions and includes them in identity", () => {
    const source = (session: string, language = "python") =>
      `\`\`\`${language} groundskeeper:run groundskeeper:session=${session}\nprint(1)\n\`\`\``;
    const first = extractClaims(source("setup-1"), "guide.md")[0];
    expect(first).toMatchObject({ session: "setup-1", runnable: true, language: "python" });
    expect(extractClaims(source("setup_2", "py"), "guide.md")[0]?.session).toBe("setup_2");
    expect(first?.id).not.toBe(extractClaims(source("setup-2"), "guide.md")[0]?.id);
    expect(first?.id).not.toBe(extractClaims(source("setup-1"), "other.md")[0]?.id);
    expect(extractClaims(source("a".repeat(64)), "guide.md")[0]?.session).toBe("a".repeat(64));
  });
  it.each([
    "python groundskeeper:session=setup",
    "sh groundskeeper:run groundskeeper:session=setup",
    "output groundskeeper:run groundskeeper:session=setup",
    "python groundskeeper:run groundskeeper:session",
    "python groundskeeper:run groundskeeper:session=",
    "python groundskeeper:run groundskeeper:session=-setup",
    "python groundskeeper:run groundskeeper:session=setup.one",
    `python groundskeeper:run groundskeeper:session=${"a".repeat(65)}`,
    "python groundskeeper:run groundskeeper:session=setup groundskeeper:session=setup",
  ])("rejects invalid session fence metadata: %s", (metadata) => {
    expect(() => extractClaims(`\`\`\`${metadata}\nprint(1)\n\`\`\``, "guide.md")).toThrow(
      /guide.md:1/,
    );
  });
  it("changes IDs when link targets or the execution contract change", () => {
    const id = (text: string) => extractClaims(text, "guide.md")[0]?.id;
    expect(id("Read [guide](old.md).")).not.toBe(id("Read [guide](new.md)."));
    expect(id("```python\nprint(1)\n```")).not.toBe(
      id("```python groundskeeper:run\nprint(1)\n```"),
    );
    expect(id("```python\nprint(1)\n```\n\n```output\n1\n```")).not.toBe(
      id("```python\nprint(1)\n```\n\n```output\n2\n```"),
    );
    expect(id("```python\nprint(1)\n```")).not.toBe(id("```sh\nprint(1)\n```"));
  });
  it("tracks anchors, duplicate headings, lists and source positions", () => {
    const claims = extractClaims(
      "# Setup\n\nUse `Client`.\n\n# Setup\n\n1. Run `start`.\n",
      "guide.md",
    );
    expect(claims.map((claim) => claim.anchor)).toEqual(["setup", "setup-1"]);
    expect(claims[1]?.position.start_line).toBe(7);
    expect(claims[0]?.references).toContainEqual({ kind: "identifier", value: "Client" });
  });
  it("requires explicit execution opt-in and attaches output fences", () => {
    const claims = extractClaims(
      "```python groundskeeper:run\nprint('hello')\n```\n\n```output\nhello\n```\n\n```sh\nrm -rf /\n```",
      "readme.md",
    );
    expect(claims).toHaveLength(2);
    expect(claims[0]).toMatchObject({
      runnable: true,
      expected_output: "hello",
      status: "unknown",
    });
    expect(claims[1]?.runnable).toBe(false);
  });
  it("parses MDX wrappers without evaluating expressions and skips frontmatter", () => {
    const claims = extractClaims(
      "---\ntitle: Intro\n---\n\nimport X from './x'\n\n<Note>\n\nUse `Client`.\n\n</Note>\n",
      "guide.mdx",
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]?.text).toBe("Use Client.");
  });
  it("extracts tables, images, reference links and CLI flags", () => {
    const claims = extractClaims(
      "| Flag | Default |\n| --- | --- |\n| `--port` | 3000 |\n\n![UI](ui.png)\n\nRead [guide][g].\n\n[g]: https://example.com\n",
      "guide.md",
    );
    expect(claims.map((claim) => claim.kind)).toEqual([
      "table_row",
      "table_row",
      "image",
      "paragraph",
    ]);
    expect(claims[1]?.references).toContainEqual({ kind: "flag", value: "--port" });
    expect(claims[3]?.references).toContainEqual({ kind: "url", value: "https://example.com" });
  });
  it("keeps IDs stable across unrelated line insertion and unique for repeated claims", () => {
    const a = extractClaims("# A\n\nUse `run`.\n\nUse `run`.", "a.md");
    const b = extractClaims("\n\n# A\n\nUse `run`.\n\nUse `run`.", "a.md");
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
    expect(new Set(a.map((c) => c.id)).size).toBe(2);
  });
});
