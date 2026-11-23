# Antigravity 原生 TUI：Hooks 与控制验证

实测日期：2026-11-20。环境：macOS ARM64、官方 agy **1.5.13**。本机原先的 1.5.12 已自动更新，以下结论不外推到其他版本或操作系统。

## 统一运行时后的验收

终端与 App 新建已共用官方原生 PTY，不再按入口选择 ACP。新增真实验收覆盖 App 初始消息、单/多选、自定义答案、双端审批、模型/思考/模式重启恢复、图片/文本附件、设备 MCP 和 daemon 重连，见 [最新矩阵](antigravity-feature-parity.md)。旧 ACP 会话保留。下文是历史实验记录，其中旧的“未支持”状态以最新矩阵为准。

## 后续集成验收

同日后续已完成生产适配器接线，并通过隔离 daemon 的现有本地控制 API 复测原生 TUI 消息、Hooks 审批、停止与恢复。此前等待认证的两项——停止后恢复、原生 deny 优先于 Hook auto_approve——均已通过。ACP 的新建/恢复、消息、审批与原生模型控制也已通过；见 [集成说明](antigravity-integration.md) 和 [整理后的集成证据](fixtures/agy-integration-live-2026-11-20.json)。下文保留早期单项验证阶段的记录，其“尚未接入”“认证阻塞”描述已由本段更新取代。

## 早期单项验证阶段的结论与边界

原生 TUI 可以通过 **PTY 收发终端输入 + 官方 Hooks + 原生日志**实现消息跟进、工具事件及审批。已经在同一个真实 TUI 进程和原生 conversation 中验证远程输入、阻止、等待后批准、等待后拒绝、多行消息、中断后继续，以及停止正在执行的前台命令。

这次交付是验证脚本、证据和适配约束。测试控制通道只绑定本机回环地址，模拟 App 命令；**生产 App、daemon 和 relay 尚未接通 agy 控制**。没有另开 ACP 进程来冒充控制原有 TUI，也没有注入模型提供方、读取 Google 凭据或修改用户的模型默认设置。

完整实测还剩两项：停止后恢复、原生显式 deny 与 Hook auto_approve 的优先级。后续新进程停在官方登录页，`agy models` 同时提示 `Please sign in to view available models`，因此这两项记为认证阻塞，不能记为通过。没有执行 logout、重新认证或更改凭据。

## 已验证结果

证据来自原生日志中的工具结果与助手回复、Hook 请求，以及实际进程和工作区标记文件；没有只凭终端回显、模型自述或退出码判断成功。整理后的无账户信息证据见 [JSON 记录](fixtures/agy-native-validation-1.5.13.json)。

| 场景 | 结果和限制 |
| --- | --- |
| 源码 `originrouter agy` 启动 | 在生产 `PtyExecutor` 中启动真实入口，保留官方 TUI 和官方登录 |
| 远程消息 | 复用 `handleRemoteEvent` 的 `agent.message`，原生会话回复指定 marker；PID 和 conversationId 保持相同 |
| 多行中文消息 | 两行内容进入同一条 `USER_INPUT`，没有拆成两个请求 |
| 六类 Hooks | 正常读文件时捕获 SessionStart、PreInvocation、PreToolUse、PostToolUse、PostInvocation、Stop |
| `deny` | 原生工具结果为 ERROR，说明被 pre-tool hook 拒绝；没有成功读取结果或 PostToolUse |
| `allow` | 沿用原生权限检查；测试文件成功读取 |
| 等待远程拒绝 | Hook 挂起时尚未收到 PostToolUse；返回 deny 后工具报错 |
| 等待远程同意 | Hook 挂起时尚未收到 PostToolUse；返回 auto_approve 后出现成功读取和 PostToolUse；显式 deny 优先级仍待实测 |
| Hook 超时 | 配置 5 秒，原生杀死 Hook，工具报错 `signal: killed`，没有成功读取 |
| Hook 非零退出 | 返回 exit 7，原生工具报错，没有成功读取 |
| Hook 无效 JSON | 原生工具报解析错误，没有成功读取 |
| `force_ask` | 打开原生 File access 菜单；通过终端选择拒绝后，原生日志记录 user denied permission |
| Ctrl+C 中断 | 原生显示 Interrupted，TUI 仍存活，下一条消息得到正确回复；**本次没有收到 Stop Hook** |
| 等待 Hook 审批时中断 | 中断命令后约 3ms，测试 Hook 连接关闭；测试控制器移除待审批请求，迟到的同意得到 HTTP 409 |
| `session.stop` | 结束真实 TUI 及测试前台 bash/sleep 命令；18 秒后仍无完成标记。这不证明所有可能的后台任务或外部服务都会退出 |
| `/model`、`/effort` | 原生菜单可打开，模型和思考选项可见；取消菜单，没有提交变更，用户全局模型默认值保持不变 |
| 停止后 `--conversation=<id>` 恢复 | **待验收**：新进程在进入会话前要求官方登录 |
| 原生 deny 优先于 Hook auto_approve | **待验收**：已准备仅本次进程生效的 deny 规则，尚未执行到工具 |

