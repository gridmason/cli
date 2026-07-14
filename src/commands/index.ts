import type { Command } from 'commander';
import type { IO } from '../io.js';
import { buildAppeal } from './appeal.js';
import { buildBundle } from './bundle.js';
import { buildDev } from './dev.js';
import { buildLint } from './lint.js';
import { buildLogin } from './login.js';
import { buildPublish } from './publish.js';
import { buildVerify } from './verify.js';
import { buildWhoami } from './whoami.js';
import { buildWidget } from './widget.js';

/**
 * Register the full SPEC §2 command surface onto the root program, in spec
 * order. Commands are stubs in this scaffold (each prints a not-implemented
 * notice); the surface is complete so `--help` documents the real tool.
 */
export function registerCommands(program: Command, io: IO): void {
  program.addCommand(buildWidget(io));
  program.addCommand(buildDev(io));
  program.addCommand(buildLint(io));
  program.addCommand(buildVerify(io));
  program.addCommand(buildPublish(io));
  program.addCommand(buildAppeal(io));
  program.addCommand(buildBundle(io));
  program.addCommand(buildLogin(io));
  program.addCommand(buildWhoami(io));
}
