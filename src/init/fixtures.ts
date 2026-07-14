/**
 * The `fixtures/` seeding seam (FR-3). `init` calls {@link seedFixtures} and
 * writes whatever it returns, so a scaffold's first `gridmason dev` renders with
 * data before the author edits anything (SPEC §3).
 *
 * This is the extension point the L-E1 fixture-seeding issue (#8) fills: from the
 * manifest it will emit one sample record per declared `requiresContext`
 * recordType, an empty `net` stub per declared `net:<host>` capability, and a
 * default context preset. Until then it seeds only a keepfile so the directory
 * exists in the scaffold.
 */
import type { GeneratedFile, TemplateContext } from '../templates/index.js';

/** Generate the `fixtures/` files for a scaffold. Placeholder until #8 lands. */
export function seedFixtures(_ctx: TemplateContext): GeneratedFile[] {
  return [
    {
      path: 'fixtures/.gitkeep',
      contents: '',
    },
  ];
}
