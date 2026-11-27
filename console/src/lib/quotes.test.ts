import { describe, expect, test } from 'vitest';
import {
  composeWithQuotes,
  formatQuotesPrefix,
  hasQuoteContent,
  parseQuotedSegments,
  trimQuoteExcerpt,
} from './quotes';

describe('paired quote-reply serialization and parsing', () => {
  test('trimQuoteExcerpt normalizes whitespace and truncates overlong selections cleanly', () => {
    expect(trimQuoteExcerpt('  hello\r\n\r\n\r\nworld  ')).toBe('hello\n\nworld');
    expect(trimQuoteExcerpt('   ')).toBe('');
    const huge = 'x'.repeat(1000);
    const trimmed = trimQuoteExcerpt(huge, 40);
    expect(trimmed.length).toBe(40);
    expect(trimmed.endsWith('…')).toBe(true);
  });

  test('formatQuotesPrefix builds compact Markdown blockquotes preserving newlines and semantic sourceKey', () => {
    const mockT = (key: string) => (key === 'quote.source.router' ? 'Router' : key === 'quote.source.report' ? 'Report' : key);
    const prefix = formatQuotesPrefix([
      { id: 'q1', source: '负责人', sourceKey: 'router', excerpt: '第一行\n第二行' },
      { id: 'q2', source: '汇报', sourceKey: 'report', excerpt: '结论 A' },
    ], mockT);
    expect(prefix).toBe('> **[Router]** 第一行\n> 第二行\n\n> **[Report]** 结论 A');
  });

  test('single quote with no inline reply pairs directly with main composer text', () => {
    const quotes = [{ id: 'q1', source: '负责人', excerpt: 'P50 延迟 9.4ms' }];
    expect(composeWithQuotes('这个数字是怎么测的？', quotes)).toBe(
      '> **[负责人]** P50 延迟 9.4ms\n\n这个数字是怎么测的？',
    );
    expect(composeWithQuotes('   ', quotes)).toBe('> **[负责人]** P50 延迟 9.4ms');
    expect(composeWithQuotes('普通消息', [])).toBe('普通消息');
  });

  test('multiple quotes serialize strictly interleaved with each paired reply plus optional overall note', () => {
    const quotes = [
      { id: 'q1', source: 'Router', excerpt: '对外资产命名用哪套？', reply: '11 — 选 acme_market_data.dmob_10' },
      { id: 'q2', source: 'Router', excerpt: 'dmob_10 每日对账是否拆分独立任务？', reply: '22 — 拆成独立任务' },
    ];
    expect(composeWithQuotes('', quotes)).toBe(
      '> **[Router]** 对外资产命名用哪套？\n\n11 — 选 acme_market_data.dmob_10\n\n> **[Router]** dmob_10 每日对账是否拆分独立任务？\n\n22 — 拆成独立任务',
    );
    expect(composeWithQuotes('其余按计划推进。', quotes)).toBe(
      '> **[Router]** 对外资产命名用哪套？\n\n11 — 选 acme_market_data.dmob_10\n\n> **[Router]** dmob_10 每日对账是否拆分独立任务？\n\n22 — 拆成独立任务\n\n其余按计划推进。',
    );
    expect(hasQuoteContent('', quotes)).toBe(true);
    expect(hasQuoteContent('   ', [])).toBe(false);
  });

  test('parseQuotedSegments cleanly reconstructs paired quote-reply blocks for sent message bubbles', () => {
    const sent = '> **[Router]** 资产命名方案\n> 第二行补充\n\n选方案 A\n\n> **[Router]** 对账调度\n\n拆成独立任务';
    expect(parseQuotedSegments(sent)).toEqual([
      { kind: 'quote', source: 'Router', excerpt: '资产命名方案\n第二行补充' },
      { kind: 'text', text: '选方案 A' },
      { kind: 'quote', source: 'Router', excerpt: '对账调度' },
      { kind: 'text', text: '拆成独立任务' },
    ]);
    expect(parseQuotedSegments('普通无引用消息')).toEqual([
      { kind: 'text', text: '普通无引用消息' },
    ]);
  });
});
