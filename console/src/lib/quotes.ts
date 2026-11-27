// Pure helpers for quoting messages, reports, or selected text into Project & Task composers.
export interface ComposerQuote {
  id: string;
  source: string;
  excerpt: string;
}

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

export function formatQuotesPrefix(quotes: readonly ComposerQuote[]): string {
  if (quotes.length === 0) return '';
  return quotes
    .map((quote) => {
      const label = quote.source.trim();
      const lines = trimQuoteExcerpt(quote.excerpt).split('\n');
      const quotedLines = lines.map((line, index) => (
        index === 0 && label ? `> **[${label}]** ${line}` : `> ${line}`
      ));
      return quotedLines.join('\n');
    })
    .join('\n\n');
}

export function composeWithQuotes(text: string, quotes: readonly ComposerQuote[]): string {
  const prefix = formatQuotesPrefix(quotes);
  const body = text.trim();
  if (!prefix) return text;
  if (!body) return prefix;
  return `${prefix}\n\n${text}`;
}
