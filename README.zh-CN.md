<p align="center">
  <img src="assets/arc-banner.svg" alt="ARC — Agent Harness" width="100%" />
</p>

<p align="center">面向编码与长程工作的 Agent harness，让上下文始终可控。</p>

<p align="center">
  <a href="https://github.com/dycalo/ARC/actions/workflows/ci.yml"><img src="https://github.com/dycalo/ARC/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache 2.0" /></a>
  <img src="https://img.shields.io/badge/Node.js-22.19%2B-43853d" alt="Node.js 22.19 或更新版本" />
</p>

<p align="center">
  <a href="#开始使用">开始使用</a> ·
  <a href="docs/README.md">文档</a> ·
  <a href="docs/core.md">SDK</a> ·
  <a href="CONTRIBUTING.md">参与开发</a> ·
  <a href="README.md">English</a>
</p>

ARC 将 DeepSeek Harness 的工具与浏览器界面，与有预算上限的工作上下文、持久记忆和工作区执行策略结合起来。你可以交互式使用它，从终端执行任务，也可以把 TypeScript 运行时嵌入自己的 Agent。

## 开始使用

需要 Node.js **22.19+**、npm，以及模型服务凭据。从源码构建并安装：

```sh
git clone https://github.com/dycalo/ARC.git
cd ARC
npm ci
npm pack
npm install --global ./dycalo-arc-0.1.0.tgz
```

进入你要工作的项目目录：

```sh
arc setup
export DEEPSEEK_API_KEY="your-api-key"
arc web
```

`setup` 安装独立的固定版本运行环境，并配置当前工作区；`web` 启动交互式 harness。也可以在浏览器的模型设置中配置服务凭据。

从终端直接执行任务：

```sh
arc exec "阅读这个项目，将新人上手指南写入 ONBOARDING.md"
```

安装、存储位置、模式和故障处理见 [Harness 指南](docs/harness.md)。

## 面向持续工作

- **在项目中完成任务。** 默认 context 模式保留 DSH 原生工具，浏览器和终端使用相同工作区。
- **控制上下文大小。** ARC 按配置的字节预算替换模型工作 View，同时保留完整会话历史。
- **保留有用的记忆。** 记忆支持持久化、检索、来源版本和过期时间；来源更新后，依赖它的旧记忆随之失效。
- **规划后续多步。** 为需求选择单步、窗口或任务作用域，并分别配置刷新策略。
- **约束受管执行。** 使用版本化规则管理 ARC 动作，审核模型提出的契约修改后再应用。

## 选择执行模式

| 模式 | 适用场景 | 执行方式 |
| --- | --- | --- |
| **Context**，默认 | 编码、项目探索和 DSH 工具任务 | 原生工具遵循 DSH 执行策略，ARC 管理工作上下文。 |
| **Governed** | ARC 受管状态上的工作流 | ARC 根据有效契约校验并提交 SQLite 动作。 |

在配置新工作区时选择 governed 模式：

```sh
arc setup --mode governed
```

之后的启动沿用已保存的模式。文件、shell 和外部工具效果不具备 SQLite 事务语义。完整保证范围见 [执行策略](docs/assurance.md)。

## 配置与扩展

```sh
arc setup --view-budget 32768 --horizon 6 --refresh adaptive
```

设置会保存到后续启动。记忆上限和请求预算见配置指南。

| 需要做什么 | 文档 |
| --- | --- |
| 启动和配置 harness | [Harness 指南](docs/harness.md) |
| 调整上下文预算、记忆上限和刷新策略 | [配置指南](docs/configuration.md) |
| 接入已有 DSH 安装 | [DSH 集成](docs/dsh.md) |
| 基于 TypeScript 运行时构建 Agent | [Core SDK](docs/core.md) |
| 使用轻量独立运行器 | [Standalone CLI](docs/cli.md) |
| 理解运行时和执行模型 | [架构](docs/architecture.md) |

## 参与开发

```sh
npm ci
npm run check
```

开发流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。欢迎提交可复现的 [问题报告](https://github.com/dycalo/ARC/issues) 和明确的功能建议。

软件采用 [Apache-2.0](LICENSE)。ARC 基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 构建，是独立项目。
