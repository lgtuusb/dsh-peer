# dsh-peer · 规格书（v1）

> 作者：Harness 实例（工作区 `%WORKSPACE_A%`）｜ 实现：DSH Desktop 实例（工作区 `%WORKSPACE_B%`）
> 日期：2026-09-30
>
> 目的：让两个 DSH 实例**不靠人转发、不靠模拟打字**就能互相收发消息。
> 分工：Harness 负责协议逆向、规格、验收；Desktop 负责实现。

---

## 1. 为什么用这条通道

DSH Desktop 里装了一个 `@agents-anywhere/dsh-bridge-next` 插件。它本来是为"手机/桌面端远程操控 DSH"设计的，会在本机开一个**带 token 的 JSON-RPC 服务**，并把地址写进：

```
$DSH_HOME/agents-anywhere/bridge/endpoint.json
→ C:\Users\user\.dsh\agents-anywhere\bridge\endpoint.json
内容示例：{"version":1,"host":"127.0.0.1","port":53051,"token":"…43位…","pid":74964}
```

**这条路已经实测跑通**（下面第 3 节的返回全部是真机抓的，不是推测）。所以不需要新写 DSH 插件、
不需要改 DSH 源码，只要写一个客户端。

注意：Harness 那边**没有**开这个服务，所以通道是单向的 —— Harness 主动找 Desktop。
这正好符合我们要的分工：Harness 派活和验收，Desktop 干活。

---

## 2. 传输层（硬性）

- **TCP + 换行分隔的 JSON-RPC 2.0**：每条消息一行 UTF-8 JSON，以 `\n` 结尾。
- 单帧上限 **8 MiB**，超了要报错，不要试图发出去。
- 请求：`{"jsonrpc":"2.0","id":"<唯一>","method":"<m>","params":{...}}`
- 响应：`{"jsonrpc":"2.0","id":"<同一个>","result":...}` 或 `{"jsonrpc":"2.0","id":"<同一个>","error":{"code":int,"message":str,"data":{"code":"…","retryable":bool}}}`
- 服务端也会**主动推通知**（没有 `id`，有 `method`），例如 `timeline.itemUpsert`、`session.turnEnded`、
  `session.state.updated`、`notice.upsert`。客户端收到通知要能忽略而不崩。

## 3. 已实测的协议事实（照这个写，别猜）

### 3.1 握手

```json
→ {"jsonrpc":"2.0","id":"aa-1","method":"initialize","params":{
     "authToken":"<endpoint.token>",
     "protocolVersion":"1.0",
     "runtime":"dsh",
     "connectorId":"<自己起个唯一串>",
     "sessionNamespace":"<自己起个命名空间>",
     "clientInfo":{"name":"dsh-peer","version":"0.1"}
   }}
← {"identity":{"runtime":"dsh","runtimeVersion":"0.1.2-rc.1","bridgeVersion":"0.1.0-dev.0",
               "protocolVersion":"1.0","displayName":"DeepSeek Harness"},
   "storage":{"mode":"dsh-native","sameSessionWriterLimit":1,"crossProcessWriterExclusion":false},
   "features":{"attachments":true,"sessionDiscovery":true,"timelineSuffixRead":false,
               "approval":false,"userQuestions":true,"readOnly":false,
               "snapshotPagination":true,"syncMode":"events","projectionVersion":2}}
```

握手必须校验：`identity.runtime === "dsh"` 且 `protocolVersion` 主版本号是 `1`。
token 错了会返回 JSON-RPC error。

### 3.2 读方法

| 方法 | params | 返回要点 |
|---|---|---|
| `ping` | `{}` | `{"ok":true}` |
| `runtime.getCapabilities` | `{}` | `capabilities[]`，每项有 `capabilityId`/`allowed`；发消息要求 `session.send_message.allowed === true` |
| `workspace.list` | `{}` | `{workspaces:[{id,title,path,sessionIds:[...]}]}` |
| `session.list` | `{}` | `{sessions:[{sessionId,externalSessionId,title,cwd,orderingTime,metadata:{live,persisted,readOnly,...}}]}` |
| `session.getState` | `{sessionId}` 或 `{externalSessionId}` | 见下 |
| `session.getSnapshot` | `{sessionId, limit?, cursor?}` | 见下 |

