# ARC 定制 DSH harness：源码可行性核查

核查日期：2026-09-06。官方仓库：`deepseek-ai/deepseek-harness`。本次读取固定提交 `d347e703908d0406b7a7ef80e3a0e594d86b2215`，本地只读研究副本 `/tmp/arc-dsh-research-20260906`。版本为 `0.1.3-alpha.1`；上游明确说明公开 API 尚未稳定。本文是源码与官方文档研判，没有安装依赖、运行 DSH、调用模型或完成产品验证。[版本源码][version] [API 状态][api-state]

## 结论

**可行，而且实现 View 真替换通常不必修改 agent-loop。** DSH 把完整追加日志与模型可见 surface 分开：任何合规生产者可追加一条带 `surfaceOp: { op: 'replace', start, end }` 的消息替换旧 surface 区间，保留完整来源关系；默认 loop 每次从 `session.deriveMessages()` 构建请求。这比仅向已有长 history 注入新 View 更贴近 ARC 的要求。[surface 协议][surface-types] [请求构建][loop-request]

**适合起步的形态是版本固定的 ARC 原生插件组合和自有 domain executor，而不是仅写 prompt 或 Codex/Claude hooks。** 原生扩展能拦截步骤、替换 surface、限制工具和执行前拒绝；然而 contract、CRI、Certificate 的语义与原子提交仍须 ARC 自行实现。特别是外置插件新增关键 Session event 的恢复兼容性存在现成限制，可能需要自有持久化、定制构建或上游协议改动。[步骤扩展][agent-events] [执行限制][guard] [事件恢复限制][known-events]

## 证据与接入位置

| ARC 需求 | 已确认的 DSH 行为 | 研判与实现位置 |
|---|---|---|
| 替换上下文，保留审计历史 | `surfaceOp.replace` 阴影化当前位置范围；来源必须覆盖所有被替换节点；实际请求使用 surface 派生消息。[surface 协议][surface-types] [loop][loop-request] | 原生插件可在 `agent/pre-step` 发布 View，无需删除 JSONL 或重建 session；仍须覆盖后续入队消息和最终请求组装。 |
| 下一步骤之前做 CRI | `agent/pre-step` 是异步 waterfall，能拒绝步骤、重写这一步从 inbox 接收的消息；这些消息随后被 loop 追加到 surface。[步骤执行代码][pre-step-code] | 在此读取已提交 domain state、requirements，运行 CRI，并决定是否准入。拒绝时要自行管理 pending proposal，不能假定本次 claimed 消息自动重排。 |
| 更新 system prompt | prompt sections 与 tools 每步 assemble；`complete` section 在 assemble waterfall 之后恢复为唯一 system section。[system prompt][system-prompt] | 固定 ARC system section；易变 View 更适合 surface。全量请求预算还需计算 tool schemas、runtime contexts 与附件。 |
| 防止模型未经证书调用动作 | `tools/pre-execute` 可 allow/deny/ask，但不能改已记录的参数；`tools.guard()` 在 waterfall 后检查，只有拒绝，没有 force-allow。[工具决定][tool-decisions] [guard][guard] | 用 async pre-execute 做较重验证，用同步 guard 复验 contract revision、proposal 状态和允许工具集合；最终提交前仍在 domain executor 重验。 |
| 修改、过滤工具返回 | `tools/post-execute` 可替换 content 或 canonical value，也可 block 为错误结果。[post-execute][post-tool] | 可做证据摄取和模型回馈，但无法撤销已执行的外部副作用，不能单独充当 commit gate。 |
| 记录当前与未来 requirements | 普通 `ToolCallBlock` 只有 `type/id/name/arguments`；自定义工具可定义 JSON 参数与输出 schema，执行时验证参数。[工具调用协议][tool-wire] [defineTool][define-tool] | 注册 `arc_propose` / `arc_execute`，在 arguments 中携带 envelope；不能期待给所有现成工具调用增加未定义的顶层 envelope。 |
| 下一声明只在动作成功后生效 | assistant message 在工具执行前已经记录；工具实际结果在 dispatch / post-processing 后按模型顺序记录。[assistant 与工具顺序][assistant-tools] [工具提交顺序][tool-order] | requirements 与 `proposalId/callId` 关联；仅 domain transition 成功且结果已确定后发布新声明，失败保留旧 contract revision。 |
| next-k-step | DSH 将一步定义为一个模型请求加其工具调用；一个请求可能含多个工具，并可并行调度。[步骤类型][step-definition] [工具调度][tool-order] | ARC 自行维护 horizon、有效期、失效触发；不要直接把 DSH `step` 计数当作 domain action 计数。 |
| 可配置部署 | profile 堆叠 bundle 和 patch；每一行可替换；preset 提供 per-session 工具/prompt/skills 组合。[配置组合][composition] [preset][preset] | 提供 ARC profile/bundle；domain、budget、horizon、记忆与证书策略放验证过的 Config。活跃会话不能任意切换 preset。 |
| 可选记忆 | 官方提供默认关闭的第三方 memory MCP 示例；DSH 发现工具，不负责数据库迁移、embedding、冲突解决或记忆治理。[记忆文档][memory] | 可作为检索候选来源；不等同于受验证 contract store。 |
| 恢复与重放 | source log 可以保存 replacement 来源；消息重构有 invariant。但默认持久化拒绝未知且不标 ignorable 的外部事件。[重构检查][invariant] [事件名单][known-events] [持久化检查][storage-contract] | 原型可复用已知 tool/result 等消息事件；关键 ARC 状态应有明确持久化方案，不能把可忽略标记用于关键 contract/commit event。 |

