# DSH 双实例协作 · 路线图

> 最后更新：2026-09-30 04:0x，由 Harness 实例（工作区 `%WORKSPACE_A%`）维护。
> 如果会话上下文丢了，看这份文件就能接上。

## 目标（用户原话）

1. 两个 DSH 实例（**我** = DeepSeek Harness / `%WORKSPACE_A%`；**它** = DSH Desktop / `%WORKSPACE_B%`）能自动协作，
   不再需要用户当传话筒。分工：**我负责思考和检查，它负责做**。
2. 最终给用户一个**桌面程序**，用户在里面可以直接跟两个 agent 对话。

## 已完成

### 1. 到 DSH Desktop 的通道（可用）
DSH Desktop 自带 `@agents-anywhere/dsh-bridge-next`，在本机开一个带 token 的 JSON-RPC 服务，
端点写在 `C:\Users\user\.dsh\agents-anywhere\bridge\endpoint.json`。

协议（已实测）：TCP + 换行分隔的 JSON-RPC 2.0，首帧必须 `initialize`（带 authToken）。
有用的方法：`ping` / `session.list` / `session.getState` / `session.getSnapshot` /
**`session.startTurn`**（发消息，需 `sessionId`+`content`+`clientMessageId`）。
`session.getState` 返回的 `status`（`idle`/`running`）是"对方在不在干活"的判据。

我的探针脚本（可复用）：
- `%WORKSPACE_A%\tools\bridge\probe.js` — 握手 + 能力 + 会话列表
- `%WORKSPACE_A%\tools\bridge\probe2.js` — getState / getSnapshot 真实结构
- `%WORKSPACE_A%\tools\bridge\send.js` — **发消息**（`--text-file` 传正文，避免引号/编码问题）
- `%WORKSPACE_A%\tools\bridge\state.js` — 读状态与时间线

### 2. 它做的 `peer` 工具（可用）
`%REPO%\peer\peer.js`（它按我的 `SPEC.md` 实现，零依赖 Node CLI）：
`status` / `list` / `state` / `read` / `send --wait --json`，支持 `--endpoint`。
验收标准见 `%REPO%\peer\SPEC.md` 第 5 节（8 条，我还没逐条跑完）。

### 3. 我这边反向的桥：插件 `dsh-peer-bridge`（已装，需重启生效）
`%REPO%\peer-plugin\`（`index.js` + `package.json` + `cordis.patch.yml`）。
它做的是和 agents-anywhere **同一套协议**，所以同一个客户端能同时连两个实例。

安装位置：`C:\Users\user\.dsh\profiles\desktop\node_modules\dsh-peer-bridge`
注册方式：profile 补丁层 `C:\Users\user\.dsh\profiles\desktop\cordis.patch.yml` 里加了一条 `insert`
（备份在 `cordis.patch.yml.bak-before-peer`，**起不来就还原它**）。

关键坑：`export const inject = ['sessions','sessionQuery']` **必须写**，
否则访问 `ctx.sessions` 会抛 `cannot get property "sessions" without inject`。
另一个坑：宿主会**缓存 ESM 模块**，改插件代码后必须重启 App 才生效。

我的端点会写到 `%DSH_HOME%\agents-anywhere\bridge\endpoint.json`。

## 待办

- [ ] 重启后验证我的桥：`node %REPO%\peer\peer.js status --endpoint %DSH_HOME%\agents-anywhere\bridge\endpoint.json`
      然后 `list`、`read`，最后做一次真实的 `send`（注意别发到当前活跃会话里，会打断对话）
- [ ] 跑 `peer.js` 的 8 条验收标准
- [ ] **桌面程序**：一个窗口里同时跟我们俩对话
  - 后端：零依赖 Node 服务，读两个 `endpoint.json`，对两边说同一套 JSON-RPC
  - 前端：单页聊天界面（两个 agent 各一栏，或一个输入框 + @ 指定对象）
  - 交付：`.cmd` 启动器 + 桌面快捷方式（造快捷方式的方法见 `%REPO%\docs\`）
  - 分工：我出规格和验收，它实现

## 已知的坑

- PowerShell 5.1 按 ANSI 读 `.ps1`：脚本里**别写中文**，或者存成带 BOM 的 UTF-8
- 命令行传长中文会被引号/编码搞坏：一律走 `--text-file`
- 用户电脑上两个 App **共用 profile**（`%DSH_HOME%\profiles` 是指向 `C:\Users\user\.dsh\profiles` 的 Junction），
  但 **DSH_HOME 不同**（我 `%DSH_HOME%`，它 `C:\Users\user\.dsh`），所以凭据、会话库、endpoint 各一份
