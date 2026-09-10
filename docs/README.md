# ARC documentation

Start with the [harness guide](harness.md) to install ARC, connect a model, and run a task in your project. After installation, `arc demo` runs a temporary, deterministic runtime example without a provider credential. For the browser experience, use `arc setup` and `arc web`.

ARC v0.1 verifies evidence coverage and bindings relative to the active Contract and requirements. Read the [runtime guarantees](assurance.md) for the precise View, Certificate, and commit boundaries.

## Use ARC

| Guide | What you will find |
| --- | --- |
| [Harness](harness.md) | Workspace setup, browser sessions, terminal tasks, updates, and troubleshooting |
| [Configuration](configuration.md) | Execution modes, context budgets, requirement windows, and storage |
| [Contracts](contracts.md) | Initial rules, task inheritance, model proposals, and host review |
| [Standalone runner](cli.md) | The lightweight provider loop, file tools, and resumable tasks |

## Build with ARC

| Guide | What you will find |
| --- | --- |
| [Architecture](architecture.md) | How the harness, plugin, and independent runtime fit together |
| [Core SDK](core.md) | TypeScript interfaces, managed actions, memory, and contract review |
| [DSH integration](dsh.md) | Adding ARC to an existing DeepSeek Harness installation |
| [Runtime specification](product-spec.md) | Supported interfaces and state transitions |
| [Runtime guarantees](assurance.md) | Admission, transaction boundaries, failure handling, and recovery |

For development and release checks, read [Contributing](../CONTRIBUTING.md) and the [release guide](release.md). The [changelog](../CHANGELOG.md) records public changes and migration notes.
