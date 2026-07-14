/**
 * The `init` scaffold templates (SPEC §3) — placeholder skeleton. Each template
 * emits a plain ES-module `entry` that registers the custom element and consumes
 * the host handle via `@gridmason/sdk` helpers: **vanilla** (bundler-free
 * reference, GW-D22), **React**, and **Vue**. The L-E1 templates issue (#7)
 * fills these in.
 */
export type TemplateName = 'vanilla' | 'react' | 'vue';

export interface Template {
  name: TemplateName;
  /** One-line description shown at the `widget init` framework prompt. */
  description: string;
}

/** The registered templates. Empty until the L-E1 templates issue populates it. */
export const templates: readonly Template[] = [];
