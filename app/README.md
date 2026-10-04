# dsh-pair —— 一个窗口里同时跟两个 DSH 实例对话

零依赖 Node 后端 + 单页前端。左边一栏 DSH Desktop（工作区 `%WORKSPACE_B%`），右边一栏 DeepSeek Harness
（工作区 `%WORKSPACE_A%`）；输入框可以只发给某一边，也可以两边都发。

## 怎么打开

**推荐：双击 `start-app.cmd`** —— 用 Edge 的 `--app=` 模式开一个**独立窗口**（没有标签页、没有地址栏、
任务栏上有自己的图标，看起来就是个原生程序），默认最大化；找不到 Edge 会退回默认浏览器。

`start.cmd` 是**保底入口**（浏览器标签页版）。两者都是：检查 `node` → 后端没在跑就拉起来 → 探活成功后开窗口。

> **后端现在由看门狗（`bin\watchdog.js`）托管**：它启动 `server.js`，并在 server 异常退出时按
> 2s→5s→15s→30s→60s 退避重启（短时间内连续失败 6 次会放弃并记日志）。
> 起因：这个环境里后端被**外部硬杀**过好几次（日志里 `code=4294967295` 就是 `TerminateProcess` 的签名），
> 用户只看到界面连不上、没有任何痕迹。实测：手动硬杀 server 后约 2 秒自动恢复。
> `stop.cmd` 会**先请求看门狗停止**（删它的 pid 文件即停止信号），再停 server —— 否则它会立刻把 server 拉回来。

桌面图标：跑一次 **`make-desktop-shortcut.cmd`**（桌面出现 `DSH Pair.lnk`，已指向 `start-app.cmd`）。

## 后端挂了怎么办

1. **界面会告诉你**：前端区分"后端整个没了"（fetch 直接失败）和"某一侧离线"（有 HTTP 响应但侧离线）。
   前者会在顶栏显示 `⚠ 后端已停止（127.0.0.1:8787）—— 双击 app\start-app.cmd 重新启动。日志：<路径>`。
2. **看日志**：`logs\server-<port>.log`（启动信息、两侧端点、4xx/5xx、未捕获异常、SIGTERM/SIGINT、每 5 分钟心跳）。
   看门狗另有 `logs\watchdog-<port>.log`（重启决策）。
   **日志里绝不写 token/凭据**——有测试盯着这一条。
3. **启动失败**：`start.cmd` 在 30 秒探活失败后会把**日志的最后 15 行**直接打出来，不需要开控制台猜。
4. 想彻底重来：`stop.cmd` 然后用 `start-app.cmd`。

> 这两个 `.cmd` 都**故意只写 ASCII**：`.cmd` / `.ps1` 里的非 ASCII 文本在中文控制台代码页下会被读错，
> cmd 会把乱码当命令执行（我们两边都在这个坑上栽过）。

**停止服务：双击 `stop.cmd`。**（逻辑在 `bin/stop.js`：先按 `server*.pid` 并用 `/api/health`
交叉核对 pid，pid 文件丢了就按"命令行里含本目录 `server.js`"兜底扫描；两种情况都只动本目录的实例。）

> ⚠️ **不要用 `taskkill /IM node.exe`。** 那会杀掉机器上**所有** node 进程 ——
> 实测已经误杀过一次搭档正在跑的验收服务（端口 8791）。
>
> 这条规矩我自己也违反过一次，代价是误杀了本程序**正在运行的实例**：我把中文写进了 `stop.cmd`
> （中文在 CJK 代码页下被读歪，cmd 把乱码当命令执行），又在 cmd 里嵌套 PowerShell，引号/括号一崩，
> "命令行里含本目录 server.js"就退化成空串，`Contains('')` 恒真 → 变成"杀所有 node"。
> 教训：**`.cmd` 一律纯 ASCII；逻辑放 JS（Node 按 UTF-8 读源码）；PowerShell 用
> `execFileSync` 当单个参数传，绝不在 cmd 里拼引号。**
>
> 另外 `bin/stop.js` 有个 `DSH_PAIR_STOP_DIR` 环境变量，可以指定"停哪个目录的实例"（便于隔离测试）。

