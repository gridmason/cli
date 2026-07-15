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

describe('publish is wired to the real command', () => {
  it('refuses without a registry, reporting a human error on stderr', async () => {
    // Every SPEC §2 command is now implemented — `publish` fails fast on its own
    // terms (no `--registry`) rather than printing a stub notice. Full behavior is
    // covered in publish.test.ts / publish.e2e.test.ts.
    const { code, out, err } = await drive(['publish']);
    expect(code).toBe(1);
    expect(err).toContain('registry');
    expect(out).toBe('');
  });

  it('emits a stable JSON error on stdout with --json when no registry is given', async () => {
    const { code, out, err } = await drive(['publish', '--json']);
    expect(code).toBe(1);
    expect(err).toBe('');
    const parsed = JSON.parse(out) as { command: string; status: string; code: string };
    expect(parsed.command).toBe('publish');
    expect(parsed.status).toBe('error');
    expect(parsed.code).toBe('no-registry');
  });
});

describe('global flags', () => {
  it('are accepted after the command name', async () => {
    // With `--registry` supplied, `publish` moves past the registry gate and fails
    // on the next one (the CLI package root has no manifest.json) — proving the
    // flags were parsed and routed to the real command.
    const { code, out } = await drive(['publish', '--registry', 'https://registry.example', '--json']);
    expect(code).toBe(1);
    const parsed = JSON.parse(out) as { command: string; status: string };
    expect(parsed.command).toBe('publish');
    expect(parsed.status).toBe('error');
  });

  it('--offline is wired and enforces the blind-root refusal', async () => {
    // `--offline` now runs the real `.gmb` path; with no trust config supplied it
    // fails closed before touching the bundle (SPEC §4.4). Full behavior is
    // covered in verify-offline.test.ts.
    const { code, out } = await drive(['verify', './widget.gmb', '--offline', '--json']);
    expect(code).toBe(2);
    const parsed = JSON.parse(out) as { command: string; status: string; code: string };
    expect(parsed.command).toBe('verify');
    expect(parsed.status).toBe('error');
    expect(parsed.code).toBe('no-trust-config');
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

  it('routes `dev` to the real implementation, which fails fast outside a widget project', async () => {
    // The CLI package root has no manifest.json, so the wired `dev` command
    // reports its own no-manifest error and exits 1 rather than a stub notice.
    const { code, out } = await drive(['dev', '--json']);
    expect(code).toBe(1);
    const parsed = JSON.parse(out) as { command: string; status: string; code: string };
    expect(parsed.command).toBe('dev');
    expect(parsed.status).toBe('error');
    expect(parsed.code).toBe('no-manifest');
  });

  it('shows namespace help for bare `widget`', async () => {
    const { code, out } = await drive(['widget']);
    expect(code).toBe(0);
    expect(out).toContain('init');
  });

  it('routes `bundle export` and `bundle inspect` to the real implementations', async () => {
    // No manifest.json at the CLI package root and no such .gmb, so the wired
    // bundle commands report their own stable JSON errors rather than stub notices.
    const exported = await drive(['bundle', 'export', '--release', './nope.json', '--json']);
    const ex = JSON.parse(exported.out) as { command: string; status: string };
    expect(ex.command).toBe('bundle export');
    expect(ex.status).toBe('error');

    const inspected = await drive(['bundle', 'inspect', './widget.gmb', '--json']);
    const ins = JSON.parse(inspected.out) as { command: string; status: string };
    expect(ins.command).toBe('bundle inspect');
    expect(ins.status).toBe('error');
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
