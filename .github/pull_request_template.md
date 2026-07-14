<!--
Thanks for contributing to @gridmason/cli! Please fill this out so review is fast.
For a suspected security issue, do NOT open a PR — follow SECURITY.md.
-->

## What & why

<!-- What does this change do, and why? Link the issue it closes (e.g. Closes #123). -->

## Type of change

- [ ] Bug fix
- [ ] New command / flag / behavior
- [ ] Change to the shared `src/checks` module (note the registry-review impact)
- [ ] Docs / tests / internal only (no user-facing change)

## Checklist

- [ ] `npm run build && npm run typecheck && npm test && npm run lint` all pass locally.
- [ ] Tests added/updated for the change (router wiring and/or behavior).
- [ ] A changeset is included if the change is user-facing (`npx changeset`).
- [ ] I have signed the [CLA](.github/CLA.md) (the bot will guide you on your first PR).
- [ ] For a `checks` change: the shared-checks contract with the registry is preserved,
      or a cross-repo change was filed as an issue in the affected repo (no coordinated
      cross-repo merges).

## Notes for reviewers

<!-- Anything that helps review: tricky decisions, follow-ups, out-of-scope items. -->
