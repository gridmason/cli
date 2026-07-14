/**
 * The static-analysis substrate the SDK-adherence (#12) and DOM-abuse checks
 * share (SPEC §5, FR-7). v0 is **heuristics only**: every check is a set of
 * regex rules run over a *masked* view of the source, and every rule carries a
 * documented known-bypass (see `docs/checks.md`). This module owns two things:
 *
 * 1. {@link maskNonCode} — a same-length rewrite of the source that blanks out
 *    comments and the *contents* of string/template literals (delimiters kept).
 *    Scanning the masked view keeps the common false positive out (a keyword in
 *    a comment or a string is not a call) while preserving every character
 *    offset, so a match maps back to an exact line/column in the *original*.
 * 2. {@link runSourceRules} — the tiny engine each check is expressed in: a list
 *    of {@link SourceRule}s over `ctx.sourceFiles`, emitting one
 *    {@link CheckResult} per hit (with its location) or a single `pass` when the
 *    widget has source but nothing tripped. No files → no result (the check's
 *    subject is absent), mirroring how a manifest check defers.
 *
 * Deliberately no heavyweight parser: the module depends on nothing but the
 * standard library, so `@gridmason/cli/checks` stays as light for the registry
 * to import as #11 promised (checks + `@gridmason/protocol` + `ajv`, nothing
 * else). The cost is honest imprecision — documented per rule, never hidden.
 */
import type { CheckResult, CheckStatus, SourceFile } from './types.js';

/**
 * Rewrite `source` to the same length with comments and string/template-literal
 * **contents** replaced by spaces (newlines preserved, so line/column offsets are
 * unchanged). String delimiters are kept, so a computed access like
 * `window['a'+'b']` survives as `window['' +'']` — still visibly dynamic — while
 * a keyword buried in a comment or an ordinary string can no longer match.
 *
 * Known limits (heuristic, by design): a regex literal is treated as ordinary
 * code, so a regex whose body contains a quote can mis-mask the code after it;
 * and a template literal's `${…}` interpolation is blanked wholesale, so code
 * hidden inside one is not analysed. Both are documented bypasses.
 */
export function maskNonCode(source: string): string {
  type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';
  let mode: Mode = 'code';
  let out = '';
  // Blank a char but keep newlines, so offsets and line counts are preserved.
  const blank = (c: string): string => (c === '\n' || c === '\r' ? c : ' ');
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i]!;
    const d = i + 1 < n ? source[i + 1]! : '';
    switch (mode) {
      case 'code':
        if (c === '/' && d === '/') {
          out += '  ';
          i += 2;
          mode = 'line';
        } else if (c === '/' && d === '*') {
          out += '  ';
          i += 2;
          mode = 'block';
        } else if (c === "'") {
          out += c;
          i += 1;
          mode = 'single';
        } else if (c === '"') {
          out += c;
          i += 1;
          mode = 'double';
        } else if (c === '`') {
          out += c;
          i += 1;
          mode = 'template';
        } else {
          out += c;
          i += 1;
        }
        break;
      case 'line':
        if (c === '\n') {
          out += c;
          i += 1;
          mode = 'code';
        } else {
          out += blank(c);
          i += 1;
        }
        break;
      case 'block':
        if (c === '*' && d === '/') {
          out += '  ';
          i += 2;
          mode = 'code';
        } else {
          out += blank(c);
          i += 1;
        }
        break;
      default: {
        // A string/template body: keep length, blank content, honour escapes,
        // and return to code on the matching (unescaped) delimiter.
        if (c === '\\') {
          out += ' ';
          if (i + 1 < n) out += blank(source[i + 1]!);
          i += 2;
        } else if (mode === 'single' && c === "'") {
          out += c;
          i += 1;
          mode = 'code';
        } else if (mode === 'double' && c === '"') {
          out += c;
          i += 1;
          mode = 'code';
        } else if (mode === 'template' && c === '`') {
          out += c;
          i += 1;
          mode = 'code';
        } else {
          out += blank(c);
          i += 1;
        }
      }
    }
  }
  return out;
}

/** A 1-based line/column for a character offset into `source`. */
export function lineColumnOf(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  const end = Math.min(offset, source.length);
  for (let i = 0; i < end; i += 1) {
    if (source[i] === '\n') {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

/** One heuristic: a pattern, the severity of a hit, and how to phrase/fix it. */
export interface SourceRule {
  /** Matched against the *masked* source (any flags; scanning forces global). */
  readonly pattern: RegExp;
  /** Severity of a hit (`fail` gates the run; `warn` surfaces without failing). */
  readonly status: Extract<CheckStatus, 'warn' | 'fail'>;
  /** What the hit is — the human phrasing, minus the location and the token. */
  readonly label: string;
  /** How to fix a hit; surfaced under the finding and in the #14 reference. */
  readonly hint: string;
}

/** A single rule hit, located back in the original source. */
export interface SourceMatch {
  readonly rule: SourceRule;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  /** The offending token, sliced from the *original* source (not the mask). */
  readonly token: string;
}

/** Scan one file's masked view for every hit of `rule`, located in the original. */
function scanFile(file: SourceFile, rule: SourceRule, masked: string): SourceMatch[] {
  const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`;
  const pattern = new RegExp(rule.pattern.source, flags);
  const matches: SourceMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(masked)) !== null) {
    const { line, column } = lineColumnOf(file.contents, match.index);
    // Report the token from the untouched source so the message is readable
    // even when the match spanned a masked (blanked) region.
    const token = file.contents.slice(match.index, match.index + match[0].length).trim();
    matches.push({ rule, file: file.path, line, column, token });
    // A zero-width match would spin forever; nudge past it.
    if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
  }
  return matches;
}

/**
 * Run every rule of a source check over `files` and shape the {@link CheckResult}s:
 * one `fail`/`warn` per hit (ordered by file, then line, then column), or a single
 * `pass` when there is source but nothing tripped. Returns `[]` when there are no
 * files — the check has no subject, so it stays silent rather than pass falsely.
 */
export function runSourceRules(
  id: string,
  files: readonly SourceFile[],
  rules: readonly SourceRule[],
  cleanMessage: string,
): CheckResult[] {
  if (files.length === 0) {
    return [];
  }
  const hits: SourceMatch[] = [];
  for (const file of files) {
    const masked = maskNonCode(file.contents);
    for (const rule of rules) {
      hits.push(...scanFile(file, rule, masked));
    }
  }
  if (hits.length === 0) {
    return [{ id, status: 'pass', message: cleanMessage }];
  }
  hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
  return hits.map((hit) => ({
    id,
    status: hit.rule.status,
    message: `${hit.file}:${hit.line}:${hit.column}: ${hit.rule.label} (\`${hit.token}\`)`,
    hint: hit.rule.hint,
  }));
}