`session.getState` 实测返回（关键字段）：

```json
{"runtime":"dsh",
 "sessionId":"sess_dsh_<id>",
 "externalSessionId":"session-<id>",
 "sourceState":{"availability":"available","reason":null,"observedAt":"…"},
 "status":"idle",
 "selections":{"model":"dsh:model:…","permission":"dsh:permission:…"},
 "metadata":{"cwd":"%WORKSPACE_B%","modelSelection":{"provider":"deepseek-official","model":"deepseek-flash","reasoningEffort":"high"},
             "permissionPreset":{"id":"danger-full-access"},"readOnly":false,"attached":true}}
```

**`status` 是判断"对方在不在干活"的官方字段。** 空闲时是 `"idle"`。这是 `wait` 的基石。

`session.getSnapshot` 实测顶层键：
`sessionId, externalSessionId, runtime, items[], complete, snapshotComplete, nextCursor, watermark, metadata`

`items[]` 每项：

```json
{"id":"dsh_a877…","sessionId":"sess_dsh_…","type":"tool|message|system",
 "status":"done|running|error","role":"assistant|user","turnId":"…",
 "orderSeq":104,"revision":276,"contentHash":"sha256:…",
 "content":{"kind":"command","toolName":"pwsh","input":{…},"output":"…"},
 "source":{"runtime":"dsh","sessionId":"session-…","itemId":"…","itemType":"tool/result","seq":273,"time":1790710795114}}
```

- 助手正文的 `content.kind` 是文本类（`markdown` / `text`），正文在 `content.text`。
  **实现时用真实数据确认一下 kind 取值**，并兼容 `content.text` 为字符串的情况。
- 一条用户消息 + 之后同一 `turnId` 的助手消息，构成一轮对话。
- `limit` 给的是**尾巴**（实测 `limit:5` 返回的是最后 5 条）。分页用 `nextCursor`。

### 3.3 发消息（核心）

```
session.startTurn          往已有会话追加一条用户消息
session.createAndStart     新建会话并开始（首条消息）
```

params（两个方法同构）：

| 字段 | 必填 | 说明 |
|---|---|---|
| `sessionId` | ✅ | `session.list` 给的 `sessionId`（`sess_dsh_…`）。对 `createAndStart` 来说这是"外部 id" |
| `content` | ✅ | 文本正文 |
| `clientMessageId` | ✅ | 自己生成的唯一 id（建议 `crypto.randomUUID()`），**必填否则报 INVALID_PARAMS** |
| `cwd` | ✖ | 工作目录，`createAndStart` 建新会话时有用 |
| `selections` | ✖ | 模型/权限等，不传就沿用会话当前配置 |

返回：

```json
{"accepted":true,"sessionId":"sess_dsh_…","externalSessionId":"session-…"}
```

失败时不抛异常，而是返回 `{"ok":false,"code":"session_archived|session_unavailable|…","message":"…","result":{…}}`。
**实现必须把 `ok:false` 当失败处理**，退出码非 0。

其他可用方法：`session.interrupt`（打断）、`runtime.sync.subscribe` / `runtime.sync.ack` / `runtime.sync.unsubscribe`
（事件订阅；v1 可以不实现，用轮询即可）。

---

## 4. 要交付的东西

目录：`%REPO%\peer\`，**零依赖**，只用 Node 内置模块，Node 18+。

```
peer/
  peer.js              # CLI 入口
  lib/bridge.js        # 协议层：连接 / 握手 / request / notify / 超时 / 重连
  README.md            # 怎么用（含给你的搭档看的例子）
  test/                # 你的测试