这里的异常阻止结论仅覆盖已测试的 PreToolUse 文件读取场景，不表示所有 Hook 事件、空输出、所有工具或未来版本都有同样行为。`deny` 只拒绝当前工具调用，不等于取消整个任务。

## 适配必须遵守的约束

### 工具名称按运行时报告，不能照抄网页示例

官网目前仍以 `view_file`、`run_command` 举例；本次真实工具名称是 `read_file`，终端执行则以运行时报告为准。早期使用 `view_file|run_command` 的测试没有命中真实读文件工具，结果无效。后续使用 `matcher: "*"` 后才确认拒绝、超时和审批行为。

接入时先完整捕获工具，再按 `toolCall.name` 做能力映射。未知工具仍应进入既定的审批/观察策略，不能因命名不在静态列表里就绕开。

### 原生菜单与 Hook 审批是两个阶段

`allow` 是交回原生权限引擎，并非代替用户同意；`force_ask` 是打开原生确认菜单，并非把一个可远程答复的 PermissionRequest 发给客户端。六类 Hooks 中没有 Claude 风格的 PermissionRequest。

原生 TUI 的结构化远程审批应让 **PreToolUse 的本地 broker 等待交互结果**：拒绝返回 deny；同意按已验证的策略返回 auto_approve；断连和过期返回 deny。原生显式拒绝必须保留，不能用启动参数关闭原生权限检查。显式拒绝优先级需补完上表实测后才能将审批能力记为完整通过。

审批 ID 应绑定 `conversationId + toolCall.id`，缺少 ID 时再结合 stepIdx。中断、原生退出、连接关闭和超时都要结束对应交互，拒绝迟到回复。表中的 HTTP 409 是测试控制器的行为，生产端仍需接入现有 PendingInteractionRegistry。

生产 broker 的远程等待期限必须早于原生 Hook 超时，留出返回 deny 的时间；本次仅验证了 5 秒超时配置。不要把用户长时间未操作变成静默放行。

### Hooks 不能独立承担完整会话状态

首次真正提交消息前，测试尚未收到 SessionStart，原生 conversationId 也未知。初始登录页、工作区信任菜单或其他原生面板不能误当作聊天输入框。启动时先登记 OriginRouter 的运行 ID，再在官方事件出现后绑定原生会话身份。

本次 Ctrl+C 没有产生 Stop，原生确认菜单拒绝也没有立刻给出完整的正常轮次结束序列。因此需要同时使用本地控制动作、Hook 连接生命周期、原生日志和进程退出结果维护状态，不能永远等待 Stop 才解除“执行中”。

普通消息还应在登录、信任、权限等模态界面期间排队或拒绝，不能直接向任意面板写入文本。这里只验证了正常输入框里的单条消息及多行消息，尚未验收执行中的消息排队、用户同时输入以及所有模态面板。

### 日志用于内容和历史，Hooks 用于控制和身份

实测 Hook 字段包括 `hookEventName`、`conversationId`、`cwd`、`workspacePaths`、`transcriptPath`、`modelName`、`lastUserInput`；工具事件还有 `toolCall.id/name/args` 和 `stepIdx`。

