// Pure helpers for paired quote-reply cards and rendered quote blocks in Project & Task composers.
export type QuoteSourceKey = 'router' | 'owner' | 'report' | 'worker' | 'followup' | 'sideAsk';

export interface ComposerQuote {
  id: string;
  source: string;
  sourceKey?: QuoteSourceKey | undefined;
  excerpt: string;
  reply?: string | undefined;
}

export type QuotedSegment =
  | { kind: 'quote'; source: string | null; excerpt: string }
  | { kind: 'text'; text: string };

export const MAX_COMPOSER_QUOTES = 6;
const MAX_QUOTE_EXCERPT_CHARS = 800;

export function trimQuoteExcerpt(raw: string, maxChars = MAX_QUOTE_EXCERPT_CHARS): string {
  const normalized = raw
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

export function resolveQuoteSource(
  quote: Pick<ComposerQuote, 'source' | 'sourceKey'>,
  translate?: (key: string) => string,
): string {
  if (quote.sourceKey && translate) {
    const key = `quote.source.${quote.sourceKey}`;
    const resolved = translate(key);
    if (resolved && resolved !== key) return resolved;
  }
  return quote.source.trim();
}

export function formatSingleQuote(
  quote: Pick<ComposerQuote, 'source' | 'sourceKey' | 'excerpt'>,
  translate?: (key: string) => string,
): string {
  const label = resolveQuoteSource(quote, translate);
  const lines = trimQuoteExcerpt(quote.excerpt).split('\n');
  return lines
    .map((line, index) => (index === 0 && label ? `> **[${label}]** ${line}` : `> ${line}`))
    .join('\n');
}

export function formatQuotesPrefix(
  quotes: readonly ComposerQuote[],
  translate?: (key: string) => string,
): string {
  if (quotes.length === 0) return '';
  return quotes.map((quote) => formatSingleQuote(quote, translate)).join('\n\n');
}

export function hasQuoteContent(text: string, quotes: readonly ComposerQuote[]): boolean {
  if (text.trim() !== '') return true;
  return quotes.length > 0;
}

// Serializes quotes and replies with strict 1-to-1 pairing:
// - Single quote with no inline reply pairs directly with the main composer text.
// - Multiple quotes (or any quote carrying its own inline reply) emit strictly interleaved
//   `Quote 1 -> Reply 1 -> Quote 2 -> Reply 2` blocks, followed by any optional overall note.
export function composeWithQuotes(
  text: string,
  quotes: readonly ComposerQuote[],
  translate?: (key: string) => string,
): string {
  if (quotes.length === 0) return text;
  const body = text.trim();

  if (quotes.length === 1 && !(quotes[0]!.reply ?? '').trim()) {
    const prefix = formatSingleQuote(quotes[0]!, translate);
    return body ? `${prefix}\n\n${text}` : prefix;
  }

  const sections: string[] = [];
  for (const quote of quotes) {
    const block = formatSingleQuote(quote, translate);
    const inlineReply = (quote.reply ?? '').trim();
    sections.push(inlineReply ? `${block}\n\n${inlineReply}` : block);
  }
  if (body) sections.push(body);
  return sections.join('\n\n');
}

const QUOTE_SOURCE_RE = /^\*\*\[([^\]]+)\]\*\*\s*(.*)$/;

// Parses outgoing messages containing Markdown `> **[Source]** ...` blocks into structured
// alternating quote/reply segments so sent bubbles visually bind each quote to its reply.
export function parseQuotedSegments(raw: string): QuotedSegment[] {
  const normalized = raw.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const segments: QuotedSegment[] = [];
  let i = 0;

  while (i < lines.length) {
    if (lines[i]!.startsWith('>')) {
      const qLines: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('>')) {
        qLines.push(lines[i]!.replace(/^>\s?/, ''));
        i += 1;
      }
      let source: string | null = null;
      if (qLines.length > 0) {
        const match = QUOTE_SOURCE_RE.exec(qLines[0]!);
        if (match) {
          source = match[1]!.trim() || null;
          qLines[0] = match[2] ?? '';
        }
      }
      const excerpt = qLines.join('\n').trim();
      if (excerpt || source) {
        segments.push({ kind: 'quote', source, excerpt });
      }
      // Consume single blank separator line between quote block and its reply.
      while (i < lines.length && lines[i]!.trim() === '') i += 1;
    } else {
      const tLines: string[] = [];
      while (i < lines.length && !lines[i]!.startsWith('>')) {
        tLines.push(lines[i]!);
        i += 1;
      }
      const text = tLines.join('\n').trim();
      if (text) {
        segments.push({ kind: 'text', text });
      }
    }
  }

  return segments;
}
