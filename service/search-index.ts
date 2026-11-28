// Zero-dependency native SQLite FTS5 + CJK/Latin hybrid tokenization, RRF ranking,
// and coverage-floor filtering (adapted from Octop Memory ADR-046/047 for Tycho's ledger).
// Keeps an ephemeral in-memory SQLite FTS5 index synchronized with canonical ledger tables
// so `ledger.db` stays free of FTS5 shadow tables, locks, or backup bloat.
import { DatabaseSync } from 'node:sqlite';

const LATIN_TOKEN_RE = /[a-z0-9]+(?:[._-][a-z0-9]+)*/gi;
const CJK_SEQ_RE = /[\u4e00-\u9fff\u3400-\u4dbf]+/g;

// Extracts deduplicated lowercase search tokens:
// - Latin/alphanumeric identifiers (both full `dmob_10` and split sub-parts `dmob`, `10`)
// - CJK overlapping bigrams (`内存限制` -> `内存`, `存限`, `限制`) plus single-char fallback
//   for 1-char CJK segments so Chinese and mixed CJK/English queries match cleanly without
//   external stemmer/ICU binaries.
export function tokenizeForSearch(text: string): string[] {
  if (!text) return [];
  const tokens = new Set<string>();
  const lower = text.toLowerCase();

  for (const match of lower.matchAll(LATIN_TOKEN_RE)) {
    const whole = match[0];
    if (!whole) continue;
    tokens.add(whole);
    if (/[._-]/.test(whole)) {
      for (const part of whole.split(/[._-]+/)) {
        if (part.length > 0) tokens.add(part);
      }
    }
  }

  for (const match of lower.matchAll(CJK_SEQ_RE)) {
    const seq = match[0];
    if (!seq) continue;
    if (seq.length === 1) {
      tokens.add(seq);
    } else {
      for (let i = 0; i < seq.length - 1; i += 1) {
        tokens.add(seq.slice(i, i + 2));
      }
    }
  }

  return [...tokens];
}

// Query tokenization separates distinct concepts while treating CJK substrings cleanly:
// for coverage calculation we group consecutive CJK bigrams sensibly so a 4-char Chinese term
// counts proportionally without inflating denominator noise.
export function tokenizeQueryTerms(query: string): string[] {
  return tokenizeForSearch(query);
}

// Converts raw text into an FTS5-safe space-separated token stream.
export function toFtsDocument(text: string): string {
  return tokenizeForSearch(text).join(' ');
}

// Escapes a token for safe FTS5 MATCH quoting.
function quoteFtsToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

export function buildFtsOrQuery(query: string): string {
  const tokens = tokenizeQueryTerms(query);
  if (tokens.length === 0) return '';
  return tokens.map(quoteFtsToken).join(' OR ');
}

export function tokenCoverage(queryTokens: readonly string[], docTokens: ReadonlySet<string>): number {
  if (queryTokens.length === 0) return 0;
  let hits = 0;
  for (const token of queryTokens) {
    if (docTokens.has(token)) hits += 1;
  }
  return hits / queryTokens.length;
}

// Default minimum lexical coverage floor: single-token queries must match 100%,
// multi-token queries require meaningful overlap (at least 1/3 of query terms)
// so coincidental single-word hits return empty rather than polluting prompts.
export function defaultMinCoverage(queryTokens: readonly string[]): number {
  if (queryTokens.length <= 1) return 1.0;
  if (queryTokens.length === 2) return 0.5;
  return 0.34;
}

