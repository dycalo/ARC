# ARC development

Read `docs/product-spec.md` and `docs/assurance.md` before changing protocol behavior.

- One npm package exports the core, CLI and DSH plugin. Keep the core independent of DSH.
- Managed actions, proposal consumption and requirement activation share one SQLite transaction. Do not downgrade this into an event callback.
- Every actor call has a fresh invocation certificate. Window reuse never means certificate reuse.
- Model-authored memories cannot overwrite host observations or weaken domain obligations.
- Keep exact View byte accounting distinct from total provider request limits and token estimates.
- Changes to state or input admission require behavioral failure/recovery tests through the public interface.
- Run `npm run check` before synchronizing a milestone. `npm test` uses in-process Node test isolation so named test cases execute consistently in this workspace.
- Never commit credentials, runtime databases, generated archives or dependency directories.
- Update onboarding, assurance scope and migration notes with public behavior changes.

The repository owner authorized ongoing implementation and synchronization to `origin` (`https://github.com/dycalo/ARC`). Do not force-push or publish to package registries without explicit authorization.
