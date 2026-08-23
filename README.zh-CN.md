<p align="center">
  <img src="assets/readme-hero-zh.webp" alt="OriginRouter CLI — Claude Code 与 Codex，一个本地控制平面。" width="100%" />
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  在一个由本机掌控的工作区中运行 Codex 与 Claude Code。<br />
  统一 Agent 协作、模型路由、远程会话与本地审批策略。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@originrouter/cli"><img alt="npm" src="https://img.shields.io/npm/v/@originrouter/cli?style=flat-square&color=ff4b16" /></a>
  <a href="https://github.com/originrouter/originrouter_cli/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/originrouter/originrouter_cli/ci.yml?branch=main&style=flat-square&label=CI" /></a>
  <img alt="Node.js 22+" src="https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=node.js&logoColor=white" />
  <a href="LICENSE"><img alt="Apache-2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-ff4b16?style=flat-square" /></a>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a>
  · <a href="#agent-workspace">Agent Workspace</a>
  · <a href="#命令地图">命令</a>
  · <a href="https://originrouter.com/docs/originrouter-tools/cli">文档</a>
  · <a href="https://github.com/originrouter/originrouter_cli/issues">问题反馈</a>
</p>

> [!IMPORTANT]
> OriginRouter CLI 当前仍处于 1.0 之前的预览阶段。兼容性敏感的命令和持久化
> 结构会谨慎变更，但预览版本仍可能包含有明确说明的迁移。

## OriginRouter 能做什么

OriginRouter 是你现有 Coding Agent 的本地控制平面，而不是 Codex 或 Claude
Code 的替代品。实际工作仍由它们的执行引擎完成，OriginRouter 在外层提供统一
的工作区和协作能力。

- 直接输入最终目标，不需要手动组合多个 Agent 命令。
- 选择 Codex 或 Claude Code 作为协调者，或由 Auto 自动组织参与者。
- 协调规划、实现、审查、验证以及跨设备任务。
- 保留 Agent 原生配置、参数、TUI 和会话恢复流程。
- 在本地、Cloud 与远程设备之间统一配置模型路由。
- 在真正执行 Agent 的设备上应用审批策略。
- 从其他已授权设备查看会话并控制支持的操作。
- 保留 display-safe 活动和审计记录，不上传原始工作区内容。

```text
OriginRouter App（可选）
        │ 认证的 Local API / 加密账户 Bridge
        ▼
OriginRouter CLI daemon ─── 工作区 · 会话 · 策略 · 本地审计
        │
        ├── Codex app-server
        ├── Claude Agent SDK / Claude Code
        └── Compatibility Gateway ── LiteLLM ── 模型 Provider
```

## 安装

运行要求：

- Node.js 22 或更新版本
- 需要使用的 Codex 和/或 Claude Code
- 只有使用受管的本地 LiteLLM Proxy 时才需要 Python 3.10 或更新版本

安装公开 npm 包：

```bash
npm install --global @originrouter/cli
originrouter --version
```

完整命令名和短命令都可以使用：

```bash
originrouter --help
or --help
```

## 快速开始

在实际运行 Agent 的机器上执行一次：

```bash
# 检查 Agent、账户状态、Relay 连接和 Provider 配置
originrouter doctor

# 安装并启动用户级后台服务
originrouter service install
originrouter service start
```

然后进入项目并打开 Agent Workspace：

```bash
cd 你的项目
originrouter
```

也可以直接提交目标。默认协调者是 Codex：

```bash
originrouter "修复登录超时并补充回归测试"
originrouter -c claude --mode build-review \
  "实现这个修改，并让另一个 Agent 独立审查"
```

Agent Workspace 会自动使用当前目录，不需要额外输入项目路径。

### 远程设置、Remote Share 与工作区授权

`originrouter remote setup` 应在**目标设备的管理上下文**执行，例如目标设备终端、
SSH、屏幕共享或设备管理工具；只有操作系统要求交互确认时，才需要进入目标设备的
图形界面。它汇总远程能力的状态，但不会把任一项授权自动扩大到另一项：

```bash
# 查看设备信任、Remote Share 和已登记工作区
originrouter remote status

# 显式共享指定 LiteLLM Provider；只共享其 remote-enabled 模型
originrouter remote share start --providers openai,anthropic

# 在一次 setup 中启用共享并登记一个工作区
originrouter remote setup --providers openai,anthropic \
  --workspace ~/Desktop/client-a
```

远程功能分成三个相互独立的 scope：

| Scope | 入口 | 授予的能力 |
| --- | --- | --- |
| 设备信任 | `originrouter login`，必要时在 App 批准设备 | 该设备可加入可信设备网络与 E2EE 通信。 |
| Remote Share | `originrouter remote share start` | 仅把选定 Provider 的 remote-enabled 模型提供给其他可信设备路由；不会泄露 Provider 密钥，也不授予文件访问。 |
| 工作区 | `originrouter remote workspace authorize <path>` | 仅允许远程 Agent 在该目录及其子目录工作；不共享模型或账户凭据。 |