想手动跑（看得到日志）：

```powershell
cd %REPO%\app
node server.js --port 8787                 # 用默认两侧
node server.js --port 8787 --sides %REPO%\app\sides.json
```

> 脚本里想传端口给启动器时，用**带引号**的写法：`set "PORT=8787" && start.cmd`。
> 写成 `set PORT=8787 && start.cmd` 会把结尾那个空格也算进值里（`"8787 "`），
> 于是探活 URL 变成 `http://127.0.0.1:8787 /api/health` 而一直失败 ——
> 这个坑我在自查时踩了三次，最后靠把探针的 stderr 落到文件才看出来。

## 界面

- **两栏**：每栏一个 agent。栏头是：状态点 + 名字 + 工作区 + `仅本工作区/全部会话` 开关 + 会话下拉 + 状态胶囊 + `打断` 按钮。
- **两条按真机数据加的过滤/提示**（都不是想当然）：
  - `source.kind` 是 `runtime-context` / `skill-catalog` 的"假 user 消息"（DSH 自己注入的）不显示；
  - `turn.end` 只在 `content.reason.kind` 不是 `completed` 时显示成一条黄色提示 ——
    因为**回合被权限挡下时会静默结束**（消息进了 inbox 但 agent 一步没动，界面上什么都看不到，
    Harness正好踩过这个坑）。提示里会点出"可能是权限预设需要审批"。
- **会话按工作区过滤**：两个 App 的 sessions 目录是**同一份**（junction），所以 Harness 侧的
  `session.list` 会把 Desktop 的会话也列出来（实测 110 条 vs 1 条）。程序按每侧配置里的
  `workspace` 过滤（Harness → `%WORKSPACE_A%`），点栏头那个开关可以临时看全部；过滤后为空会退回全部
  （不会让界面变成"一个会话都没有"），手动选了别的工作区的会话也会标注出来。
- **状态**：`空闲` / `正在跑`（点点会呼吸）/ `离线`。这就是 `session.getState` 的 `status`。
  正在跑时消息列表底部会出现"正在思考…"。
- **输入框**：`Enter` 发送，`Shift+Enter` 换行。上面一排按钮选目标：`两边都发`（默认）/ `只发 Desktop` / `只发 Harness`。
- **消息**：自己的话在右边（蓝色），agent 的回复在左边（带该栏颜色的边）。工具调用折成一行灰字
  （`⚙ pwsh · command · 1712 字符`），**思考过程（reasoning）不显示** —— 那不是回复。
- **离线的一栏不拖垮另一栏**：每栏独立轮询、独立报错，离线时轮询从 1s 降到 5s。
- 发出去的话会先以半透明的"发送中"气泡出现，等时间线里真的出现这条消息就自动撤掉（乐观显示 + 对账）。

## 后端接口

只绑 `127.0.0.1`。除 `/api/health` 外，所有 `/api/*` 都要求请求头 `x-dsh-pair: <令牌>`，
令牌每次启动随机生成并注入到 `index.html` 里。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 探活（启动器用，不需要令牌）：pid/port/side 名 |
| GET | `/api/sides` | 两侧连接状态、identity、endpoint 的 host:port、离线原因 |
| GET | `/api/sessions?side=` | 某侧的会话列表（含 `live` 标记） |
| GET | `/api/timeline?side=&session=&after=&tail=` | 新条目 + `status`(idle/running) + 会话信息；`after` 传上一批的最大 `orderSeq` |
| POST | `/api/send` | `{side, session?, text}` → `startTurn` |
| POST | `/api/interrupt` | `{side, session?}` → `session.interrupt` |

约定：业务失败也返回结构化 JSON（`{ok:false, code, kind, message}`），连接类失败用语义化状态码
（离线 503 / 超时 504 / 其它 502），参数错误 400。

### 为什么有令牌和 Origin 校验

这个接口能**让两个 agent 干活**。浏览器里任何一个网页都能 POST 到 `http://127.0.0.1:8787/`，
所以必须有防线：

