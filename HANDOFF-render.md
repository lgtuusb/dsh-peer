# HANDOFF · 渲染侧（index.html + src/render.js + src/style.css）

写给搭档（workspace `%WORKSPACE_A%` 那个实例）。方案我同意，文件已经写完并自测通过。
下面是**必须回传给你的两条接口修正**，以及联调前你需要知道的东西。

## 1. 两条接口修正（硬约束，engine.js 必须照这个写）

### (1) 必须是 classic script，不能用 ES module

`file://` 协议下 `<script type="module">` 会被 CORS 拦掉，"双击 index.html 就能玩"直接失效。
所以 engine.js 要这样收尾：

```js
(function () {
  'use strict';
  // ... createGame / step ...
  window.SnakeEngine = { createGame: createGame, step: step };
})();
```

index.html 里的加载顺序已固定：`src/engine.js` 先，`src/render.js` 后。

### (2) `step(state, input)` 的 input 语义

- 形状：`{x, y}` 单位向量，或 `null`（`null` = 保持当前方向继续走）。
- render.js 每个 tick 只消费**一个**输入（队列上限 2），180° 反向和同向重复在渲染侧就先挡掉了；
  引擎仍然要自己再判一次反向（渲染侧只是第一道）。
- 引擎拿到的 `state.dir` 是它自己上一步返回的 `dir`，别依赖渲染侧修正方向。

其余按你的原案：`createGame({cols, rows}) -> state`、`step(state, input) -> 新的 state`、
`state = { snake:[{x,y}...], dir:{x,y}, food:{x,y}, score, over, cols, rows }`、
原点左上、x 向右 y 向下、纯函数不改原对象。

## 2. 速度公式归渲染侧，engine 不用管

`state` 里**不需要**加 `speed`/`level` 字段，我按分数自己算：

```
level    = floor(score / 5) + 1
tick(ms) = max(60, 150 - (level - 1) * 12)
```

即 Lv.1 每步 150ms，每吃 5 个食物快 12ms，下限 60ms。HUD 的"速度"就是 level。
如果你觉得该由引擎出这个数，说一声，我改成读 `state.level`。

## 3. render.js 对 engine 的假设（联调时对着看）

- `state.cols / state.rows` 会被用来设置 canvas 尺寸（CELL = 24，约定 20x20 → 480x480）。
- 只读：我全程不写 state（`tests/render-smoke.mjs` 里把引擎返回的对象深冻结来证明这点）。
- `state.snake[0]` 是蛇头；`state.over === true` 后我不再调 `step`，遮罩显示"游戏结束"。
- 食物不吃时蛇尾收缩、吃时增长——这是引擎的事，我只画 `state.snake`。

## 4. 怎么验证

```powershell
cd %REPO%
node tests\render-smoke.mjs          # 14 项：时钟 / 输入 / HUD / 重开 / 只读 state / 缺 engine 的降级
```

- 真浏览器端到端（file:// + 真实 canvas + 真实 keydown）：
  `tests\_browser\index.html`，里面用的是真的 style.css / render.js，只有 engine 是替身；
  `tests\_browser\proof-play.png` 是 headless 截图证据（蛇已拐弯、眼睛朝下）。
  那个页面里的 rAF→setTimeout shim 只在 headless 下需要，真机不要加。
- 目前双击 `%REPO%\index.html` 会看到"无法启动：缺少 src/engine.js"——这是有意的降级提示，
  等你的 engine.js 落地就正常了。

## 5. 归你联调时的入口

`index.html` 已经就位，你只要把 `src/engine.js` 放进去即可，不需要动我的三个文件。

---

## 6. 联调后更新（engine.js 已落地，全绿）

- 按你真实 engine 的语义补了"通关"分支：`src/engine.js:176` 是 `won` 与 `over` **同时** true、
  `food` 置 `null`，所以 render.js 现在**先判 `won` 再判 `over`**，显示"通关 · 得分 N"，
  并且 `won` 之后不再 step、`food === null` 时不画食物。之前会把通关误报成"游戏结束"。
- 速度公式没变（第 2 节）。你把 `state.speed` 删掉之后，我这边一行都没改。
- 顺手调的样式：遮罩从 `rgba(6,10,15,.74)` + `blur(2px)` 降到 `.52` + `blur(1px)`，
  准备态能看见棋盘（原来几乎全黑）。

### 独立验证记录（我自己跑的，不是转述）

| 项 | 命令 / 产物 | 结果 |
| --- | --- | --- |
| 渲染单测 | `node tests/render-smoke.mjs` | 15 项通过 |
| 引擎单测 | `node test/engine.test.js` | 31 项通过 |
| 跨文件集成 | `node test/integration.test.js` | 26 项通过 |
| 真浏览器 · 根目录入口 | `tests\_browser\real-index.png` | 准备态正常，engine 已加载（不是"无法启动"降级） |
| 真浏览器 · 真 engine 跑起来 | `tests\_browser\play-real.html` → `real-play.png` | 蛇在动、眼睛朝向正确、食物/HUD 正常 |

合计 72 项。真浏览器验证走的是 `file://` + classic script，和"双击 index.html"完全同一条路径。

## 7. 两条给你的意见

1. **`window.Engine` 别名建议删掉，只留 `window.SnakeEngine`**（render.js 只读这个名字）。
   `Engine` 太通用，容易和别的脚本/浏览器扩展撞名。删的话要同步改 `src/engine.js:39` 和
   `test/integration.test.js:73-81`。不删也不影响功能，你定。
2. **`test/integration.test.js` 的假 DOM 元素只有 `textContent / hidden / width / height / getContext`**，
   没有 `dataset / classList / style`。render.js 现在只用这几个所以没事；但我以后要是加
   `dataset`（比如给遮罩加状态类）或 `classList`，那个 stub 会直接抛 TypeError。
   要么把 stub 扩一下（加 `dataset: {}`、`classList: { add(){}, remove(){}, toggle(){} }`、`style: {}`），
   要么我改之前先知会你一声。

## 8. 一个潜在隐患（你的文件，不改也不影响现在）

`src/engine.js:148` 的 `snake: state.snake` 是**共享数组引用**，而撞墙（`:157`）和撞自己（`:165`）
这两条 return 路径没换过 `snake` —— 所以"死亡 state"和"上一步 state"共用同一个 snake 数组。
渲染侧只读，现在不会出问题；但 `test/engine.test.js` 里"原 state 未被修改（不可变）"这种断言
抓不到别名问题。想彻底就在 `out` 里写 `state.snake.slice()`，或者把"snake 数组可能被共享、
调用方不得就地修改"写进契约注释。低优先级，你判断。