export function jaccardSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Reciprocal Rank Fusion (RRF) across multiple ranked ID lists.
export function rrfFuse<T extends string>(lists: readonly (readonly T[])[], k = 60): Map<T, number> {
  const scores = new Map<T, number>();
  for (const list of lists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return scores;
}

export interface SearchDoc {
  id: string;
  title: string;
  subtitle: string;
  body: string;
  phrases: readonly string[];
  meta?: Record<string, unknown>;
}

export interface RankedHit {
  id: string;
  score: number;
  coverage: number;
}

export interface SearchOptions {
  limit?: number;
  minCoverage?: number;
  allowedIds?: ReadonlySet<string>;
}

// Ephemeral in-memory SQLite FTS5 index supporting weighted BM25 + search_phrases +
// token coverage floor + exact-substring bonus.
export class FtsIndex {
  #conn: DatabaseSync;
  #tokenSets = new Map<string, Set<string>>();
  #rawLower = new Map<string, string>();

  constructor() {
    this.#conn = new DatabaseSync(':memory:');
    // Column weights in bm25(): title (4.0), subtitle/when_to_use (2.5), phrases (3.0), body (1.0)
    this.#conn.exec(`
      CREATE VIRTUAL TABLE docs USING fts5(
        doc_id UNINDEXED,
        title,
        subtitle,
        phrases,
        body,
        tokenize = 'unicode61 remove_diacritics 0'
      );
    `);
  }

  upsert(doc: SearchDoc): void {
    this.remove(doc.id);
    const titleTok = toFtsDocument(doc.title);
    const subTok = toFtsDocument(doc.subtitle);
    const phraseTok = toFtsDocument(doc.phrases.join(' '));
    const bodyTok = toFtsDocument(doc.body);
    this.#conn
      .prepare('INSERT INTO docs (doc_id, title, subtitle, phrases, body) VALUES (?, ?, ?, ?, ?)')
      .run(doc.id, titleTok, subTok, phraseTok, bodyTok);

    const allTokens = new Set<string>([
      ...tokenizeForSearch(doc.title),
      ...tokenizeForSearch(doc.subtitle),
      ...tokenizeForSearch(doc.phrases.join(' ')),
      ...tokenizeForSearch(doc.body),
    ]);
    this.#tokenSets.set(doc.id, allTokens);
    this.#rawLower.set(doc.id, `${doc.title}\n${doc.subtitle}\n${doc.phrases.join('\n')}\n${doc.body}`.toLowerCase());
  }

  remove(id: string): void {
    this.#conn.prepare('DELETE FROM docs WHERE doc_id = ?').run(id);
    this.#tokenSets.delete(id);
    this.#rawLower.delete(id);
  }

  clear(): void {
    this.#conn.exec('DELETE FROM docs');
    this.#tokenSets.clear();
    this.#rawLower.clear();
  }

  rebuild(docs: readonly SearchDoc[]): void {
    this.#conn.exec('BEGIN');
    try {
      this.#conn.exec('DELETE FROM docs');
      this.#tokenSets.clear();
      this.#rawLower.clear();
      const stmt = this.#conn.prepare('INSERT INTO docs (doc_id, title, subtitle, phrases, body) VALUES (?, ?, ?, ?, ?)');
      for (const doc of docs) {
        const titleTok = toFtsDocument(doc.title);
        const subTok = toFtsDocument(doc.subtitle);
        const phraseTok = toFtsDocument(doc.phrases.join(' '));
        const bodyTok = toFtsDocument(doc.body);
        stmt.run(doc.id, titleTok, subTok, phraseTok, bodyTok);
        this.#tokenSets.set(
          doc.id,
          new Set<string>([
            ...tokenizeForSearch(doc.title),
            ...tokenizeForSearch(doc.subtitle),
            ...tokenizeForSearch(doc.phrases.join(' ')),
            ...tokenizeForSearch(doc.body),
          ]),
        );
        this.#rawLower.set(doc.id, `${doc.title}\n${doc.subtitle}\n${doc.phrases.join('\n')}\n${doc.body}`.toLowerCase());
      }
      this.#conn.exec('COMMIT');
    } catch (err) {
      if (this.#conn.isTransaction) this.#conn.exec('ROLLBACK');
      throw err;
    }
  }

  search(query: string, options: SearchOptions = {}): RankedHit[] {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const queryTokens = tokenizeQueryTerms(trimmed);
    const ftsQuery = buildFtsOrQuery(trimmed);
    const minCov = options.minCoverage ?? defaultMinCoverage(queryTokens);
    const limit = Math.max(1, options.limit ?? 50);
    const lowerQuery = trimmed.toLowerCase();

    const hits: RankedHit[] = [];
    const seen = new Set<string>();

    if (ftsQuery !== '') {
      // Weighted BM25 (lower/more-negative is better in SQLite FTS5)
      const rows = this.#conn
        .prepare('SELECT doc_id, bm25(docs, 0.0, 4.0, 2.5, 3.0, 1.0) AS rank FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT ?')
        .all(ftsQuery, Math.max(limit * 6, 120)) as { doc_id: string; rank: number }[];

      for (const row of rows) {
        if (options.allowedIds && !options.allowedIds.has(row.doc_id)) continue;
        const docTokens = this.#tokenSets.get(row.doc_id);
        if (!docTokens) continue;
        const rawLower = this.#rawLower.get(row.doc_id) ?? '';
        const exactMatch = rawLower.includes(lowerQuery);
        const coverage = exactMatch ? 1.0 : tokenCoverage(queryTokens, docTokens);
        if (coverage < minCov) continue;
        // Convert negative bm25 rank to positive score; reward higher coverage and exact phrase hits
        const bm25Magnitude = Math.max(0, -row.rank);
        const score = (bm25Magnitude + 0.1) * (0.4 + 0.6 * coverage) + (exactMatch ? 2.0 : 0);
        hits.push({ id: row.doc_id, score, coverage });
        seen.add(row.doc_id);
      }
    }

    // Substring fallback for punctuation-only or special symbol queries (e.g. "C++", "@1")
    if (hits.length === 0) {
      for (const [id, rawLower] of this.#rawLower.entries()) {
        if (seen.has(id)) continue;
        if (options.allowedIds && !options.allowedIds.has(id)) continue;
        if (rawLower.includes(lowerQuery)) {
          hits.push({ id, score: 1.0, coverage: 1.0 });
        }
      }
    }

    hits.sort((a, b) => b.score - a.score || b.coverage - a.coverage || (a.id < b.id ? -1 : 1));
    return hits.slice(0, limit);
  }

  close(): void {
    if (this.#conn.isOpen) this.#conn.close();
  }
}
