import { marked, type Token } from "marked";
/** A renderer must create semantic nodes from this AST; never pass text to innerHTML. */
export interface MarkdownNode {
  kind:
    | "text"
    | "paragraph"
    | "strong"
    | "emphasis"
    | "strike"
    | "inline-code"
    | "code"
    | "heading"
    | "quote"
    | "list"
    | "list-item"
    | "link"
    | "break"
    | "rule";
  text?: string;
  children?: MarkdownNode[];
  href?: string;
  level?: number;
  ordered?: boolean;
  language?: string;
}
function safeHref(raw: string) {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
export function markdownTokens(source: string): MarkdownNode[] {
  if (new TextEncoder().encode(source).length > 16384)
    throw new Error("Message exceeds 16 KiB");
  const walk = (tokens: Token[], depth = 0): MarkdownNode[] =>
    tokens.map((token) => {
      const text = (value: string): MarkdownNode => ({
        kind: "text",
        text: value,
      });
      if (depth > 32) return text(token.raw);
      const children = () =>
        walk(
          "tokens" in token && Array.isArray(token.tokens) ? token.tokens : [],
          depth + 1,
        );
      switch (token.type) {
        case "space":
          return { kind: "break" };
        case "paragraph":
          return { kind: "paragraph", children: children() };
        case "strong":
          return { kind: "strong", children: children() };
        case "em":
          return { kind: "emphasis", children: children() };
        case "del":
          return { kind: "strike", children: children() };
        case "codespan":
          return { kind: "inline-code", text: token.text };
        case "code":
          return {
            kind: "code",
            text: token.text,
            language: token.lang?.split(/\s/)[0],
          };
        case "heading":
          return {
            kind: "heading",
            level: Math.max(1, Math.min(6, token.depth)),
            children: children(),
          };
        case "blockquote":
          return { kind: "quote", children: children() };
        case "list":
          return {
            kind: "list",
            ordered: token.ordered,
            children: token.items.map((item: { tokens: Token[] }) => ({
              kind: "list-item" as const,
              children: walk(item.tokens, depth + 1),
            })),
          };
        case "link":
          return {
            kind: "link",
            href: safeHref(token.href),
            children: children(),
          };
        case "br":
          return { kind: "break" };
        case "hr":
          return { kind: "rule" };
        case "image":
          return text(token.text);
        case "text":
          return "tokens" in token && token.tokens
            ? { kind: "paragraph", children: children() }
            : text(token.text);
        default:
          return text(token.raw);
      }
    });
  return walk(marked.lexer(source, { gfm: true }));
}
