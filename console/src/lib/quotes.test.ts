import { describe, expect, test } from 'vitest';
import { composeWithQuotes, formatQuotesPrefix, trimQuoteExcerpt } from './quotes';

describe('composer quotes formatting', () => {
  test('trimQuoteExcerpt normalizes whitespace and truncates overlong selections cleanly', () => {
    expect(trimQuoteExcerpt('  hello\r\n\r\n\r\nworld  ')).toBe('hello\n\nworld');
    expect(trimQuoteExcerpt('   ')).toBe('');
    const huge = 'x'.repeat(1000);
    const trimmed = trimQuoteExcerpt(huge, 40);
    expect(trimmed.length).toBe(40);
    expect(trimmed.endsWith('…')).toBe(true);
  });

  test('formatQuotesPrefix builds standard Markdown blockquotes preserving newlines', () => {
    const prefix = formatQuotesPrefix([
      { id: 'q1', source: '负责人', excerpt: '第一行\n第二行' },
      { id: 'q2', source: '汇报', excerpt: '结论 A' },
    ]);
    expect(prefix).toBe('> **[负责人]** 第一行\n> 第二行\n\n> **[汇报]** 结论 A');
  });

  test('composeWithQuotes combines quotes with body or returns quotes alone when body is blank', () => {
    const quotes = [{ id: 'q1', source: '负责人', excerpt: 'P50 延迟 9.4ms' }];
    expect(composeWithQuotes('这个数字是怎么测的？', quotes)).toBe(
      '> **[负责人]** P50 延迟 9.4ms\n\n这个数字是怎么测的？',
    );
    expect(composeWithQuotes('   ', quotes)).toBe('> **[负责人]** P50 延迟 9.4ms');
    expect(composeWithQuotes('普通消息', [])).toBe('普通消息');
  });
});
