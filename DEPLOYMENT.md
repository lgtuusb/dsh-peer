# 参考部署：本项目的原始两实例配置

> 这是本项目**实际跑起来的那套配置**，已做隐私清理。
> 不是"唯一正确装法"，只是一个**验证过能跑通的样例**。

---

## 一、两个实例的实际参数

| | 实例 A（代号"小黑"） | 实例 B（代号"小白"） |
|---|---|---|
| 程序 | `DeepSeek Harness.exe` v0.2.0.0 | `DSH Desktop.exe` v2.0.9.0 |
| 安装位置 | `%LOCALAPPDATA%\Programs\DeepSeek Harness\` | `%LOCALAPPDATA%\Programs\DSH Desktop\` |
| **DSH_HOME** | `D:\dsh-home-a` | `%USERPROFILE%\.dsh`（默认） |
| 工作区 | `D:\ws-a` | `D:\ws-b` |
| API key | 各自一把（**两个不同的账号**） | 各自一把 |
| 分工 | 设计、协议、复验、文档 | 实现、测试、启动器 |

> **注意**：本例里两个实例是**两个不同的程序**（Harness 和 Desktop）。
> 但**这不是必须的** —— 同一个程序启动两次、给两个 `DSH_HOME` 也完全可行，见《INSTALL.md》。

---

## 二、实例 A 的启动脚本

`D:\dsh-home-a\launch-a.cmd`：

```cmd
@echo off
rem 用独立的 DSH_HOME，让这个实例拥有自己的 API key、会话历史与插件
set "DSH_HOME=D:\dsh-home-a"
start "" "%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe"
```

桌面快捷方式指向这个 `.cmd`（而不是直接指向 exe），这样双击就带上了环境变量。

> ⚠️ **从别的程序里启动另一个 DSH 实例时，必须先清掉自己的环境变量**。
> 否则子进程会继承你的 `DSH_HOME`，启动成"首次设置向导"。
> 正确做法：`set "DSH_HOME="` 或在新进程里显式指定。

---

## 三、实例 B 的启动

`DSH Desktop.exe` **不需要脚本** —— 它默认就用 `%USERPROFILE%\.dsh` 作为 DSH_HOME。

双击即可。

---

## 四、插件安装（两边都要）

### 实例 A

```cmd
mkdir "%DSH_HOME%\profiles\desktop\node_modules\dsh-peer-bridge"
xcopy /E /I peer-plugin\* "%DSH_HOME%\profiles\desktop\node_modules\dsh-peer-bridge\"
```

在 `%DSH_HOME%\profiles\desktop\cordis.patch.yml` **末尾**追加：

```yaml
- insert:
    - id: dsh-peer-bridge
      name: 'dsh-peer-bridge'
```

### 实例 B

```cmd
mkdir "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-peer-bridge"
xcopy /E /I peer-plugin\* "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-peer-bridge\"
```

同样在它的 `cordis.patch.yml` 末尾追加那三行。

### 然后**两个实例都要重启**

插件只在启动时加载。

### 验证

两个实例各自的 `DSH_HOME` 下都应该出现：

```
<DSH_HOME>\agents-anywhere\bridge\endpoint.peer.json
```

---

## 五、一个必须注意的坑：端点文件会打架

DSH 自带的 `agents-anywhere` 桥**也会写** `endpoint.json`。如果我们的插件也写同一个文件，**谁后写谁赢**，赢家是官方桥的话，客户端就会拿到一个**不支持新建会话**的端点。

**本插件的做法**：

```
endpoint.peer.json   ← 权威（本插件写，客户端读这个）
endpoint.json        ← 兼容（同时也写一份，让老客户端还能用）
```

**客户端永远读 `endpoint.peer.json`。**

---

## 六、实例 A 上的辅助工具

`tools/bridge/` 是实例 A 侧的运维脚本：

| 脚本 | 用途 |
|---|---|
| `send.js` | 给别人发消息（`--text-file` 传长文本，绕开引号问题） |
| `state.js` | 读对方会话状态与最近消息 |
| `call.js` | 直接调桥的任意 RPC 方法（参数用 `@文件` 传） |
| `reload-plugin.ps1` | 热重载插件（改完插件不用重启 App） |

> `reload-plugin.ps1` 只在**实现了重载接口**的实例上有效。
> 对方跑的是旧版插件时，只能重启。

---

## 七、踩过的坑（按严重程度）

| # | 现象 | 根因 | 解法 |
|---|---|---|---|
| 1 | 消息投进了错的会话，对方收不到 | 客户端按 `createdAt` 排序，**刚建的空会话排最前**，于是被默认选中 | 改用**会话文件的真实写入时间**排序 |
| 2 | `＋新建` 报 502 | 官方桥不支持新建会话，客户端却连到了官方端点 | 客户端改读 `endpoint.peer.json` |
| 3 | 插件改了不生效 | 插件只在启动时加载，两边都得重启 | 或用 `reload-plugin.ps1`（仅本侧有效） |
| 4 | 新建的会话"找不到" | 空会话体积小（约 15KB），被"去空壳"过滤器删掉 | 给过滤器加例外：**最近被动过的会话一律保留** |
| 5 | 从脚本启动另一个实例，它变成"首次设置向导" | 子进程继承了调用者的 `DSH_HOME` | 启动前清空该变量 |
| 6 | 端口/token 隔一会儿就失效 | 桥每次重启都会换端口和 token | 永远从端点文件读，不要缓存 |

---

## 八、这套配置的实测效果

- 端到端发消息 → 对方模型启动 → 回复读回：**约 10 秒**
- 两侧状态、会话列表、时间线均可实时查询
- 两边各自独立运行，一边重启不影响另一边

**延迟主要来自**：HTTP → 后端 → 桥 → 注入目标会话 → 对方模型冷启动。**比同进程内派活慢，这是这个架构的固有代价。**