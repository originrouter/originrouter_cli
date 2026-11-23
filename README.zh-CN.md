<p align="center">
  <img src="assets/readme-hero-zh.webp" alt="OriginRouter CLI — Claude Code 与 Codex 的本地控制层。" width="100%" />
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  用一个本地控制层运行 Claude Code 与 Codex。<br />
  统一任务协作、模型路由、审批和跨设备跟进。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@originrouter/cli"><img alt="npm" src="https://img.shields.io/npm/v/@originrouter/cli?style=flat-square&color=ff4b16" /></a>
  <a href="https://github.com/originrouter/originrouter_cli/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/originrouter/originrouter_cli/ci.yml?branch=main&style=flat-square&label=CI" /></a>
  <img alt="Node.js 22+" src="https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=node.js&logoColor=white" />
  <a href="LICENSE"><img alt="Apache-2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-ff4b16?style=flat-square" /></a>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a>
  · <a href="#选择使用入口">选择入口</a>
  · <a href="https://originrouter.com/docs/originrouter-cli/overview">CLI 文档</a>
  · <a href="https://originrouter.com/docs/originrouter-app/overview">App 文档</a>
  · <a href="https://github.com/originrouter/originrouter_cli/issues">问题反馈</a>
</p>

> [!IMPORTANT]
> OriginRouter CLI 当前处于 1.0 之前的预览阶段。升级前请阅读发布说明；预览
> 版本可能包含已说明的迁移要求。

## OriginRouter CLI 是什么？

OriginRouter CLI 是围绕现有 Coding Agent 的本地执行与控制层。Claude Code 和
Codex 仍负责实际执行，OriginRouter 为它们提供统一的工作区、模型路由、协作、
审批、会话控制和远程跟进能力。

- 直接提交目标，不需要手动拼接多个智能体命令。
- 直接使用 Claude Code 或 Codex，也可以让智能体工作区协调团队。
- 在 OriginRouter Cloud、本地模型服务和可信远程推理集群之间路由，并按数据区域和负载策略分配请求。
- 命令、工具、工作区访问和审批决定都留在真正执行任务的设备上。
- 连接可选的 OriginRouter App，查看状态、处理审批并远程跟进任务。

<p align="center">
  <img src="assets/readme-architecture-zh.svg" alt="OriginRouter 通过 App 和本地 CLI 组织协作，运行多个智能体，并将请求路由到云端、本地或远程模型服务，支持按数据区域选择推理位置。" width="980" />
</p>

## 选择使用入口

| 入口 | 适合场景 |
| --- | --- |
| `originrouter` | 需要持续工作区、任务规划、分工或审查。 |
| `originrouter claude` | 想保留 Claude Code 原生终端体验，同时使用 OriginRouter 的控制能力。 |
| `originrouter codex` | 想保留 Codex 原生终端体验，同时使用 OriginRouter 的控制能力。 |
| OriginRouter App | 想从另一台设备查看状态、处理审批或远程跟进。 |

App 不是必需组件。命令、工具和工作区访问始终在 CLI 所在设备执行。

## 启动方式与 App 控制能力

终端启动后再用 App 跟进，仍控制原来的进程；不会自动换成 SDK、app-server 或 ACP。
App 后台新建在设备上运行，没有可见窗口。下表描述本版本已接入的能力，不能把官方
原生终端中可用的操作都理解为 App 已能远程操作。最终以在线会话上报的能力为准；
未支持的设置不可用，不会显示已经生效。

`--native-config` 选择用户原生登录与模型配置，不决定使用 TUI 还是 SDK。
Claude/Codex 网关模式由 OriginRouter 网关切换实际模型，原生模型保持路由所需的固定值；
只有原生配置模式才使用官方模型目录与切换接口。agy 始终使用用户自己的官方登录和额度。

### Claude Code