可信控制端可以请求目标设备登记普通目录，但远程 Agent 不能借此自行扩大权限：

```bash
originrouter remote workspace request /path/to/project --device <device-id>
```

目标 daemon 只会自动接受无需触发交互式系统权限或挂载凭据的目录。受保护目录会明确
返回“需要目标设备授权”，随后从目标设备的管理上下文执行
`remote workspace authorize`。这并不等于必须物理坐在目标设备前。OriginRouter 会
显式标记受管 Agent 进程，并拒绝这些进程执行 request 或 authorize，防止 Agent 自行
扩大工作区范围。

工作区可位于 Desktop、Documents、Downloads、iCloud/CloudStorage、OneDrive 或网络
挂载等位置，但必须先从目标设备的管理上下文执行 `remote workspace authorize`。
此步骤用 daemon 的当前运行身份做读写预检；若 macOS TCC、Windows 安全策略或挂载
凭据需要确认，才要求用户进入目标设备处理。随后远程启动只使用已登记且仍匹配该
运行身份的目录；未登记或授权失效的目录会直接返回“需要目标设备授权”，不会在远程
任务中等待系统弹窗。

推荐仍将长期远程项目放在 `~/Developer` / `~/OriginRouterWorkspaces`（Windows 为
`%USERPROFILE%\\Developer`），以减少系统隐私策略与云盘同步造成的维护成本。企业
受管设备可通过 MDM、GPO 或系统配置预配相应的文件访问、Defender 和挂载权限。

## Agent Workspace

Agent Workspace 让用户始终停留在 OriginRouter 中，由 daemon 在后台运行受管
的 Codex 或 Claude 会话。一个长期 Workspace Session 可以包含多个有限 Run；
每次用户目标都有独立的任务、审批、预算、审计与最终结果，但完成一个 Run 不会
结束整个对话。继续输入目标会留在当前 Session，`/new` 才会建立新的团队与上下文。

重新打开 Workspace 后使用 `/resume <session-id>`。Session 历史严格按顺序推进；
单个 Run ID 仍可用于查看、重试和审计，但不能作为历史分支的继续点。

新 Session 的第一条目标负责选择 Team 并生成可审查计划。后续目标直接交给当前
主 Agent，由它通过 Agent MCP gateway 自行决定是否调用现有成员，不会每次重新
自动配置团队。如果需要新增机器、目录、runtime、模型或扩大权限，主 Agent 必须
发起版本化 Team 变更；Workspace 会显示具体差异并等待本机用户确认，确认前新成员
不能执行任务。未变化成员会跨 Run 保留安全的原生会话连续性。

Session Team 只保存在协调端 CLI 的本地协作数据库中。跨设备派发与 Agent MCP
通信继续使用现有已认证的 E2EE Relay/Server bridge；服务端只路由密文与在线状态，
不保存 Team 或原生 Agent 凭据。为了让 App 能按 Session 展示与继续任务，账户投影
只保存无敏感内容的连续性标识：`workspace_session_id`、前一 Run ID、Team revision
编号与 continuation 标记。部署时先执行
`originrouter_server/sql/024_collaboration_workspace_session_projection.sql`，
再升级 Server、所有参与协作的 CLI，最后升级 App。

可以通过 `--mode` 选择协作模式，也可以在交互式工作区中使用
`/mode <名称>` 或 Shift+Tab 切换。

| 模式 | 适用场景 |
| --- | --- |
| `auto` | 根据目标自动选择最小且有效的参与者结构 |
| `solo` | 问答和范围明确的小任务 |
| `build-review` | 完成实现后交给另一个 Agent 独立审查 |
| `plan-build-verify` | 大型、生产敏感或跨模块任务 |
| `parallel-research` | 对多个方向进行相互独立的并行调查 |
| `review-panel` | 架构决策和多种方案比较 |
| `remote-ops` | 需要另一台可信设备参与的远程任务 |

常用参数：

```bash
originrouter -c codex "<目标>"
originrouter -c claude "<目标>"
originrouter --mode plan-build-verify "<目标>"
originrouter --cloud-advice "比较几种安全的上线方案"
```

`--cloud-advice` 是可选功能，只会把目标和经过类型约束的 display-safe 能力摘要
发送给 OriginRouter AI Server，不包含设备 ID、工作区路径、Provider 和模型名称、
凭据或环境变量。用户手动选择的模式始终拥有最高优先级。

交互命令、确认策略、后台 Run 和并行写入安全规则参见
[Agent Workspace 指南](docs/agent-workspace.md)。

## 原生 Agent 与模型路由

你随时可以直接启动 Agent，并保留它已有的配置：