Hook 的 transcriptPath 在本版指向 `transcript_full.jsonl`。普通 `transcript.jsonl` 提供 USER_INPUT、PLANNER_RESPONSE、GENERIC 等记录及稳定 step_index。历史读取应按会话和 step_index 去重，提取 USER_REQUEST 内的文本，并处理工具 ERROR。无需把完整日志中的内部元数据直接展示给用户。

Stop 的 `fullyIdle` 也要检查，不能把一轮停止等同于没有后台活动。

### 模型设置的副作用要单独处理

官方 `/model` 和 `/effort` 会保存用户默认选择；启动时 `--model`、`--effort` 则是本次运行的覆盖。能够向菜单发送按键，并不能提供稳定的结构化目录、会话级变更确认或避免默认值变化。

本次只打开并取消这两个菜单。原生 TUI 的 App 模型/思考设置应继续标记不支持、保留灰色行，直到该路径的选择、确认、持久化语义和用户同时操作都完成验证。ACP 会话有独立的正式配置接口，其能力不能套用到现有 TUI。

## 复测方法

显式运行以下命令会启动真实 agy，后续发送的测试任务会使用用户的官方额度：

```bash
node scripts/probe-agy-native.mjs --live
```

脚本新建临时工作区和 `.agents/hooks.json`，不安装全局 Hook。控制器仅绑定 127.0.0.1 随机端口；访问令牌保存在权限为 0600 的 controller.json 中，终端只输出临时根目录。临时日志包含测试对话内容，不应原样上传。

用输出的根目录替换以下 `/tmp/PROBE_ROOT`：

```bash
# 查看 TUI、进程、事件和待审批 ID。
node scripts/probes/agy-native-control.mjs /tmp/PROBE_ROOT status

# 只有确认处于本次临时工作区的信任页时，发送 Enter。
node scripts/probes/agy-native-control.mjs /tmp/PROBE_ROOT command '{"type":"terminal.input","data":"\r"}'

# 正常消息及事件。
node scripts/probes/agy-native-control.mjs /tmp/PROBE_ROOT command '{"type":"agent.message","message":"Reply exactly ORIGINROUTER_NATIVE_MESSAGE_OK. Do not use tools."}'

# 设置测试 Hook 行为：observe / deny / timeout / crash / malformed /
# force_ask / ask / auto_approve / remote。
node scripts/probes/agy-native-control.mjs /tmp/PROBE_ROOT mode '{"mode":"remote"}'
node scripts/probes/agy-native-control.mjs /tmp/PROBE_ROOT command '{"type":"agent.message","message":"Read hook-target.txt exactly once using the file-reading tool. Do not retry or use other tools if denied."}'

# status 返回 pending 后，用该 ID 作答；测试 Hook 超时仅 5 秒。
node scripts/probes/agy-native-control.mjs /tmp/PROBE_ROOT resolve '{"id":"CONVERSATION:TOOL_CALL","decision":"deny"}'

node scripts/probes/agy-native-control.mjs /tmp/PROBE_ROOT command '{"type":"terminal.interrupt"}'
node scripts/probes/agy-native-control.mjs /tmp/PROBE_ROOT command '{"type":"session.stop"}'
node scripts/probes/agy-native-control.mjs /tmp/PROBE_ROOT shutdown
```

`--deny-read` 给本次测试进程增加对 marker 文件的原生 deny 规则，不写用户设置。恢复测试用 `--resume-probe /tmp/PREVIOUS_PROBE_ROOT`，仅允许此前已记录退出的测试会话，复用其测试工作区和原生会话；不要并发打开同一会话。脚本有 15 分钟自动停止上限。真实 Windows/Linux、移动端及公网 relay 验收不包含在本报告中。

## 官方参考

- [Hooks](https://antigravity.google/docs/hooks/)
- [CLI reference：键盘、命令及配置](https://antigravity.google/docs/cli/reference/)
- [Settings：权限和持久化](https://antigravity.google/docs/settings?tab=cli)
- [Effort：当前会话与默认设置](https://antigravity.google/docs/cli/commands/effort/)
