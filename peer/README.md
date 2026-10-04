# dsh-peer · 两个 DSH 实例互相收发消息

零依赖 CLI（只用 Node 内置模块，Node 18+）。走 DSH Desktop 里 `@agents-anywhere/dsh-bridge-next`
插件本来就在跑的本地 JSON-RPC 服务，**不需要人转发、不需要模拟打字**。

- 协议层：`lib/bridge.js`（读 endpoint / 连接 / 握手 / request / 超时 / 通知 / 帧保护）
- CLI：`peer.js`（命令、会话选择、等待回合结束、输出）
- 规格来源：`SPEC.md`（搭档写的，含真机抓包事实）

> 不碰 `%WORKSPACE_A%\tools\bridge\` 下的探针——那是搭档的文件。

---

## 快速开始

```powershell
cd %REPO%\peer

node peer.js status                    # 握手成功？能力表里 send_message 允许吗？
node peer.js list --json               # 有哪些会话（找 externalSessionId）
node peer.js state --session session-<id> --json   # status: idle / running
node peer.js read  --session session-<id> --tail 10 # 最近 10 条时间线

# 发一条并等回复（长中文请务必走 --text-file）
node peer.js send --session session-<id> --text-file msg.txt --wait
node peer.js send --session session-<id> --text-file msg.txt --wait --json
```

### 给自动化用（最重要的一条）

`send --wait` 的 **stdout 只有对方那段回复正文**；`--json` 时 stdout 是且仅是一个 JSON：

```json
{"ok":true,"reply":"…对方的实际回复正文…","sessionId":"sess_dsh_…","externalSessionId":"session-…","orderSeq":123,"chars":456,"elapsedMs":7890,"polls":8}
```

所有诊断（`[info]`/`[warn]`/错误原因）一律走 **stderr**。所以：

```powershell
# PowerShell
$r = node %REPO%\peer\peer.js send --session $ext --text-file .\q.txt --wait --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "发送失败" }
$r.reply
```

```bash
# bash
reply=$(node peer.js send --session "$EXT" --text-file q.txt --wait) || exit $?
printf '%s\n' "$reply"
```

失败时（超时 / 被拒 / 拿不到正文）**stdout 是空的**，靠退出码判断，原因在 stderr。

### 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 2 | 用法/参数错误（缺 `--text`、多个 live 会话没指定 `--session`、帧超 8 MiB） |
| 3 | endpoint.json 读不到 / 不是合法 JSON |
| 4 | 连接失败 / 握手失败 / 中途断线 |
| 5 | 协议错误（JSON-RPC error）或能力不足（`session.send_message` 不是 allowed） |
| 6 | 发送被拒绝（`ok:false` 或 `accepted !== true`） |
| 7 | 等待超时 |
| 8 | 回合已结束但拿不到助手正文 |
| 9 | 其他内部错误 |

---

## 选项

| 选项 | 说明 |
| --- | --- |
| `--session <id\|externalId>` | 目标会话，两套 id 都认。省略时取**唯一**的 live 会话；有多个就报错并列出候选，不替你猜 |
| `--text <s>` | 正文（短文本可用；引号/换行/emoji 有风险） |
| `--text-file <path>` | 从 UTF-8 文件读正文，**逐字符原样发送**（含换行、BOM）。长中文必须用这个 |
| `--wait` | 发送后等这一轮跑完并打印回复 |
| `--timeout-ms <N>` | 等待总超时，默认 600000（10 分钟） |
| `--interval-ms <N>` | 轮询间隔，默认 1000 |
| `--tail <N>` | `read` 取最近 N 条，默认 20 |
| `--json` | 机器可读输出 |
| `--full` | `read` 时连工具 `output` 一起输出（默认省略，只给长度） |
| `--endpoint <path>` | 覆盖 endpoint.json 路径，默认 `%USERPROFILE%\.dsh\agents-anywhere\bridge\endpoint.json` |

---

## `send --wait` 干的事（按 SPEC 4.2）

1. **每次运行都重新读 endpoint.json**：不缓存 port/token，所以 DSH Desktop 重启后同一条命令照用。
2. 握手 → `session.list` 定位会话 → `session.getState` 记基线（`status` + 最后一条 `orderSeq`）。
3. `session.startTurn` 投递（`clientMessageId` 用 `crypto.randomUUID`）。`ok:false` 一律当失败。
4. 每 1s 轮询，判据（满足其一）：先看到 `running` 再看到 `idle`；**或**时间线出现 `orderSeq > 基线`
   的助手正文且随后 `idle`。（后者用来兜住"这一轮快到没抓到 running"）
5. 取回复：`orderSeq` 大于基线、`type === "message" && role === "assistant"` 的**最后一条**文本。
6. 打印：`--json` 打那段 JSON，否则只打正文；诊断全走 stderr。

比规格多做的一件事：如果时间线里能认出**我们刚发出去的那条用户消息**（正文逐字相等），就用它的
`orderSeq` 当真正的基线。这样即使目标会话当时正在跑别的回合，也不会把上一轮的正文当成回复；
真出现这种情况会在 stderr 上打 `[warn]`。

---

## 真机踩到的坑（写实现时踩过，写在这里省你时间）

1. **`reasoning` 条目也带 `content.text`。** 时间线里 `type:"system", content.kind:"reasoning"` 的
   思考过程同样有 `text` 字段。只按 `content.text` 取正文会把模型的思考当成回复。
   必须限定 `type === "message"`（用户/助手正文都是 `type:"message"`, `content.kind:"markdown"`）。
2. **内部 `sessionId` 每次连接都会重新生成，`externalSessionId` 才稳定。** 实测同一个会话在不同次
   连接里依次拿到 `sess_dsh_<id>`、`sess_dsh_<id>`、`sess_dsh_<id>`、
   `sess_dsh_<id>`，而 `externalSessionId` 一直是 `session-<id>`。
   所以：**配置里一律写 `externalSessionId`**，别把 `sess_dsh_…` 存下来复用（复用会直接报
   "找不到会话"并列出候选）。工具自己在一次运行内是自洽的：先 `session.list` 拿当下的 id，再往下用。
3. **`session.list` 里的 live 标记是 `metadata.live === true`**（同层还有 `persisted/readOnly/sync`）。
4. `session.getSnapshot` 的 `limit` 给的是**尾巴**；工具条目的 `output` 可能很大，所以 `read` 默认
   只给长度，`--full` 才给内容。
5. 服务端会主动推通知（`timeline.itemUpsert` / `session.turnEnded` / `notice.upsert` …），
   客户端必须忽略未知 method 而不能崩 —— `lib/bridge.js` 里只计数不处理。

---

## 测试

```powershell
cd %REPO%\peer
node test\run-tests.js
```

全部跑在本地假 bridge（`test/mock-bridge.js`）上，**不碰真通道**，所以 DSH Desktop 正在跑也不会
往任何会话里投消息。覆盖 SPEC 第 5 节 8 条验收 + 第 4.3 节健壮性（8 MiB 帧保护、请求超时、
`ok:false`、通知轰炸、快到抓不到 running 的竞态、目标会话原本在跑别的回合、没有正文、参数校验、
endpoint 换端口/token、端口不通、坏 JSON、token 错、能力不足、`watch`）。

## v1 不做的

单向（只从这一侧主动找对方）；不做附件/审批/问答转发；`watch` 是 2s 轮询而不是事件订阅
（`runtime.sync.subscribe` 没用，够用就行）；不封 DSH 插件、不改 DSH 源码和 `@agents-anywhere` 插件。

Windows 上 `SIGINT` 由 Node 转成 `SIGTERM` 语义，`watch` 在控制台按 Ctrl-C 能干净退出；
用 `child.kill('SIGINT')` 从别的程序杀它则不保证走到清理分支。