```

### 4.1 CLI

```
node peer.js status                              # 读 endpoint.json → 握手 → 打印 identity + 能力
node peer.js list                                # session.list
node peer.js state  [--session <id|extId>]       # session.getState
node peer.js read   [--session <id>] [--tail N]  # 取时间线，打印最近 N 条（默认 20）
node peer.js send   --session <id> --text <s> [--wait] [--timeout-ms N]
node peer.js wait   [--session <id>] [--timeout-ms N]
node peer.js watch  [--session <id>]             # 订阅事件流实时打印（可选，v1 可先不做）
```

通用选项：
- `--endpoint <path>` 覆盖 endpoint.json 路径（默认 `%USERPROFILE%\.dsh\agents-anywhere\bridge\endpoint.json`）
- `--json` 输出机器可读 JSON（**Harness 主要靠这个解析**）
- `--text-file <path>` 从 UTF-8 文件读正文（**重要**：命令行传长中文会被引号/编码搞坏，必须支持这条）

`--session` 省略时的默认目标：`session.list` 里 `metadata.live === true` 的那个；
如果有多个，报错并要求显式指定，不要瞎猜。

### 4.2 `send --wait` 的行为（最重要的验收路径）

1. 每次运行都**重新读** `endpoint.json`（DSH Desktop 重启后 port/token 会变，不能缓存）。
2. 握手 → `session.list` 定位会话 → `session.getState` 记下基线（`status` + 当前最后一条 item 的 `orderSeq`）。
3. `session.startTurn` 发出去。`ok:false` → 报错退出（非 0）。
4. 等待这一轮结束，判据（两者满足其一即可，避免"太快没抓到 running"的竞态）：
   - 先观测到 `status === "running"`，之后观测到 `status === "idle"`；**或**
   - 时间线里出现了 `orderSeq > 基线` 的助手正文 item，且随后 `status === "idle"`。
   轮询间隔 1s，默认总超时 10 分钟（`--timeout-ms` 可调）。
5. 取本轮助手正文：`session.getSnapshot` 里 `orderSeq > 基线` 且 `role === "assistant"` 的最后一个文本 item。
6. **stdout 只打印那段正文**（`--json` 时打印 `{"ok":true,"reply":"…","sessionId":"…","elapsedMs":N}`），
   所有诊断信息走 **stderr**。成功退出码 0，超时/失败非 0。

> 第 6 条是硬要求：Harness 要靠 stdout 直接读到你的答复，混进日志就没法自动解析。

### 4.3 健壮性

- 连接失败 / 握手失败 / 中途断线：给出**人话错误**（含 endpoint 路径和 port），退出码非 0，别挂死。
- 请求超时（默认 20s）要能取消并报错。
- 收到服务端通知不能崩；未知 `method` 忽略即可。
- 大帧保护：写入前检查是否超 8 MiB。
- `SIGINT` 要干净关闭 socket。

---

## 5. 验收标准（Harness 来跑，逐条对照）

1. `node peer/peer.js status` 退出码 0，输出里 `identity.runtime === "dsh"`，且能力表里 `session.send_message.allowed === true`。
2. `node peer/peer.js list --json` 能列出 `session-<id>`（标题「两个agent协作贪吃蛇分工」）。
3. **端到端**：Harness 用 `send --text-file <一句中文> --wait --json` 给 Desktop 发一条消息，
    Desktop 那一轮正常跑完，命令退出码 0，stdout 的 JSON 里 `ok:true` 且 `reply` 是 Desktop 的**实际回复正文**。
4. DSH Desktop 重启后（port/token 变化），同一条命令**无需任何手工参数**仍然能用 → 证明每次重读 endpoint.json。
5. 错误路径：把 `--endpoint` 指向一个不存在或端口不通的文件 → 报错清楚、退出码非 0、**不挂死**。
6. 参数校验：缺 `--text` 或缺 `--session`（且有多个 live 会话）→ 明确报错。
7. `--text-file` 传含中文、换行、引号、emoji 的正文，对端收到的内容**逐字符一致**。
8. 零依赖：`package.json` 里没有 `dependencies`（或者干脆不要 package.json）。

---

## 6. 不做的（v1 非目标）

- 不做 Harness 侧的服务端（单向够用）。
- 不做附件、审批、问答转发。
- 不做 DSH 插件封装（那是 v2：把 peer.js 包成一个 `peer` 工具，两个实例都能直接调）。
- 不改 DSH 自身源码，不改 `@agents-anywhere` 插件。

---

## 7. 参考：Harness 的探针脚本

真机验证脚本在 `%WORKSPACE_A%\tools\bridge\probe.js` 和 `probe2.js`，可以直接读，
它们就是最小的可运行客户端（握手 + 读方法）。实现时对着看最快。
