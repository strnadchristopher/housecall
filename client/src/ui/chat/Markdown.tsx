import type { ReactNode } from "react";
import type { MarkdownNode } from "../../core/markdown";

/**
 * Renders the inert markdown tree as React elements. No HTML strings, no
 * images, links only when the tree carries a validated https href.
 */
const MENTION = /(^|[^\w@])(@everyone|@here|@[A-Za-z0-9_-]{2,32})(?![\w-])/g;

function Mentions({ text, me }: { text: string; me?: string }): ReactNode {
  if (!text.includes("@")) return text;
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(MENTION)) {
    const start = (match.index ?? 0) + match[1].length;
    if (start > last) out.push(text.slice(last, start));
    const tag = match[2];
    const self = tag === "@everyone" || tag === "@here" || (!!me && tag.slice(1).toLowerCase() === me.toLowerCase());
    out.push(<span key={start} className={self ? "hc-mention is-me" : "hc-mention"}>{tag}</span>);
    last = start + tag.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Inline({ nodes, me }: { nodes?: MarkdownNode[]; me?: string }): ReactNode {
  return (nodes ?? []).map((node, index) => <Node key={index} node={node} me={me} inline />);
}

function Node({ node, me, inline }: { node: MarkdownNode; me?: string; inline?: boolean }): ReactNode {
  switch (node.kind) {
    case "text": return <Mentions text={node.text ?? ""} me={me} />;
    case "paragraph": return inline ? <Inline nodes={node.children} me={me} /> : <p><Inline nodes={node.children} me={me} /></p>;
    case "strong": return <strong><Inline nodes={node.children} me={me} /></strong>;
    case "emphasis": return <em><Inline nodes={node.children} me={me} /></em>;
    case "strike": return <s><Inline nodes={node.children} me={me} /></s>;
    case "inline-code": return <code>{node.text}</code>;
    case "code": return <pre><code>{node.text}</code></pre>;
    case "heading": return <p className="hc-md__h"><Inline nodes={node.children} me={me} /></p>;
    case "quote": return <blockquote>{(node.children ?? []).map((child, index) => <Node key={index} node={child} me={me} />)}</blockquote>;
    case "list": {
      const items = (node.children ?? []).map((child, index) => <li key={index}>{(child.children ?? []).map((inner, at) => <Node key={at} node={inner} me={me} inline />)}</li>);
      return node.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
    }
    case "list-item": return <Inline nodes={node.children} me={me} />;
    case "link": return node.href
      ? <a href={node.href} target="_blank" rel="noopener noreferrer nofollow"><Inline nodes={node.children} me={me} /></a>
      : <span><Inline nodes={node.children} me={me} /></span>;
    case "break": return inline ? <br /> : null;
    default: return null;
  }
}

export function MessageBody({ nodes, text, me }: { nodes: MarkdownNode[]; text: string; me?: string }) {
  if (!nodes.length) return <div className="hc-md"><p><Mentions text={text} me={me} /></p></div>;
  if (nodes.length === 1 && nodes[0].kind === "paragraph") return <div className="hc-md"><p><Inline nodes={nodes[0].children} me={me} /></p></div>;
  return <div className="hc-md">{nodes.map((node, index) => <Node key={index} node={node} me={me} />)}</div>;
}