| 能力 | 终端 `originrouter claude` + App 跟进 | App 后台新建 Claude |
| --- | --- | --- |
| 底层 / 本地界面 | 官方 TUI、PTY 与启动前 Hooks；有原生终端 | Claude SDK；没有原生 TUI |
| 消息、历史、工具与活动 | 支持；PTY 输入与原生转录 | 支持；SDK 输入与事件 |
| 工具审批、问答、计划确认 | 支持官方 Hook 暴露的 PermissionRequest、AskUserQuestion、ExitPlanMode | 支持 SDK 的工具审批、问答和计划确认 |
| MCP 表单 / URL 交互 | 支持已公开的 Elicitation Hooks | 支持公开 SDK elicitation 回调；私有产品对话框不接管 |
| 原生配置下 App 切模型 | 未提供原生模型 setter；设置不可用 | 支持官方目录与切换确认 |
| App 切思考深度 | 原生 TUI 暴露已识别滑块时支持会话级切换 | 支持运行时报告的等级 |
| App 切权限模式 | 支持已识别的原生模式操作与确认 | 支持 SDK 控制；具体模式以会话报告为准 |
| 执行中追问 / 侧对话 | 受 TUI 输入与面板限制；不提供结构化侧对话控制 | 支持运行时接入的消息与 `/btw` 侧对话 |
| App `/` 命令 | 整理后的命令注入；原生面板操作不等于结构化 App 控制 | 已接入的 SDK / app-server 命令与结果 |
| App 图片/文件内容块 | 当前未开放 | 当前未开放 |
| OriginRouter 设备工具 / 自动恢复 | 不开放完整 managed 能力 | 已接入会话绑定的设备工具与运行监督 |
| 打断、停止、恢复对话 | 支持；通过原生进程与对话恢复 | 支持；通过 SDK 及会话生命周期 |

### Codex

| 能力 | 终端 `originrouter codex` + App 跟进 | App 后台新建 Codex |
| --- | --- | --- |
| 底层 / 本地界面 | 官方 TUI 与 PTY；有原生终端 | 官方 app-server；没有原生 TUI |
| 消息、历史、工具与活动 | 支持；PTY 输入与 rollout 日志 | 支持；结构化请求与事件 |
| App 结构化审批 / 问答 / MCP 表单 | 未接入该原生 TUI 的阻塞控制通道，需在终端处理 | 支持官方 app-server 暴露的审批、用户输入和 elicitation |
| 原生配置下 App 切模型 / 思考深度 | 未提供该 TUI 的原生 setter；设置不可用 | 支持官方模型目录、配置及确认 |
| App 切执行模式 / 自主权限配置 | 原生 TUI 不开放结构化控制 | 支持运行时报告的模式和权限控制 |
| 计划、压缩、用量与历史镜像 | 读取原生日志中已暴露的事件 | 读取正式 app-server 事件与结果 |
| 侧对话、后台终端管理 | 本地原生功能；不提供对应结构化 App 控制 | 支持已接入的 fork 侧对话及后台终端命令 |
| App `/` 命令 | 整理后的命令注入；原生面板操作不等于结构化 App 控制 | 已接入的 SDK / app-server 命令与结果 |
| App 图片/文件内容块 | 当前未开放 | 当前未开放 |
| OriginRouter 设备工具 / 自动恢复 | 不开放完整 managed 能力 | 已接入会话绑定的设备工具与运行监督 |
| 打断、停止、恢复对话 | 支持；通过原生进程与对话恢复 | 支持；通过 app-server 及会话生命周期 |

若希望在终端显式选择受管运行时，可使用 `originrouter claude-terminal` 或
`originrouter codex-terminal`；它们也不提供官方原生 TUI。App 跟进已经启动的原生会话不会自动切换运行时。

### Antigravity CLI（agy）

终端 `originrouter agy` 与 App 后台新建 agy 使用**同一套官方原生 TUI + PTY + Hooks**。
终端启动附着本地输入输出，App 启动使用后台虚拟终端；是否有可见窗口不决定 agent 控制能力。
App 跟进已有会话不会另起一个 ACP 进程。

