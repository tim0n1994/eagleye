import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { extractDomain, truncate, escapeHtml, escapeAttr, sleep, stripHtml, timeAgo } from '../utils.js';

// ─── extractDomain ──────────────────────────────────────────────────────

describe('extractDomain', () => {
  it('extracts domain from a standard URL', () => {
    expect(extractDomain('https://www.example.com/page')).toBe('example.com');
  });

  it('removes www. prefix', () => {
    expect(extractDomain('https://www.github.com')).toBe('github.com');
  });

  it('handles URLs without www', () => {
    expect(extractDomain('https://news.ycombinator.com/item?id=123')).toBe('news.ycombinator.com');
  });

  it('handles http protocol', () => {
    expect(extractDomain('http://example.org')).toBe('example.org');
  });

  it('returns empty string for invalid URLs', () => {
    expect(extractDomain('not-a-url')).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(extractDomain('')).toBe('');
  });
});

// ─── truncate ───────────────────────────────────────────────────────────

describe('truncate', () => {
  it('returns text unchanged when shorter than limit', () => {
    expect(truncate('Hello', 120)).toBe('Hello');
  });

  it('truncates text longer than limit with ellipsis', () => {
    const long = 'A'.repeat(150);
    const result = truncate(long, 120);
    expect(result).toBe('A'.repeat(120) + '\u2026');
    expect(result.length).toBe(121);
  });

  it('uses default limit of 120', () => {
    const long = 'A'.repeat(200);
    expect(truncate(long).length).toBe(121);
  });

  it('returns empty string for null/undefined', () => {
    expect(truncate(null)).toBe('');
    expect(truncate(undefined)).toBe('');
  });

  it('handles exact length', () => {
    expect(truncate('Exact length here', 120)).toBe('Exact length here');
  });
});

// ─── escapeHtml ─────────────────────────────────────────────────────────

describe('escapeHtml', () => {
  it('escapes & < > " and \'', () => {
    const input = '<script>alert("xss & stuff")</script>';
    const expected = '&lt;script&gt;alert(&quot;xss &amp; stuff&quot;)&lt;/script&gt;';
    expect(escapeHtml(input)).toBe(expected);
  });

  it('returns empty string for null/undefined', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('passes through safe strings unchanged', () => {
    expect(escapeHtml('Hello, world!')).toBe('Hello, world!');
  });

  it('converts to string for non-string inputs', () => {
    expect(escapeHtml(42)).toBe('42');
  });
});

// ─── escapeAttr ─────────────────────────────────────────────────────────

describe('escapeAttr', () => {
  it('escapes & " \' < >', () => {
    const input = 'hello "world" & <more>';
    const expected = 'hello &quot;world&quot; &amp; &lt;more&gt;';
    expect(escapeAttr(input)).toBe(expected);
  });

  it('returns empty string for null/undefined', () => {
    expect(escapeAttr(null)).toBe('');
    expect(escapeAttr(undefined)).toBe('');
  });
});

// ─── sleep ──────────────────────────────────────────────────────────────

describe('sleep', () => {
  it('resolves after the specified time', async () => {
    const start = Date.now();
    await sleep(10);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(8);
  });

  it('resolves with 0ms delay', async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
  });
});

// ─── stripHtml ──────────────────────────────────────────────────────────