## View replacement 的真实范围

`agent.inject()` 只是把 user-role context 排入下一步骤，不唤醒 driver，也不替换此前 history。`agent/request` waterfall 只能替换 call config，官方契约明确禁止修改 messages。只用这两者会得到“旧 history + 新 View”，不能宣称实现 ARC 的替代机制。[注入代码][inject] [request 契约][agent-events]

可用路线是：CRI 根据已提交状态生成 View → 插件追加 replacement user/message 并记录完整 `sourceEventSeqs` → loop 追加本步准入消息 → loop 从当前 surface 派生请求。当前 compaction 的实现正是“summary 事件 + replacement user/message”；替换区间必须是 surface 的位置范围，不能按日志 seq 数值大小想当然地排序。因为 replacement 可使可见 seq 非单调，还应保持 assistant tool-call / result 成对，避免截断未完成步骤。[replacement 实例][compaction-commit] [区间验证][compaction-range] [surface 协议][surface-types]

这并不自动证明“最终请求仅包含 certified View”：pre-step 的 downstream listener 仍可能返回其他准入消息，loop 会把它们追加；本步 assembly 在 pre-step 之前已产生，其 system/tools/runtime contexts 也需要纳入预算与绑定范围。故 ARC 必须把可见输入来源、配置版本、允许追加的信息种类纳入自己的检查。现有 request reconstruction invariant 证明 loop 的请求与日志一致，**并不证明这些输入符合 domain contract**。[pre-step 顺序][pre-step-code] [assembly 字段][system-prompt] [invariant][invariant]

独立输入路径核查进一步确认：`complete:true` system section 与 `suppressRuntimeContext()` 在 assemble waterfall 后仍受强制设置约束；`llm/stream` 能观察最终逻辑请求，但 loop 请求已冻结，接口要求只读而非改写。可以据此设计 surface producer + 受控 prompt + 末端请求 verifier 的插件组合。DeepSeek adapter 之后仍会序列化 role、reasoning 与图像数据，因此逻辑 View 摘要不能冒充实际网络请求摘要。首版宜限文本并固定 adapter；多模态需要在完成物化的 adapter 出口核验。[prompt 强制设置][prompt-enforce] [LLM 只读约定][llm-readonly] [adapter 请求构造][adapter-request]

此外，compaction 可直接调用 `ctx.llm.stream()`，不经过 `agent/request`；同进程子代理有自己的 Session，SDK 子代理位于另一 runtime。必须明确证书覆盖哪些 actor 调用，并为需要治理的子代理配置 ARC；父代理插件不会自动治理所有辅助模型调用或外部子进程。[compaction 调用][compactor-call] [SDK 子代理][sdk-child]

完整 JSONL 日志仍随任务增长；surface replacement 解决模型输入长度，不保证磁盘日志或宿主内存恒定。Session 的当前实现有完整内存 log，`seq` 就是 log.length，append 直接 push；长期服务要另外规划日志存储、打开/恢复成本与材料索引。[Session 实现][session-append]

## Commit gate 与 requirements envelope