| 能力 | 两种原生启动入口 |
| --- | --- |
| 消息、历史、队列、中断、停止、精确恢复 | 支持；保护原生模态界面和本地草稿 |
| 工具审批 | 本地 OriginRouter 提示与 App 共用决策；原生 deny 继续有效 |
| 原生问答 | 结构化单选、多选、单选自定义文本；以实际原生结果确认答案 |
| 模型 / 思考深度 / 执行模式 | 原生目录与实际设置；等待空闲后重启子进程、恢复同一对话。思考等级只提供账号目录中可确认的模型变体 |
| App 文本/图片附件 | UTF-8 文本上下文；PNG/JPEG 上传为独享会话文件后由原生 agy 读取，仍受模型能力限制 |
| OriginRouter 设备工具 MCP | 会话绑定的设备工具与审批；原生工具审批和设备操作审批可能分为两步 |
| 命令与用量 | 整理后的提示型命令、`/compact`、原生转录 token；不伪造额度余额 |
| 通用 MCP 表单 / URL 授权 | 未接管通用原生响应接口；未知面板保留本地处理 |
| 自动中断后续跑 | 原生路径不声明该能力，不假定存在 ACP 的取消确认 |
| 后台任务管理 / fork | 不声明通用结构化 App 控制 |

菜单驱动按已实测的官方 **agy 1.5.13** 启用；其他版本保留原生进程与基础控制，未经验证的
结构化控件不可用。已记录的 `agy-acp` 会话恢复时仍走 ACP；显式 `originrouter agy-acp`
保留供集成使用。它有结构化表单、直接内容块和 ACP 取消接口，没有原生 TUI，App 不会按启动来源自动选择它。

集成在官方全局 Hooks/MCP 配置中注册独立的环境门控入口，保留用户其他配置。裸 agy 不会
连接 OriginRouter broker，未激活的 MCP 入口不暴露设备工具。只移除本集成使用：

```bash
originrouter agy-integration uninstall
```

再次启动受控 agy 时会重新安装集成。可选安装使用 `originrouter setup --with-agy`，agy 不是 npm
依赖。安装和启动优先继承代理环境变量，缺失时补系统静态代理，只影响本次进程与子进程，不写 Shell
配置；PAC/TUN 与具体联网能力仍取决于环境。多智能体/定时 agy 启动未开放。

所有模式均在设备执行，具体可用项以在线会话能力为准，受版本、平台、登录和账号权限影响。
“不支持”指当前 OriginRouter 集成未提供，不能据此推断官方原生产品没有该功能。
详见 [集成说明](docs/antigravity-integration.md) 与 [验收矩阵](docs/antigravity-feature-parity.md)。

## 安装

### 推荐：官方安装程序

macOS、Linux 和 WSL：

```bash
curl -fsSL https://originrouter.com/install.sh | bash
```

Windows PowerShell：

```powershell
irm https://originrouter.com/install.ps1 | iex
```

安装程序会安装 CLI 并启动引导式初始化。初始化会检查并在确认后补齐缺少的
Claude Code、Codex、OriginRouter 后台服务、受管 Python 和 Local Proxy 运行时。

### 通过 npm 安装

如果你需要自行管理 CLI 版本，可以使用 npm：

```bash
npm install --global @originrouter/cli
originrouter setup
```

运行要求：

- Node.js 22 或更新版本。
- 能访问 npm 以及 Claude Code、Codex 官方安装服务的网络环境。
- 是否需要 Cloud 账户或模型服务凭据，取决于你之后选择的路由。

完整初始化默认包含 Local Proxy，因为它支持本地、第三方、企业网关和自部署模型。
如果你只使用 OriginRouter Cloud 或已经授权的远程设备，不需要接入第三方 API、自部署
模型或本地模型服务，可以明确跳过：

```bash
originrouter setup --no-proxy
```

