/**
 * Unit tests for the static-analysis substrate (#12): the comment/string masker
 * that keeps the heuristics off comments and string contents, and the rule runner
 * that locates a hit back in the original source. These are the pieces the SDK /
 * DOM checks are built from, so their edge cases are pinned here directly.
 */
import { describe, expect, it } from 'vitest';
import { lineColumnOf, maskNonCode, runSourceRules, type SourceRule } from '../src/checks/source-scan.js';

/** A rule that flags a bare global `fetch(` — the canonical raw-network shape. */
const fetchRule: SourceRule = {
  pattern: /(?<![.\w$])fetch\s*\(/,
  status: 'fail',
  label: 'direct fetch()',
  hint: 'use the SDK',
};

describe('maskNonCode preserves length and offsets', () => {
  it('returns a string of the same length', () => {
    const src = "const s = 'hello'; // fetch(\nfetch(url);";
    expect(maskNonCode(src)).toHaveLength(src.length);
  });

  it('blanks line and block comments (keeping newlines)', () => {
    const masked = maskNonCode('a // fetch(here)\n/* fetch(x) */ b');
    expect(masked).not.toContain('fetch');
    expect(masked.split('\n')).toHaveLength(2); // newline survived
    expect(masked).toContain('a ');
    expect(masked.trimEnd().endsWith('b')).toBe(true);
  });

  it('blanks string contents but keeps the delimiters', () => {
    const masked = maskNonCode("const u = 'https://fetch(evil)';");
    expect(masked).not.toContain('fetch');
    expect(masked).toMatch(/const u = ' +';/); // quotes kept, content spaced out
  });

  it('blanks template-literal bodies wholesale (a documented bypass)', () => {
    const masked = maskNonCode('const t = `x ${fetch(u)} y`;');
    expect(masked).not.toContain('fetch');
    expect(masked).toContain('`'); // backticks kept
  });

  it('honours escapes inside strings', () => {
    const masked = maskNonCode("const s = 'a\\'fetch(';");
    expect(masked).not.toContain('fetch');
  });

  it('leaves real code intact', () => {
    const masked = maskNonCode('window.fetch(url)');
    expect(masked).toBe('window.fetch(url)');
  });
});

describe('lineColumnOf', () => {
  it('reports 1-based line and column', () => {
    const src = 'a\nbc\nfetch(';
    const idx = src.indexOf('fetch(');
    expect(lineColumnOf(src, idx)).toEqual({ line: 3, column: 1 });
  });
});

describe('runSourceRules', () => {
  it('defers (no result) when there are no files', () => {
    expect(runSourceRules('sdk.raw-network', [], [fetchRule], 'clean')).toEqual([]);
  });

  it('emits a single pass when files are clean', () => {
    const results = runSourceRules('sdk.raw-network', [{ path: 'a.js', contents: 'sdk.fetch(u);' }], [fetchRule], 'clean');
    expect(results).toEqual([{ id: 'sdk.raw-network', status: 'pass', message: 'clean' }]);
  });

  it('locates a hit with file:line:column and the original token', () => {
    const results = runSourceRules('sdk.raw-network', [{ path: 'src/e.js', contents: 'const x = 1;\nfetch(url);' }], [fetchRule], 'clean');
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('fail');
    expect(results[0]?.message).toContain('src/e.js:2:1');
    expect(results[0]?.message).toContain('fetch(');
    expect(results[0]?.hint).toBe('use the SDK');
  });

  it('does not flag a keyword that lives only in a comment or string', () => {
    const clean = 'const note = "call fetch(x) here"; // fetch(y)\nsdk.fetch(z);';
    expect(runSourceRules('sdk.raw-network', [{ path: 'a.js', contents: clean }], [fetchRule], 'clean')).toEqual([
      { id: 'sdk.raw-network', status: 'pass', message: 'clean' },
    ]);
  });

  it('orders findings by file, then line, then column', () => {
    const files = [
      { path: 'b.js', contents: 'fetch(1);' },
      { path: 'a.js', contents: '\nfetch(2);' },
    ];
    const results = runSourceRules('sdk.raw-network', files, [fetchRule], 'clean');
    expect(results.map((r) => r.message.split(':').slice(0, 2).join(':'))).toEqual(['a.js:2', 'b.js:1']);
  });
});