describe('stripHtml', () => {
  it('returns empty string for null/undefined', () => {
    expect(stripHtml(null)).toBe('');
    expect(stripHtml(undefined)).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(stripHtml('')).toBe('');
  });

  it('strips basic HTML tags', () => {
    expect(stripHtml('<p>Hello world</p>')).toBe('Hello world');
  });

  it('strips nested HTML tags', () => {
    expect(stripHtml('<div><p>Nested <strong>text</strong></p></div>')).toBe('Nested text');
  });

  it('strips self-closing tags', () => {
    expect(stripHtml('Line1<br>Line2<hr>Line3')).toBe('Line1Line2Line3');
  });

  it('strips tags with attributes', () => {
    expect(stripHtml('<a href="https://example.com">Click here</a>')).toBe('Click here');
  });

  it('handles multiple text nodes', () => {
    expect(stripHtml('<p>First</p><p>Second</p><p>Third</p>')).toBe('FirstSecondThird');
  });

  it('strips tags but keeps text content from script elements', () => {
    const html = '<div>Visible</div><script>alert("hi")</script><div>More</div>';
    expect(stripHtml(html)).toBe('Visiblealert("hi")More');
  });

  it('strips tags but keeps text content from style elements', () => {
    const html = '<div>Content</div><style>.cls { color: red; }</style><div>End</div>';
    expect(stripHtml(html)).toBe('Content.cls { color: red; }End');
  });

  it('handles plain text without tags', () => {
    expect(stripHtml('Just plain text')).toBe('Just plain text');
  });

  it('handles HTML entities', () => {
    expect(stripHtml('&amp; &lt; &gt;')).toBe('& < >');
  });

  it('handles void elements like img (no text content)', () => {
    expect(stripHtml('<img src="pic.jpg" alt="A photo">')).toBe('');
  });

  it('handles br tags inside text', () => {
    expect(stripHtml('Line1<br/>Line2<br />Line3')).toBe('Line1Line2Line3');
  });
});

// ─── timeAgo ────────────────────────────────────────────────────────────

describe('timeAgo', () => {
  const NOW = 1_700_000_000_000;

  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it('returns "just now" for dates less than 1 minute ago', () => {
    expect(timeAgo(new Date(NOW - 30_000).toISOString())).toBe('just now');
  });

  it('returns "just now" for dates in the very recent past', () => {
    expect(timeAgo(new Date(NOW - 1_000).toISOString())).toBe('just now');
  });

  it('returns "just now" for future dates (negative diff)', () => {
    expect(timeAgo(new Date(NOW + 60_000).toISOString())).toBe('just now');
  });

  it('returns minutes for times 1-59 minutes ago', () => {
    expect(timeAgo(new Date(NOW - 5 * 60_000).toISOString())).toBe('5m ago');
  });

  it('returns "1m ago" for exactly 1 minute ago', () => {
    expect(timeAgo(new Date(NOW - 60_000).toISOString())).toBe('1m ago');
  });

  it('returns "59m ago" for 59 minutes ago', () => {
    expect(timeAgo(new Date(NOW - 59 * 60_000).toISOString())).toBe('59m ago');
  });

  it('returns hours for times 1-23 hours ago', () => {
    expect(timeAgo(new Date(NOW - 3 * 3_600_000).toISOString())).toBe('3h ago');
  });

  it('returns "1h ago" for exactly 1 hour ago', () => {
    expect(timeAgo(new Date(NOW - 3_600_000).toISOString())).toBe('1h ago');
  });

  it('returns "23h ago" for 23 hours ago', () => {
    expect(timeAgo(new Date(NOW - 23 * 3_600_000).toISOString())).toBe('23h ago');
  });

  it('returns days for times 1-29 days ago', () => {
    expect(timeAgo(new Date(NOW - 7 * 86_400_000).toISOString())).toBe('7d ago');
  });

  it('returns "1d ago" for exactly 1 day ago', () => {
    expect(timeAgo(new Date(NOW - 86_400_000).toISOString())).toBe('1d ago');
  });

  it('returns "29d ago" for 29 days ago', () => {
    expect(timeAgo(new Date(NOW - 29 * 86_400_000).toISOString())).toBe('29d ago');
  });

  it('returns formatted date for 30+ days ago', () => {
    const oldDate = new Date(NOW - 40 * 86_400_000);
    expect(timeAgo(oldDate.toISOString())).toBe(oldDate.toLocaleDateString('en-US'));
  });

  it('returns formatted date for 1+ year ago', () => {
    const oldDate = new Date(NOW - 400 * 86_400_000);
    expect(timeAgo(oldDate.toISOString())).toBe(oldDate.toLocaleDateString('en-US'));
  });

  it('handles ISO string with timezone offset', () => {
    expect(timeAgo(new Date(NOW - 2 * 60_000).toISOString())).toBe('2m ago');
  });
});
