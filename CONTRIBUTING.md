# Contributing to ARC

Use Node.js 22.19 or newer and npm. Clone the repository, then run:

```sh
npm ci
npm run check
```

`check` type-checks source and tests, runs the behavioral suite, and builds the package. The suite uses local provider fixtures and does not require API credentials. Build output is in `dist`.

## Work on a change

The repository publishes one package. Core lives in `packages/core`, the DSH adapter in `packages/dsh`, and command-line behavior in `packages/cli`. Keep the core independent of DSH and use the existing public interfaces at integration boundaries.

For changes to input admission, managed state, memory, or contract behavior, read the [runtime specification](docs/product-spec.md) and [runtime guarantees](docs/assurance.md). Add behavioral tests that cover a rejected operation and its recovery path. Every actor call needs a fresh certificate; managed actions and requirement activation must remain in the same SQLite transaction.

Test focused changes with the relevant test file, then run the complete check before submitting:

```sh
node --import tsx --test --experimental-test-isolation=none packages/cli/tests/cli.test.ts
npm run check
```

To exercise the built package and installed DSH module graph:

```sh
npm run smoke
npm run soak
npm run smoke:harness
```

The package smoke permits registry access for pinned DSH dependencies. The soak exercises managed state through 500 transitions and database reopenings. The harness smoke installs and launches the official DSH CLI and Web application with a local model fixture. See the [release guide](docs/release.md) for scope and dependency reuse. `npm run smoke:live` is an optional, billable provider check that requires `DEEPSEEK_API_KEY`; it sends a synthetic task, not repository files.

## Submit a pull request

Explain the user-visible problem, resulting behavior, and relevant validation. Include a reproduction for bug fixes. Update onboarding and the changelog when commands or configuration change; update the assurance document when the execution boundary changes.

Keep credentials, local session stores, generated archives, dependency directories, and private source material out of commits. Follow the [release guide](docs/release.md) when preparing an installable archive. Registry publication and release publication are separate maintainer actions.

For bug reports, include the ARC and Node versions, operating system, relevant command, and a minimal reproduction with secrets removed. For feature proposals, describe the task you want to accomplish and the current limitation.
