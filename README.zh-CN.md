# ARC

[English](README.md) · [CLI 文档](docs/cli.md) · [DSH 集成](docs/dsh.md) · [保证范围](docs/assurance.md)

ARC 为长程 Agent 提供有预算上限的证据 View、面向后续步骤的 requirements、持久记忆，以及与证据绑定的受管执行。它既可以作为独立 CLI 使用，也可以集成到 DeepSeek Harness。

模型声明下一步需要什么，运行时负责解析、选择与验证证据。每次调用使用新的 Certificate；需求计划和候选材料可以按窗口复用。完整轨迹保留在存储中，模型接收的 View 可以替换。

需要 Node.js 22.19 或更新版本。DSH 插件固定适配 **0.1.2-rc.1**，Cordis 为 **4.0.2**。仓库提供首个 **0.1.0** 版本的源码与打包流程；不表示已经发布到 npm 注册表。

## 安装与运行

```sh
git clone https://github.com/dycalo/ARC.git
cd ARC
npm ci --ignore-scripts
npm run build
node dist/cli/src/index.js demo --json
```

演示会实际执行 SQLite 受管动作，不需要模型或密钥。生成并安装可分发的包：

```sh
npm pack
npm install --global ./dycalo-arc-0.1.0.tgz
arc --version
arc demo
```

在环境中设置 `DEEPSEEK_API_KEY` 后，可以运行真实任务：

```sh
arc init /path/to/workspace
arc doctor --workspace /path/to/workspace
arc run "阅读项目文件，将实现计划写入 PLAN.md" --workspace /path/to/workspace
arc status --workspace /path/to/workspace --json
```

默认使用 DeepSeek V4 Flash。密钥从环境变量读取，不写入配置或数据库。独立 CLI 提供有界的文件列举、读取和写入，未提供无限制 shell。把 `allowFileWrites` 设为 `false` 可禁用写入。达到步骤上限的任务保留状态，可以使用 `arc run --resume SESSION` 继续。

## 主要配置

配置位于工作区的 `.arc/config.json`，初始领域规则位于 `.arc/contract.json`。未知字段和非法值会直接报错。

| 配置 | 含义 |
| --- | --- |
| `runtime.viewBudgetBytes` | View 的精确 UTF-8 字节预算；必需证据不会被静默截断 |
| `runtime.horizon` | 下一窗口需求的跨度及候选刷新间隔上限 |
| `runtime.refreshPolicy` | 每步刷新、窗口刷新或自适应刷新；每次调用仍独立验证 |
| `runtime.maxActiveRequirements` | 活跃需求上限，需要显式退役不再适用的需求 |
| `runtime.maxMemoryEntries` | 活跃记忆条目上限；记忆可以按步骤过期 |
| `requestBudgetBytes` | 独立 CLI 完整模型请求的额外字节上限 |
| `maxSteps` | 本次运行的最大模型调用次数 |
| `maxProtocolRetries` | 模型 JSON 协议错误的纠正次数上限；非法响应不会执行动作 |
| `provider` | 模型、服务地址、密钥环境变量名、思考模式和请求限制 |

Requirements 可以指定全文、摘要或元数据，并选择 step、window、session 作用域。派生记忆继承来源的版本依赖和失效期限；`recall` 可检索已不在当前 View 中的新鲜记录，并让有界检索结果通过下一次准入。模型也可以提交 contract 修改候选，只有宿主授权的应用操作才会改变有效规则。

## 集成 DSH

将打包后的 ARC 安装到指定 DSH profile，再加载仓库中的配置补丁。完整命令见 [DSH 文档](docs/dsh.md)。

- `examples/dsh-context.patch.yml`：保留 DSH 原生工具，提供有界上下文管理。
- `examples/dsh-governed.patch.yml`：只允许已适配的 ARC SQLite 动作，阻止原生工具绕过。

DSH 保留完整会话日志，ARC 替换发给模型的消息投影。ARC 的 SQLite 状态必须与对应的 DSH 会话一起保留。v0.1 支持文本输入；多模态、任意第三方可执行插件和未适配的 provider 变换不在完整保证范围内。

## 保证范围

对 ARC 自有 SQLite 资源，动作应用、提案消费和后续需求激活在同一事务中完成。CLI 文件工具及 DSH 原生工具没有自动获得这项原子保证；外部效果成功后，后续状态提交仍可能失败。CLI 会明确报告这种不确定状态，避免自动重试已发生的写入。

Certificate 验证的是相对于当前 contract 的证据准入和执行条件，不证明模型推理正确、任务必然完成、摘要必然忠实或领域规则覆盖所有现实依赖。宿主、数据库和已安装的可执行插件仍属于可信环境。[完整说明](docs/assurance.md)

## 验证与开发

```sh
npm run release:check
# 可选：使用环境中的密钥运行一个小型真实 API 验证任务
npm run smoke:live
```

测试包含证据篡改、过期依赖、记忆来源、并发提交、事务中途终止、CLI 模型协议，以及使用真实 DSH 运行循环的集成测试。另有 500 次受管写入与数据库重开的长程验证，检查 View 预算和状态连续性。发布验证见 [release.md](docs/release.md)，核心嵌入方式见 [core.md](docs/core.md)。

软件采用 [Apache-2.0](LICENSE)；论文稿件保留作者权利，详见 [NOTICE](NOTICE)。ARC 是独立项目，不是 DeepSeek 官方产品。