自动化环境使用 `originrouter setup --yes`，只查看计划使用
`originrouter setup --dry-run`。平台差异和完整安装说明见
[CLI 概览与安装](https://originrouter.com/docs/originrouter-cli/overview)。

## 快速开始

安装完成后，进入项目并打开智能体工作区：

```bash
cd 你的项目
originrouter
```

也可以直接提交目标：

```bash
originrouter "修复登录超时并补充回归测试"
```

如果你想保留智能体原生终端：

```bash
originrouter claude
originrouter codex
```

首次使用 OriginRouter Cloud 路由时，登录并初始化一次：

```bash
originrouter login
originrouter agent setup --cloud
originrouter doctor
```

如果你希望继续使用 Claude Code 或 Codex 官方订阅、登录状态、环境变量和项目配置，
可以使用原生配置模式：

```bash
originrouter claude --native-config
originrouter codex --native-config
```

完整首次运行流程见 [CLI 快速开始](https://originrouter.com/docs/originrouter-cli/quickstart)。

## 接下来可以做什么

### 协调更复杂的任务

智能体工作区会围绕项目保留长期对话，适合规划、实现、独立审查、验证和支持的
跨设备任务。可以通过 `--mode` 选择模式，也可以在工作区内切换。

```bash
originrouter --mode plan-build-verify "准备并验证这次迁移"
```

参阅[智能体工作区](https://originrouter.com/docs/originrouter-cli/agent-workspace)
和[多智能体协作](https://originrouter.com/docs/originrouter-cli/collaboration)。

### 接入模型服务

最简单的方式是使用 Cloud 路由。如果凭据和网络必须留在本机，也可以接入本地模型
服务、企业网关或自部署模型。使用 `provider` 和 `route` 命令配置，Local Proxy
文档会说明可用的接入方式。

参阅[模型与路由](https://originrouter.com/docs/originrouter-cli/routing)
和[模型服务参考](https://originrouter.com/docs/originrouter-cli/providers-reference)。

### 从 App 或另一台设备跟进任务

安装 OriginRouter App 并登录，然后连接一台在线且可信的 CLI 设备。App 可以查看
会话、发送受支持的输入和处理审批。模型共享与工作区访问是相互独立的权限，只有
确实需要时才启用。

参阅[远程访问](https://originrouter.com/docs/originrouter-cli/remote)、
[App 概览](https://originrouter.com/docs/originrouter-app/overview)和
[设备与安全](https://originrouter.com/docs/originrouter-app/devices-security)。

## 常用命令

| 目的 | 命令 |
| --- | --- |
| 打开当前项目 | `originrouter` |
| 运行 Claude Code | `originrouter claude` |
| 运行 Codex | `originrouter codex` |
| 检查安装和连接状态 | `originrouter doctor` |
| 初始化或修复本机环境 | `originrouter setup` |
| 登录或退出账户 | `originrouter login` / `originrouter logout` |
| 管理模型服务 | `originrouter provider` |
| 查看路由 | `originrouter route list` |
| 查看设备和会话 | `originrouter devices` / `originrouter sessions` |
| 查看全部命令和参数 | `originrouter help all` |

运行 `originrouter --help` 可以查看按任务组织的命令概览。

## 安全与数据边界

- 工作区文件、Shell 命令、工具调用和智能体执行都留在 CLI 所在设备。
- 即使只监听 `127.0.0.1`，本地接口仍需要设备密钥。
- 远程控制不会自动暴露模型服务凭据，也不会自动授予工作区访问权限。
- 发送给 Cloud 或其他模型服务的请求，仍按对应服务的条款和数据策略处理。

完整说明见[数据与执行边界](https://originrouter.com/docs/originrouter-concepts/data-boundaries)
和 [SECURITY.md](SECURITY.md)。

## 文档

- [CLI 概览与安装](https://originrouter.com/docs/originrouter-cli/overview)
- [CLI 快速开始](https://originrouter.com/docs/originrouter-cli/quickstart)
- [智能体工作区](https://originrouter.com/docs/originrouter-cli/agent-workspace)
- [模型与路由](https://originrouter.com/docs/originrouter-cli/routing)
- [命令参考](https://originrouter.com/docs/originrouter-cli/commands)
- [CLI 故障排查](https://originrouter.com/docs/originrouter-cli/troubleshooting)
- [OriginRouter App 文档](https://originrouter.com/docs/originrouter-app/overview)

开发环境与贡献规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 第三方产品与许可证

OriginRouter 是独立的开源项目，与 Anthropic 或 OpenAI 没有隶属、背书或赞助关系。
Claude Code 和 Codex 仍然受各自账户、许可证、服务条款和使用政策约束。

智能体生成的内容和执行结果可能不准确或不安全，请在依赖或执行前进行检查。

OriginRouter 使用 [Apache License 2.0](LICENSE)。依赖和运行时许可说明见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
