import type { ReactNode } from 'react';
import type { MarkdownNode } from '../../data/markdown';

/**
 * Renders engineering's inert markdown AST (data/markdown.ts) as React
 * elements. No HTML strings, no images, links only when the AST carries a
 * validated https href. Text content equals the source text for plain
 * messages, which the E2E suite relies on.
 */

const MENTION = /(^|[^\w@])(@everyone|@here|@[A-Za-z0-9_-]{2,32})(?![\w-])/g;

function Mentions({ text, me }: { text: string; me?: string }): ReactNode {
  if (!text.includes('@')) return text;
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION)) {
    const start = (m.index ?? 0) + m[1].length;
    if (start > last) out.push(text.slice(last, start));
    const tag = m[2];
    const self = tag === '@everyone' || tag === '@here' || (me && tag.slice(1).toLowerCase() === me.toLowerCase());
    out.push(<span key={start} className={`cc-mention${self ? ' is-me' : ''}`}>{tag}</span>);
    last = start + tag.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Inline({ nodes, me }: { nodes?: MarkdownNode[]; me?: string }): ReactNode {
  return (nodes ?? []).map((n, i) => <Node key={i} n={n} me={me} inline />);
}

function Node({ n, me, inline }: { n: MarkdownNode; me?: string; inline?: boolean }): ReactNode {
  switch (n.kind) {
    case 'text': return <Mentions text={n.text ?? ''} me={me} />;
    case 'paragraph': return inline ? <Inline nodes={n.children} me={me} /> : <p><Inline nodes={n.children} me={me} /></p>;
    case 'strong': return <strong><Inline nodes={n.children} me={me} /></strong>;
    case 'emphasis': return <em><Inline nodes={n.children} me={me} /></em>;
    case 'strike': return <s className="cc-strike"><Inline nodes={n.children} me={me} /></s>;
    case 'inline-code': return <code className="cc-code">{n.text}</code>;
    case 'code': return <pre className="cc-pre" data-lang={n.language || undefined}><code>{n.text}</code></pre>;
    case 'heading': return <p className={`cc-h cc-h--${Math.min(3, n.level ?? 1)}`}><Inline nodes={n.children} me={me} /></p>;
    case 'quote': return <blockquote className="cc-quote">{(n.children ?? []).map((c, i) => <Node key={i} n={c} me={me} />)}</blockquote>;
    case 'list': {
      const items = (n.children ?? []).map((c, i) => <li key={i}>{(c.children ?? []).map((cc, j) => <Node key={j} n={cc} me={me} inline />)}</li>);
      return n.ordered ? <ol className="cc-ol">{items}</ol> : <ul className="cc-ul">{items}</ul>;
    }
    case 'list-item': return <Inline nodes={n.children} me={me} />;
    case 'link': return n.href
      ? <a className="cc-link" href={n.href} target="_blank" rel="noopener noreferrer nofollow">{<Inline nodes={n.children} me={me} />}</a>
      : <span className="cc-link is-inert"><Inline nodes={n.children} me={me} /></span>;
    case 'break': return inline ? <br /> : null;
    case 'rule': return <span className="cc-rule" role="separator" />;
    default: return null;
  }
}

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\s)+$/u;

export function MessageBody({ nodes, text, me }: { nodes?: MarkdownNode[]; text: string; me?: string }) {
  if (text.length <= 12 && EMOJI_ONLY.test(text) && /\p{Extended_Pictographic}/u.test(text)) return <div className="cc-body cc-body--jumbo">{text}</div>;
  if (!nodes?.length) return <div className="cc-body"><p><Mentions text={text} me={me} /></p></div>;
  // A single paragraph renders inline so plain messages stay one text run.
  if (nodes.length === 1 && nodes[0].kind === 'paragraph') return <div className="cc-body"><p><Inline nodes={nodes[0].children} me={me} /></p></div>;
  return <div className="cc-body">{nodes.map((n, i) => <Node key={i} n={n} me={me} />)}</div>;
}

export function plainText(nodes?: MarkdownNode[]): string {
  if (!nodes) return '';
  return nodes.map(n => n.text ?? plainText(n.children)).join('');
}

/** Plain-text excerpt for replies, notifications and search. */
export function excerpt(body: string | undefined, n = 90) {
  const s = (body ?? '').replace(/```[\s\S]*?```/g, '[code]').replace(/[*_~`>]/g, '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