推荐的 envelope 是 ARC 自有工具的参数，例如 `{ proposalId, expectedContractRevision, action, arguments, currentRequirementId, nextRequirements }`。这是设计建议，不是 DSH 内建格式。`defineTool` 能表达和检查参数 schema；若沿用普通 Bash、文件修改、MCP 写工具，必须增加对应 ARC wrapper 或在其实际 provider 中实现受控写入，不能只在 prompt/schema 中声称动作需要 Certificate。[工具 schema][define-tool] [调用格式][tool-wire]

可分三个时点：

1. **提案产生**：模型输出 action + next requirements。assistant/message 仅表示模型产生了文本，尚无执行成功事实，不能在这里更新 domain contract。[顺序源码][assistant-tools]
2. **执行准入**：pre-execute 读取证书并异步验证，随后 monotonic guard 检查允许工具与当前 revision。DSH 明确保护工具身份和 arguments，不提供 pre-execute 参数改写。[决策定义][tool-decisions] [guard][guard]
3. **domain commit**：在 ARC 自有 executor 中重新验证证书、依赖版本与 preconditions，并把应用动作、消费 proposal、激活 next requirements 作为一个原子条件转换；contract 版本也参与检查，只有发生获准的 contract 更新时才发布新版本。DSH 侧投影已经提交的结果。post-execute block 只会改模型结果为错误，不能恢复执行前环境；session/event 是 post-commit 通知，异常会被隔离，也不能否决已经入日志的事实。[post-execute 实现][post-tool] [session append][session-append]

DSH 可以对同一步的多个读工具并行执行，post-processing 与日志提交则保持模型顺序。因此对有关联写入的 domain 工具，应先设置 exclusive，不应仅凭结果按顺序记日志便宣称状态串行一致；为外部系统实现原子性、幂等、重试和补偿是 ARC domain adapter 的责任。[工具调度][tool-order] [并发契约][tool-concurrency]

next-k-step 可先定义为“在最多 k 个 actor 调用内复用需求计划与仍有效的证据缓存”，另设受控动作计数；不能把 DSH step 与 domain transition 混用。每次模型调用仍验证其实际输入并建立新的 invocation 证书绑定，每次受控动作仍执行提交检查。信息来源、用户要求、环境事实或动作范围改变时提前结束窗口。旧 Certificate 不能直接覆盖多个输入不同的 invocation。DSH 没有可直接打开的 ARC horizon 开关；可以用自有插件状态和工具 guard 实现窗口策略。该段为设计推论，需进一步验证新增状态转换符合 ARC 的前提。

## 持久化是外置插件路线的重要限制

虽然 `SessionEventMap` 支持 declaration merging，默认 persistence 的 `KNOWN_SESSION_EVENT_TYPES` 是仓库生成的固定列表。上游说明明确写出：仓外插件事件必然不在列表；不认识且未标 `ignorable: true` 的事件拒绝恢复；用注册事件名改变读路径的方案已经被否决。`ignorable` 的语义是丢失不会影响重构，关键 contract revision、admission 或 commit 事件不符合这一语义。[事件列表及说明][known-events] [读取检查][storage-contract] [ignorable 语义][surface-types]

可以选择三条工程路线：

- **纯外置插件原型**：用已有 user/message、tool/result 的数据记录可恢复轨迹，另设 ARC store 存 contract / commit；启动时强制校验 store 与 session 的绑定、版本和水位。这是建议，尚未做 crash-recovery 验证。
- **版本固定的定制构建**：在仓内加入 ARC 事件并生成 persistence catalog，保留主 loop，维护很小的发行层差异。适合确定采用 DSH 的产品。
- **自有 persistence provider 或上游协议提案**：DSH 有可替换 provider 架构，但不能假定换一个 JSONL 路径就绕过共享协议检查；需要落实 ARC 自己的恢复与迁移契约。[持久化契约][storage-contract] [组合架构][composition]

## 记忆与配置的边界

DSH 可以挂接 memory MCP，但默认没有启用 memory server，官方把这些列为互操作示例而非持续支持承诺。memory 工具返回的内容只提供被模型看见的资料；不能据此推导事实可靠、来源完整、contract 冲突已解决。[memory 文档][memory]

ARC 可维护三类内容：已验证 contract 事实、带来源的候选记忆、短期执行材料。允许模型调用 `propose_contract_patch` 提交修改建议，再由 domain validator 以版本比较与依赖失效检查决定是否接受。记忆检索提供候选，CRI 决定哪些材料能够进入本次 View；否则一边替换 history，一边无界回灌记忆会抵消上下文预算。该段为产品设计建议。

