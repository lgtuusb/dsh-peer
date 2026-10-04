# desktop/ —— 把 DSH Pair 打成真·独立 exe

双击 `out\DSH Pair\DSH Pair.exe` 即可，**不需要装 Node，也不需要 Edge**，整个
`out\DSH Pair\` 文件夹可以拷到别的 Windows 机器上用。

## 怎么构建

```powershell
cd %REPO%\desktop
npm install                 # 只装 electron（唯一依赖）
node node_modules\electron\install.js   # 若 npm 跳过了二进制下载，手动补
powershell -ExecutionPolicy Bypass -File build.ps1
```

`build.ps1` 做六步：清目录 → 拷 Electron 运行时 → 把 `electron.exe` 改名成
`DSH Pair.exe` → 装壳到 `resources\app` → 把 `app\` 和 `peer\` 一起装到
`resources\pair\` → 校验 8 个必需文件。产物约 367 MB。

**改了 `app/` 或 `peer/` 之后必须重新跑 `build.ps1`**，因为 `resources\pair` 是一份拷贝。

## 两个坑（都踩过，记下来）

### 1) `ELECTRON_RUN_AS_NODE=1` 会让 electron.exe 变成纯 Node

DSH 为了跑自己的 CLI 会在环境里设这个变量，而我们（小黑/小白）的 shell 都是 DSH 的子进程，
**继承了这个变量**。后果：`electron.exe` 以 Node 身份启动 → `require('electron')` 拿到 undefined
→ `app.requestSingleInstanceLock()` 报 "Cannot read properties of undefined"。

- 从资源管理器双击**不会有**这个变量，所以用户没事；
- 但**在 DSH 的 shell 里测试时必须先清掉**：`Remove-Item Env:ELECTRON_RUN_AS_NODE`
- 反过来，`main.js` 里启动后端时**要主动设** `ELECTRON_RUN_AS_NODE=1`，让 exe 自己充当 Node。

### 2) `app/` 依赖隔壁的 `peer/`，打包要保住相对位置

- `app/lib/sides.js` → `require(path.join(__dirname,'..','..','peer','lib','bridge.js'))`
- `app/lib/project.js` → 同样方式引 `peer/peer.js`

所以包里必须是 `resources/pair/app/` 和 `resources/pair/peer/` **平级**。
一开始只装了 `app`，运行时报 `Cannot find module '...\resources\peer\lib\bridge.js'`。

## 包内布局

```
DSH Pair/
  DSH Pair.exe                 重命名后的 electron.exe
  resources/app/               壳（main.js + package.json）
  resources/pair/app/          dsh-pair 后端（server.js、lib/、public/）
  resources/pair/peer/         桥客户端与协议层（bridge.js、peer.js）
  ...                          Electron 运行时其余文件
```