1. 只绑 `127.0.0.1`，不对局域网开放；
2. 所有 `/api/*` 要求自定义头 `x-dsh-pair` —— 跨站页面想带头就得走 CORS 预检，而我们不允许；
3. 带 `Origin` 且不是本机来源的直接 403。

## 两侧 endpoint

默认写死在 `lib/sides.js` 里（可用 `--sides <json>` 或环境变量 `DSH_PAIR_SIDES` 覆盖）：

| id | 标签 | endpoint.json |
| --- | --- | --- |
| `desktop` | DSH Desktop（`%WORKSPACE_B%`） | `%USERPROFILE%\.dsh\agents-anywhere\bridge\endpoint.json` |
| `harness` | DeepSeek Harness（`%WORKSPACE_A%`） | `%DSH_HOME%\agents-anywhere\bridge\endpoint.json` |

覆盖用文件长这样：

```json
{ "sides": [ { "id": "desktop", "short": "Desktop", "label": "DSH Desktop",
               "workspace": "%WORKSPACE_B%", "endpointPath": "C:\\...\\endpoint.json" } ] }
```

**每次重连都重新读 endpoint.json**，所以对方重启后 port/token 变了也不用改配置：
`endpoint.json` 的文件指纹一变就立刻重连（不等退避），连不上时按 3s→6s→12s→15s 退避。

## 复用关系（没有重复实现）

- 协议层：`../peer/lib/bridge.js`（搭档按 `peer/SPEC.md` 实现的那份，握手/分帧/超时/通知都在里面）
- "什么算回复正文"：`../peer/peer.js` 的 `messageText`（只认 `type === "message"`，
  把 `reasoning` 排除掉——真机上 reasoning 条目**也带** `content.text`，这是个坑）
- 本目录只多了两件东西：连接管理（`lib/sides.js`）和界面投影（`lib/project.js`）

## 测试

```powershell
cd %REPO%\app
node test\run-tests.js        # 主套件（后端接口 / 前端契约 / 主题 / 日志 / 文档 / 打包契约）
node test\stop-test.js        # 停止与看门狗的隔离测试（会起副本目录，单独跑）
```

### 两个环境坑（都踩过，别再踩）

1. **在 DSH 的 shell 里跑 Electron 前，先 `Remove-Item Env:ELECTRON_RUN_AS_NODE`。**
   DSH 为了跑自己的 CLI 会设这个变量，**我们的 shell 都继承了它**；带着它启动 electron.exe 会退化成
   纯 Node → `require('electron')` 是 undefined → 什么都不打印就退出。
   从资源管理器双击不受影响（用户侧正常）。
2. **`.cmd` 里只写 ASCII。** 中文在 CJK 代码页下会被读歪，cmd 会把乱码当命令去执行
   （我因此误杀过一个正在运行的实例）。
3. 相关：`app/` 依赖平级的 `peer/`（`lib/sides.js`、`lib/project.js`）—— 这条已经由
   `run-tests.js` 的「打包契约」一节机器检查（会打进包的文件跨目录时只能依赖平级 `peer/`，
   并核验 `desktop\out\...\resources\pair\{app,peer}` 的平级关系与快照新旧）。

57 项，全部跑在两个假 bridge 上（复用 `../peer/test/mock-bridge.js`），**不碰真通道**：
令牌注入与强制、跨站 Origin、目录穿越、两侧状态、时间线投影（reasoning 必须被丢掉）、
发送与增量收回复、两边都发、离线侧报错不挂死、对方重启后自动恢复、端口占用时退出码 2、零依赖。

## 已知限制（v1）

- 是**浏览器窗口**，不是原生窗口：没装 Electron 之类的依赖（用户要求零依赖）。
- 只轮询（1s），没订 `runtime.sync.subscribe` 事件流；够用，也少一层状态同步的坑。
- 不做附件、审批、问答转发；不做历史搜索；多标签页之间不同步（各自轮询，互不干扰）。
- `watch` 那类"实时事件流"没做 —— 需要的时候再说。
