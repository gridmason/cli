import { describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import type { IO } from '../src/io.js';

/** A capturing sink so a run can be driven with no child process. */
function capture(): { io: IO; out: () => string; err: () => string } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: {
      out: (s) => outChunks.push(s),
      err: (s) => errChunks.push(s),
    },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  };
}

async function drive(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const cap = capture();
  const code = await run(argv, cap.io);
  return { code, out: cap.out(), err: cap.err() };
}

// Every command name in the SPEC §2 surface, plus its nested subcommands.
const TOP_LEVEL = ['widget', 'dev', 'lint', 'verify', 'publish', 'appeal', 'bundle', 'login', 'whoami'];

describe('--help', () => {
  it('lists the full command surface', async () => {
    const { code, out } = await drive(['--help']);
    expect(code).toBe(0);
    for (const name of TOP_LEVEL) {
      expect(out).toContain(name);
    }
  });

  it('is what a bare invocation prints', async () => {
    const bare = await drive([]);
    const help = await drive(['--help']);
    expect(bare.code).toBe(0);
    expect(bare.out).toBe(help.out);
  });
});

describe('--version', () => {
  it('prints a semver from package.json', async () => {
    const { code, out } = await drive(['--version']);
    expect(code).toBe(0);
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('unimplemented commands', () => {
  it('print a not-yet-implemented notice on stderr', async () => {
    const { code, out, err } = await drive(['dev']);
    expect(code).toBe(0);
    expect(err).toContain('not yet implemented');
    expect(out).toBe('');
  });

  it('emit a stable JSON object on stdout with --json', async () => {
    const { code, out, err } = await drive(['lint', '--json']);
    expect(code).toBe(0);
    expect(err).toBe('');
    const parsed = JSON.parse(out) as { command: string; status: string; message: string };
    expect(parsed.command).toBe('lint');
    expect(parsed.status).toBe('not-implemented');
    expect(typeof parsed.message).toBe('string');
  });
});

describe('global flags', () => {
  it('are accepted after the command name', async () => {
    const { code, out } = await drive(['lint', '--registry', 'https://registry.example', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as { command: string };
    expect(parsed.command).toBe('lint');
  });

  it('--offline is a known flag on verify', async () => {
    const { code, out } = await drive(['verify', './widget.gmb', '--offline', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as { command: string };
    expect(parsed.command).toBe('verify');
  });
});

describe('nested command namespaces', () => {
  it('routes `widget init` and enforces its required answers', async () => {
    // Non-interactive (no TTY under vitest) with no `--publisher`: the command is
    // wired to the real `init`, which reports a stable JSON error and exits 1
    // rather than scaffolding. Full scaffolding is covered in init.test.ts.
    const { code, out } = await drive(['widget', 'init', 'my-widget', '--json']);
    expect(code).toBe(1);
    const parsed = JSON.parse(out) as { command: string; status: string; code: string };
    expect(parsed.command).toBe('widget init');
    expect(parsed.status).toBe('error');
    expect(parsed.code).toBe('missing-answer');
  });

  it('shows namespace help for bare `widget`', async () => {
    const { code, out } = await drive(['widget']);
    expect(code).toBe(0);
    expect(out).toContain('init');
  });

  it('routes `bundle export` and `bundle inspect`', async () => {
    const exported = await drive(['bundle', 'export', '--json']);
    expect((JSON.parse(exported.out) as { command: string }).command).toBe('bundle export');

    const inspected = await drive(['bundle', 'inspect', './widget.gmb', '--json']);
    expect((JSON.parse(inspected.out) as { command: string }).command).toBe('bundle inspect');
  });
});

describe('errors', () => {
  it('returns a non-zero exit code for an unknown command', async () => {
    const { code } = await drive(['does-not-exist']);
    expect(code).not.toBe(0);
  });

  it('returns a non-zero exit code when a required argument is missing', async () => {
    const { code } = await drive(['verify']);
    expect(code).not.toBe(0);
  });

  it('returns a non-zero exit code for an unknown subcommand of a namespace', async () => {
    const { code } = await drive(['widget', 'nope']);
    expect(code).not.toBe(0);
  });
});
