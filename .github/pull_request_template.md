## Summary

<!-- What changes and why. -->

Closes #<!-- issue id -->

<!-- Base branch: `main`. See CONTRIBUTING.md. -->

## Checklist

- [ ] The title is a Conventional Commit (`feat(scope): …`); squash makes it the `main` commit (checked by `pr-title`)
- [ ] `node tools/check.mjs` passes on my OS (or `node tools/check.mjs fast` for a small change), and CI's `gate` is green
- [ ] Tests added or updated
- [ ] Bindings regenerated if Tauri commands changed (`cargo test -p oxide-app --test bindings_and_capabilities`), and `web/src/bindings.ts` committed
- [ ] Dependency, manifest or lockfile changes keep `cargo deny check bans licenses sources` passing and the `tauri` crate and `@tauri-apps/*` packages on the same `major.minor`
- [ ] Workflow or `tools/` changes: the change is made test-first in `tools/ci/policy.test.mjs` when it alters a pipeline decision
- [ ] Screenshots attached for UI changes
