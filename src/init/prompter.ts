/**
 * The interactive prompt surface for `widget init`, behind a small interface so
 * the orchestrator stays testable: unit tests drive `init` non-interactively (all
 * answers as flags) and never touch a terminal, while a real run uses the
 * readline-backed prompter below. Prompts render on stderr so a `--json` run
 * keeps stdout clean.
 */
import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';

/** One selectable option in a {@link Prompter.select} menu. */
export interface Choice<T extends string> {
  value: T;
  label: string;
}

/** What `init` asks the user, when interactive. */
export interface Prompter {
  /** Free-text answer; `validate` returns an error message to re-ask, or `true`. */
  text(opts: { message: string; default?: string; validate?: (value: string) => string | true }): Promise<string>;
  /** Choose one of `choices`; Enter accepts `default`. */
  select<T extends string>(opts: { message: string; choices: Choice<T>[]; default: T }): Promise<T>;
  /** Release the underlying stream handles. */
  close(): void;
}

/**
 * A readline-backed prompter over the given streams (process stdin/stderr by
 * default). Re-asks on empty/invalid input rather than accepting a bad value.
 */
export function createReadlinePrompter(
  input: Readable = process.stdin,
  output: Writable = process.stderr,
): Prompter {
  const rl = createInterface({ input, output });

  return {
    async text({ message, default: def, validate }) {
      for (;;) {
        const suffix = def ? ` (${def})` : '';
        const raw = (await rl.question(`${message}${suffix}: `)).trim();
        const value = raw || def || '';
        const verdict = validate ? validate(value) : value.length > 0 ? true : 'a value is required';
        if (verdict === true) {
          return value;
        }
        output.write(`  ${verdict}\n`);
      }
    },

    async select({ message, choices, default: def }) {
      const lines = choices
        .map((c, i) => `  ${i + 1}) ${c.label}${c.value === def ? ' (default)' : ''}`)
        .join('\n');
      for (;;) {
        const raw = (await rl.question(`${message}:\n${lines}\n> `)).trim();
        if (raw === '') {
          return def;
        }
        const byIndex = Number.parseInt(raw, 10);
        if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= choices.length) {
          return choices[byIndex - 1]!.value;
        }
        const byValue = choices.find((c) => c.value === raw);
        if (byValue) {
          return byValue.value;
        }
        output.write('  pick one of the listed options\n');
      }
    },

    close() {
      rl.close();
    },
  };
}