公开扩展点并不等于稳定 API。上游当前为 alpha，profile/bundle/preset/API 可以用，但产品需要固定版本、扩展契约测试和升级验证；活跃 session 的 preset 不能在产生输出之后切换，不能用 preset 热切换承担每步 ARC 策略切换。策略状态应留在插件中，preset 用于会话启动时组合。[API 状态][api-state] [preset 生命周期][preset]

## 不改 loop、替换插件、修改上游的划分

| 分类 | 当前可以覆盖的工作 |
|---|---|
| 当前公开、但未稳定的扩展点 | pre-step admission；surface replacement；自定义工具 schema；tool guard；session projection；profile/bundle/preset。 |
| 自定义 provider/插件应承担 | CRI、View 编译、Certificate 检查、next-k 调度、domain executor、受治理记忆、日志与 domain store 的一致恢复。 |
| 可能需要定制构建或上游改动 | 新增关键 Session events 并让默认持久化识别；若坚持给所有 provider-neutral assistant/tool call 加统一顶层 envelope，则须扩展协议及其适配器/投影；若要求无法被 middleware 绕过的最终请求证书检查，需要另行核验终端发送路径。 |
| 本次无需直接修改 | 默认 ReAct loop 的步骤驱动。现有 surface replacement 已能支持普通 ARC View 发布，不应因“需要替换 Context”就先 fork loop。 |

此分类是对以上源码事实的工程推论。它不意味着所有第三方插件可信，也不意味着部署级权限等同于领域语义证书。

## 建议的最小验证

先固定 DSH 提交，在一个可事务化 domain 上验证：1）旧 history 已从真实模型请求中消失且 View 预算满足；2）无证书/过期 revision/漏声明动作被实际 executor 拒绝；3）失败动作不会推进 next requirements；4）next-k 执行在新观察出现时提前失效；5）崩溃恢复保持 contract、动作结果和日志一致。随后才扩大到任意 shell、外部 MCP 写入及多个 agent。这里列的是后续验证任务，本次未运行这些测试。

[version]: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/package.json#L1-L9
[api-state]: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/AGENTS.md#L5-L9
[composition]: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/docs/architecture.md#L9-L47
[surface-types]: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/core/session/src/types.ts#L378-L475
[loop-request]: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/core/agent-loop/src/agent.ts#L344-L362
[agent-events]: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/core/agent/src/runtime-types.ts#L264-L289
[pre-step-code]: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/core/agent-loop/src/agent.ts#L237-L299
[inject]: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/core/agent-loop/src/agent.ts#L125-L144
[system-prompt]: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/core/system-prompt/src/index.ts#L20-L118
[tool-decisions]: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/core/tools/src/index.ts#L575-L593
[guard]: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/core/tools/src/index.ts#L1091-L1118
[post-tool]: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/core/tools/src/index.ts#L1722-L1770
[define-tool]: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/core/tools/src/schema.ts#L538-L588
[tool-wire]: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/llm/llm/src/types.ts#L90-L105
[assistant-tools]: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/core/agent-loop/src/agent.ts#L450-L476
[tool-order]: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/core/agent-loop/src/tool-calls.ts#L113-L218
[tool-concurrency]: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/core/tools/src/index.ts#L248-L261
[step-definition]: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/core/session/src/types.ts#L254-L280
[preset]: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/preset/agent-presets/README.md#L26-L99
[memory]: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/docs/user/guide/mcp-memory.md#L5-L82
[compaction-commit]: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/compaction/compaction-basic/src/region.ts#L436-L475
[compaction-range]: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/compaction/compaction-basic/src/region.ts#L316-L337
[invariant]: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/core/agent-loop/src/invariant.ts#L18-L54
[session-append]: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/core/session/src/index.ts#L658-L749
[known-events]: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/core/session/src/known-event-types.ts#L8-L22
[storage-contract]: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/session/session-persistence/src/storage-contract.ts#L53-L81
[prompt-enforce]: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/core/system-prompt/src/index.ts#L574-L609
[llm-readonly]: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/llm/llm/src/index.ts#L59-L71
[adapter-request]: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/llm/llm-deepseek/src/adapter.ts#L552-L640
[compactor-call]: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/compaction/compaction-basic/src/summarizer.ts#L145-L182
[sdk-child]: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/subagent/subagent-dsh-sdk/src/index.ts#L132-L170