```bash
originrouter codex --originrouter-native-config
originrouter claude --originrouter-native-config
```

OriginRouter 支持三种模型来源：

| 来源 | 适用场景 | 配置方式 |
| --- | --- | --- |
| Agent 原生配置 | 保留 Agent 已有的登录状态和模型 | `--originrouter-native-config` |
| LiteLLM 本地 Provider | 使用保存在自己设备上的 Provider 凭据 | `provider`、`route`、`proxy` |
| OriginRouter Cloud 或远程 CLI | 使用账户模型或另一台可信设备 | `login`、`route cloud`、`route remote` |

可以从 `originrouter agent setup` 开始，Provider 和 Route 示例参见
[CLI 使用指南](https://originrouter.com/docs/originrouter-tools/cli)。

## 审批与远程控制

审批策略在实际执行 Agent 的设备上进行判断：

```bash
originrouter claude --originrouter-autonomy guarded
originrouter codex --originrouter-autonomy ai_review
originrouter claude --originrouter-autonomy custom \
  --originrouter-policy ~/.originrouter/policies/team-default.json
```

| 模式 | 行为 |
| --- | --- |
| `manual` | 由用户处理支持的审批决定 |
| `guarded` | 自动允许保守的内置安全范围 |
| `ai_review` | 在硬安全边界内交给已配置的审查模型判断 |
| `unrestricted` | 对支持的决定不进行交互式审查 |
| `custom` | 在 CLI 设备上评估版本化的审批策略文档 |

未知工具、含糊的 Shell 展开、证据不足和无法安全解析的路径都会回退到用户审查。

已授权设备可以查看会话、发送消息、停止任务并处理支持的交互请求。Provider
凭据保留在本机，远程 Agent 数据使用设备端到端加密。

## Shell 命令补全

OriginRouter 为命令、参数、模式和本机已配置的 Provider 名称提供上下文补全。

```bash
# zsh：加入 ~/.zshrc
source <(originrouter completion zsh)

# bash：加入 ~/.bashrc
source <(originrouter completion bash)

# fish
originrouter completion fish > ~/.config/fish/completions/originrouter.fish

# PowerShell：加入 $PROFILE
originrouter completion powershell | Out-String | Invoke-Expression
```

## 命令地图

| 领域 | 命令 |
| --- | --- |
| Agent Workspace | `originrouter`、`-c`、`--mode`、`--cloud-advice` |
| Agent | `claude`、`codex`、`agent setup`、`agent detail`、`agent budget` |
| 协作 | `collaborate`、`collaboration` |
| 模型 | `provider`、`route`、`proxy`、`compatibility` |
| 会话 | `sessions`、`devices`、`history` |
| 账户与安全 | `login`、`logout`、`auth`、`security` |
| 本地控制 | `service`、`local`、`token`、`daemon` |
| 工具 | `doctor`、`completion`、`run -- <command>` |

运行 `originrouter --help` 查看面向任务的概览，运行 `originrouter help all` 查看
完整命令面。

## 安全模型

- Provider key、OAuth token、设备授权和原始请求不会进入 display-safe Cloud 索引。
- 完整对话、工具输出、源代码、命令和路径保留在 CLI 设备，除非通过加密设备
  通道明确传输。
- Local API 即使只监听 loopback，也要求每次安装随机生成的 bearer key。
- 审批策略在真正执行 Agent 的设备上评估。
- Compatibility 模块不能访问文件系统、网络、环境变量、进程、凭据、审批能力
  或 E2EE key。

安全问题报告方式参见 [SECURITY.md](SECURITY.md)。

## 文档与贡献

- [CLI 使用指南](https://originrouter.com/docs/originrouter-tools/cli)
- [命令参考](https://originrouter.com/docs/originrouter-cli/commands)
- [Agent Workspace 指南](docs/agent-workspace.md)
- [贡献指南](CONTRIBUTING.md)
- [发布流程](docs/releasing.md)

开发环境与测试命令统一放在 `CONTRIBUTING.md` 中，不再混入普通用户的安装流程。

## 第三方产品与法律声明

OriginRouter 是独立的开源项目，与 Anthropic 或 OpenAI 不存在隶属、赞助、
认可或合作关系。

OriginRouter 可与包括 Claude Code 和 Codex 在内的第三方开发工具及服务进行
互操作。用户需要自行取得并维护相应的账户、订阅、许可证和访问权限，并遵守
适用的第三方条款与政策。

第三方软件及依赖项继续受其各自许可证和使用条款约束。产品名称和标识归其
各自权利人所有；相关名称仅用于说明兼容性，不代表任何认可或合作关系。

AI 生成的内容和操作可能不准确、不完整或不安全。用户有责任在依赖或执行前
进行审核。

依赖项和运行时组件的许可详情参见[第三方声明](THIRD_PARTY_NOTICES.md)。

## 许可证

[Apache License 2.0](LICENSE)
