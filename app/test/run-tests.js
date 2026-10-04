/*
 * test/run-tests.js —— dsh-pair 后端/接口验收
 * ---------------------------------------------------------------
 * 起两个假 bridge（复用 ../../peer/test/mock-bridge.js），把本目录的 server.js 当子进程跑，
 * 然后只用 HTTP 驱动它。**不碰真通道**，所以 DSH Desktop / Harness 正在跑也不会被投消息。
 *
 * 跑法：node test/run-tests.js
 */
'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn, spawnSync } = require('child_process');

const APP_DIR = path.join(__dirname, '..');
const SERVER = path.join(APP_DIR, 'server.js');
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const { createMockBridge, writeEndpoint, item } = require(path.join(APP_DIR, '..', 'peer', 'test', 'mock-bridge.js'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir, 'dsh-pair-app-test-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`);
  }
}
function section(title) {
  console.log(`\n== ${title} ==`);
}

function freePort {
  return new Promise((resolve, reject) => {
    const s = net.createServer;
    s.on('error', reject);
    s.listen(0, '127.0.0.1',  => {
      const port = s.address.port;
      s.close( => resolve(port));
    });
  });
}

const SESSION = {
  sessionId: 'sess_<id>',
  externalSessionId: 'session-apptest-0001',
  title: '桌面程序测试会话',
  cwd: '%WORKSPACE_B%',
  orderingTime: 1,
  metadata: { live: true, persisted: true, readOnly: false }
};

function mockOptions(extra) {
  return Object.assign(
    {
      sessions: [SESSION],
      items: [
        item({ orderSeq: 1, type: 'message', role: 'user', content: { kind: 'markdown', text: '第一条测试消息' } }),
        item({
          orderSeq: 2,
          type: 'system',
          role: 'assistant',
          content: { kind: 'reasoning', text: '这是思考过程，不该出现在界面上' }
        }),
        item({
          orderSeq: 3,
          type: 'tool',
          role: 'assistant',
          content: { kind: 'command', toolName: 'pwsh', output: 'X'.repeat(1234), isError: false }
        }),
        item({ orderSeq: 4, type: 'message', role: 'assistant', content: { kind: 'markdown', text: '第一条助手回复' } })
      ]
    },
    extra || {}
  );
}

// 所有由本套件 spawn 的进程都登记在这里：即使中途异常退出，也要在 exit 时全部收掉。
// （实测漏过 4 个 server 残留在随机端口上 —— 多实例测试最怕这种污染）
const SPAWNED = new Set;
process.on('exit',  => {
  for (const child of SPAWNED) {
    try {
      child.kill;
    } catch (err) {
      /* 忽略 */
    }
  }
});

// ---------------------------------------------------------------- 启动被测服务
async function startServer(sidesPath, port) {
  const child = spawn(process.execPath, [SERVER, '--port', String(port), '--sides', sidesPath], { cwd: APP_DIR });
  SPAWNED.add(child);
  child.on('close',  => SPAWNED.delete(child));
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });

  let token = null;
  const deadline = Date.now + 20000;
  while (Date.now < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server 提前退出 code=${child.exitCode}\n${stderr || stdout}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      const html = await res.text;
      const m = html.match(/window\.__PAIR_TOKEN__ = '([0-9a-f]{32})'/);
      if (m) {
        token = m[1];
        break;
      }
    } catch (err) {
      /* 还没起来 */
    }
    await sleep(150);
  }
  if (!token) throw new Error(`拿不到注入的令牌；stderr=${stderr}`);

  return {
    child,
    port,
    token,
    stdout:  => stdout,
    stderr:  => stderr,
    async stop {
      if (child.exitCode !== null) return;
      await new Promise((resolve) => {
        child.on('close', resolve);
        child.kill;
        setTimeout(resolve, 1500);
      });
    }
  };
}

async function api(srv, pathname, opts) {
  const o = opts || {};
  const headers = Object.assign({ 'x-dsh-pair': srv.token }, o.headers || {});
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${srv.port}${pathname}`, {
    method: o.method || 'GET',
    headers,
    body: o.body === undefined ? undefined : JSON.stringify(o.body)
  });
  let json = null;
  try {
    json = await res.json;
  } catch (err) {
    /* 可能不是 JSON */
  }
  return { status: res.status, ok: res.ok, json };
}

/** 找一个本机浏览器（Edge/Chrome）跑真前端；找不到就跳过这项检查 */
function findBrowser {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

async function browserDom(url, budgetMs) {
  const browser = findBrowser;
  if (!browser) return null;
  const child = spawn(
    browser,
    [
      '--headless',
      '--disable-gpu',
      '--no-first-run',
      `--user-data-dir=${path.join(TMP, 'browser-profile')}`,
      '--window-size=1400,900',
      `--virtual-time-budget=${budgetMs}`,
      '--dump-dom',
      url
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  );
  let html = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { html += d; });
  await new Promise((resolve) => {
    child.on('close', resolve);
    setTimeout( => {
      child.kill;
      resolve;
    }, 30000);
  });
  return html;
}

// ---------------------------------------------------------------- 主流程
function isPortListening(port) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue) -ne $null`], { encoding: 'utf8' });
  return /True/i.test(r.stdout || '');
}

async function main {
  console.log(`dsh-pair app 验收测试  (tmp=${TMP})`);
  // 记下跑测试前 logs/ 里已有的文件，结束时只删"本次新增的"，绝不碰正在跑的实例的日志
  const LOG_DIR = path.join(APP_DIR, 'logs');
  const logsBefore = new Set(fs.existsSync(LOG_DIR) ? fs.readdirSync(LOG_DIR) : []);

  const mockA = createMockBridge(mockOptions);
  const mockB = createMockBridge(
    mockOptions({
      sessions: [
        Object.assign({}, SESSION, {
          sessionId: 'sess_<id>',
          externalSessionId: 'session-apptest-B',
          kind: 'agents-anywhere' // 让浏览器检查里能看到 📱 标记
        })
      ],
      onStartTurn: (params, api2) => {
        api2.appendItem(item({ type: 'message', role: 'user', content: { kind: 'markdown', text: params.content } }));
        api2.state.status = 'idle';
      }
    })
  );
  await mockA.listen;
  await mockB.listen;

  const epA = path.join(TMP, 'endpoint-desktop.json');
  const epB = path.join(TMP, 'endpoint-harness.json');
  writeEndpoint(epA, mockA);
  const deadPort = await freePort; // 先给 B 一个没人听的端口，模拟"搭档的桥还没生效"
  fs.writeFileSync(epB, JSON.stringify({ version: 1, host: '127.0.0.1', port: deadPort, token: 'x', pid: 1 }), 'utf8');

  const sidesPath = path.join(TMP, 'sides.json');
  fs.writeFileSync(
    sidesPath,
    JSON.stringify({
      sides: [
        { id: 'desktop', short: 'Desktop', label: 'DSH Desktop', workspace: '%WORKSPACE_B%', endpointPath: epA },
        { id: 'harness', short: 'Harness', label: 'DeepSeek Harness', workspace: '%WORKSPACE_A%', endpointPath: epB }
      ]
    }),
    'utf8'
  );

  const port = await freePort;
  const srv = await startServer(sidesPath, port);

  try {
    // ------------------------------------------------------------ 静态与令牌
    section('页面与令牌');
    {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      const html = await res.text;
      ok('GET / 返回 HTML', res.status === 200 && /<title>DSH 双实例对话<\/title>/.test(html));
      ok('占位符已换成真令牌，且 window.__PAIR_TOKEN__ 没被误替换',
        html.includes(srv.token) && !html.includes('__PAIR_TOKEN_VALUE__') && html.includes("window.__PAIR_TOKEN__ = '" + srv.token + "'"));

      const noToken = await fetch(`http://127.0.0.1:${port}/api/sides`);
      ok('不带令牌的 /api 请求被拒（403）', noToken.status === 403);
      const noTokenJson = await noToken.json;
      ok('拒绝原因说得清', noTokenJson.code === 'bad_token', JSON.stringify(noTokenJson));

      const health = await api(srv, '/api/health');
      ok('/api/health 不需要令牌（启动器要用它探活）', health.status === 200 && health.json.ok === true);

      const css = await fetch(`http://127.0.0.1:${port}/style.css`);
      ok('静态资源能取到（正确的 content-type）', css.status === 200 && /text\/css/.test(css.headers.get('content-type') || ''));

      const badOrigin = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { origin: 'http://evil.example' } });
      ok('跨站 Origin 被拒', badOrigin.status === 403);
    }

    // ------------------------------------------------------------ 前端卫生
    section('前端卫生');
    {
      const appJs = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
      // 注释里会提到 innerHTML（说明为什么不用它），所以要先把注释剥掉再查
      const code = appJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      ok('app.js 代码里不用 innerHTML（不可信正文只走 textContent）', !/innerHTML/.test(code));
      ok('app.js 确实用 textContent 渲染正文', /\.textContent\s*=/.test(code));
      ok('app.js 带令牌头', appJs.includes("'x-dsh-pair'"));
      const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
      ok('index.html 里保留待注入的值占位符', html.includes('__PAIR_TOKEN_VALUE__'));
      ok('index.html 声明 UTF-8', /charset="utf-8"/.test(html));
      ok('app.js 会取身份牌 / 递牌 / 收起提示',
        appJs.includes("'/api/identity'") && appJs.includes("'/api/identity/give'") && appJs.includes("'/api/identity/ack'"));
      ok('app.js 会调新建会话接口', appJs.includes("'/api/sessions/new'"));
      ok('index.html 有身份牌条的挂载点', html.includes('id="identity-bar"'));
      ok('身份牌条有可收起的开关与卡片容器',
        html.includes('id="identity-toggle"') && html.includes('id="identity-cards"'));
      ok('收起状态记在 localStorage', appJs.includes('dsh-pair.identity.collapsed'));
      ok('有任务检测行（状态/步数/在干什么/多久）',
        appJs.includes('renderActivity') && appJs.includes('notifyFinished') && appJs.includes('runningSince'));
      // 身份牌条的样式只准用 dp- 前缀，且只引用 style.css 已有的变量（style.css 归Harness）
      const dpStyle = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
      ok('身份牌样式只用自己的 dp- 前缀', dpStyle.includes('.dp-card') && !/\.pane|\.stream|\.composer/.test(dpStyle));
    }

    // ------------------------------------------------------------ /api/sides
    section('/api/sides：两侧状态');
    {
      const r = await api(srv, '/api/sides');
      ok('退出 200 且 ok', r.status === 200 && r.json.ok === true, JSON.stringify(r.json).slice(0, 300));
      const desktop = r.json.sides.find((s) => s.id === 'desktop');
      const harness = r.json.sides.find((s) => s.id === 'harness');
      ok('desktop 在线', desktop && desktop.online === true);
      ok('desktop 带 identity（displayName/bridgeVersion）',
        !!(desktop && desktop.identity && desktop.identity.runtime === 'dsh' && desktop.identity.bridgeVersion));
      ok('desktop 显示 endpoint host:port', !!(desktop && desktop.endpoint && desktop.endpoint.ok && desktop.endpoint.port === mockA.state.port));
      ok('harness 离线（端口没人听）', harness && harness.online === false, JSON.stringify(harness && harness.error));
      ok('harness 离线原因里有 host:port', !!(harness && harness.error && harness.error.message.includes(`127.0.0.1:${deadPort}`)),
        harness && JSON.stringify(harness.error));
      ok('一侧离线不影响另一侧', desktop && desktop.online === true);
    }

    // ------------------------------------------------------------ /api/sessions
    section('/api/sessions');
    {
      const r = await api(srv, '/api/sessions?side=desktop');
      ok('拿到会话列表', r.status === 200 && r.json.sessions.length === 1);
      ok('live 标记透出来了', r.json.sessions[0].live === true);
      ok('标题正确', r.json.sessions[0].title === '桌面程序测试会话');
      const bad = await api(srv, '/api/sessions?side=nope');
      ok('未知 side → 400', bad.status === 400 && bad.json.code === 'unknown_side');
    }

    // ------------------------------------------------------------ 会话去垃圾过滤
    section('/api/sessions：去垃圾过滤（session.meta）');
    {
      const before = mockA.state.sessions.slice;
      const base = {
        cwd: '%WORKSPACE_B%',
        orderingTime: '2026-01-01T00:00:00Z',
        metadata: { live: true, persisted: true, readOnly: false }
      };
      mockA.state.sessions.push(
        Object.assign({}, base, { sessionId: 'sess_shell', externalSessionId: 'session-shell', title: '空壳' }),
        Object.assign({}, base, { sessionId: 'sess_old', externalSessionId: 'session-old', title: '旧的真会话' }),
        Object.assign({}, base, { sessionId: 'sess_new', externalSessionId: 'session-new', title: '新的真会话' }),
        Object.assign({}, base, { sessionId: 'sess_<id>', externalSessionId: 'session-unknown', title: '查不到体积的' })
      );
      const META = {
        sess_shell: { bytes: 900, lastWrite: '2026-01-02T09:00:00Z' },
        sess_old: { bytes: 200000, lastWrite: '2026-01-02T08:00:00Z' },
        sess_new: { bytes: 50000, lastWrite: '2026-01-02T12:00:00Z' }
        // sess_<id> 故意不给：查不到就该留着
      };
      mockA.state.metaOf = (id) => META[id] || null;

      const r = await api(srv, '/api/sessions?side=desktop');
      const titles = r.json.sessions.map((s) => s.title);
      ok('空壳会话被过滤掉', !titles.includes('空壳'), titles.join(' | '));
      ok('真会话按"最后写入"倒序', titles[0] === '新的真会话' && titles[1] === '旧的真会话', titles.join(' | '));
      ok('查不到体积的会话**保留**（不猜着丢）', titles.includes('查不到体积的'), titles.join(' | '));
      ok('统计说清了过滤掉什么',
        !!(r.json.sessionFilter && r.json.sessionFilter.emptyShell === 1 && r.json.sessionFilter.noMeta >= 1),
        JSON.stringify(r.json.sessionFilter));
      ok('标出 meta 是哪一侧给的', r.json.metaSource === 'desktop', String(r.json.metaSource));
      ok('带上了体积供界面显示',
        (r.json.sessions.find((s) => s.sessionId === 'sess_new') || {}).bytes === 50000);
      // 真机上 12 条会话 title 全是 null → 下拉里 12 个「(无标题)」等于没信息
      ok('无标题会话改用短 id，不再是一排「(无标题)」',
        r.json.sessions.every((s) => s.title && s.title !== '(无标题)'),
        r.json.sessions.map((s) => s.title).join(' | '));

      // 默认选中不能是空壳 —— "消息投错会话"的根因
      const tl = await api(srv, '/api/timeline?side=desktop&tail=5');
      ok('默认选中的不是空壳会话', tl.json.session.sessionId !== 'sess_shell', String(tl.json.session.sessionId));
      ok('时间线也把空壳从下拉里去掉', !(tl.json.sessions || []).some((s) => s.title === '空壳'));

      // ---- 「＋新建」报"找不到"的根因：新会话只有 ~16 KB，会被空壳规则误杀 ----
      const freshAt = Date.now;
      mockA.state.sessions.push(
        Object.assign({}, base, { sessionId: 'sess_fresh', externalSessionId: 'session-fresh', title: '刚新建的' }),
        Object.assign({}, base, { sessionId: 'sess_stale', externalSessionId: 'session-stale', title: '很老的小会话' })
      );
      mockA.state.metaOf = (id) =>
        ({
          sess_shell: { bytes: 900, lastWrite: '2026-01-02T09:00:00Z' },
          sess_old: { bytes: 200000, lastWrite: '2026-01-02T08:00:00Z' },
          sess_new: { bytes: 50000, lastWrite: '2026-01-02T12:00:00Z' },
          sess_fresh: { bytes: 16000, lastWrite: new Date(freshAt - 60 * 1000).toISOString },
          sess_stale: { bytes: 2000, lastWrite: '2026-01-01T00:00:00Z' }
        }[id] || null);

      const fresh = await api(srv, '/api/sessions?side=desktop');
      const freshTitles = fresh.json.sessions.map((s) => s.title);
      ok('**刚创建的会话必须出现在列表里**（点「＋新建」报"找不到"的根因）',
        freshTitles.includes('刚新建的'), freshTitles.join(' | '));
      ok('统计里单列了"刚动过"的数量',
        fresh.json.sessionFilter.justTouched >= 1, JSON.stringify(fresh.json.sessionFilter));
      ok('例外只给"刚动过"：很老的小会话仍然被过滤',
        freshTitles.includes('很老的小会话') === false, freshTitles.join(' | '));

      // 手动切到一个很老的小会话时，它也不能被藏掉
      const pinned = await api(srv, '/api/sessions?side=desktop&keep=session-stale');
      ok('显式 keep 的会话一定保留',
        pinned.json.sessions.some((s) => s.title === '很老的小会话'),
        pinned.json.sessions.map((s) => s.title).join(' | '));
      const pinnedBySession = await api(srv, '/api/timeline?side=desktop&session=session-stale&tail=5');
      ok('?session= 的那个也自动算 keep（界面每轮轮询都带它）',
        (pinnedBySession.json.sessions || []).some((s) => s.title === '很老的小会话'),
        (pinnedBySession.json.sessions || []).map((s) => s.title).join(' | '));

      mockA.state.sessions.length -= 2; // 摘掉刚加的两个
      mockA.state.metaOf = (id) => META[id] || null;

      // 对端不认识 session.meta 时 → **不过滤**，不能把功能弄成"看不到会话"
      // 注意：meta 有 3 秒缓存，id 集合没变的话会直接命中缓存，所以这里必须等过 TTL
      await sleep(3200);
      mockA.state.metaError = { code: -32601, message: 'method not found: session.meta' };
      mockA.state.metaOf = null;
      const raw = await api(srv, '/api/sessions?side=desktop');
      ok('拿不到 meta 时不过滤，会话全在', raw.json.sessions.some((s) => s.title === '空壳'),
        raw.json.sessions.map((s) => s.title).join(' | '));
      ok('但如实报告 meta 失败', !!(raw.json.metaError && raw.json.metaError.kind === 'protocol'),
        JSON.stringify(raw.json.metaError));
      delete mockA.state.metaError;

      // 还原
      mockA.state.sessions.length = 0;
      for (const s of before) mockA.state.sessions.push(s);
      mockA.state.metaOf = null;
    }

    // ------------------------------------------------------------ 任务检测（单元）
    section('③ 任务检测：工具提示（含隐私红线）');
    {
      const { projectItem } = require(path.join(APP_DIR, 'lib', 'project.js'));
      const edit = projectItem({
        orderSeq: 9,
        type: 'tool',
        role: 'assistant',
        content: { kind: 'tool_call', toolName: 'edit', input: { file_path: '%REPO%\\app\\server.js' } }
      });
      ok('工具条目能说出"在干什么"', edit.inputHint === '%REPO%\\app\\server.js', String(edit.inputHint));

      // 诱饵标记：故意放在命令正文里，证明它**不会**被投影出去。
      // （不用 sk- 开头是为了不让 scan-secrets.js 误报 —— 测试文件也不该留真 key 的模样）
      const DECOY = 'FAKE_SECRET_MARKER_12345';
      const cmd = projectItem({
        orderSeq: 10,
        type: 'tool',
        role: 'assistant',
        content: {
          kind: 'command',
          toolName: 'pwsh',
          input: { command: `curl -H "X-Api-Key: ${DECOY}" https://example.invalid` },
          output: 'X'
        }
      });
      ok('**命令正文绝不外泄**（界面可能被展示，命令行里可能有 key）', cmd.inputHint === null, String(cmd.inputHint));
      ok('整条工具记录里都搜不到命令正文', !JSON.stringify(cmd).includes(DECOY), JSON.stringify(cmd).slice(0, 200));
      ok('但工具摘要照常给', cmd.toolName === 'pwsh' && cmd.outputChars === 1);

      const long = projectItem({
        orderSeq: 11,
        type: 'tool',
        role: 'assistant',
        content: { kind: 'grep', toolName: 'grep', input: { pattern: 'x'.repeat(300) } }
      });
      ok('长提示被截断', typeof long.inputHint === 'string' && long.inputHint.length <= 56, `len=${long.inputHint && long.inputHint.length}`);
    }

    // ------------------------------------------------------------ /api/identity
    section('/api/identity：身份牌 + 递牌');
    {
      const all = await api(srv, '/api/identity');
      ok('退出 200 且 ok', all.status === 200 && all.json.ok === true, JSON.stringify(all.json).slice(0, 300));
      ok('两侧都在牌里', all.json.sides.length === 2);
      const d = all.json.sides.find((s) => s.id === 'desktop');
      const h = all.json.sides.find((s) => s.id === 'harness');
      ok('desktop 在线且给出 host:port', !!(d && d.online === true && d.endpointText === `127.0.0.1:${mockA.state.port}`), JSON.stringify(d && d.endpoint));
      ok('desktop 的"当前会话"就是那个 live 会话',
        !!(d && d.sessionId === SESSION.externalSessionId && d.sessionTitle === '桌面程序测试会话'), JSON.stringify(d && d.sessionId));
      ok('desktop 带工作区 / 分工 / DSH_HOME', !!(d && d.workspace === '%WORKSPACE_B%' && d.role && d.dshHome));
      // resolveSession 给回来的是原始 session 对象，live 在 metadata 里 —— 写成 session.live 会恒为 false
      ok('desktop 的会话带 live 标记', d.sessionLive === true, `sessionLive=${d && d.sessionLive}`);
      ok('harness 离线但仍在牌里（端点路径是常量，离线也要能回信）',
        !!(h && h.online === false && typeof h.endpointPath === 'string' && h.endpointPath.length > 0));
      ok('牌里没有 token（隐私红线）', !JSON.stringify(all.json).includes(mockA.state.token));

      const one = await api(srv, '/api/identity?side=desktop');
      ok('?side= 只返回一侧', one.status === 200 && one.json.sides.length === 1 && one.json.sides[0].id === 'desktop');
      const badSide = await api(srv, '/api/identity?side=nope');
      ok('未知 side → 400 unknown_side', badSide.status === 400 && badSide.json.code === 'unknown_side');

      // 端点必须**每次现读** endpoint.json（对方一重启 port/token 都变，缓存一定是错的）
      const epProbe = await freePort;
      fs.writeFileSync(epB, JSON.stringify({ version: 1, host: '127.0.0.1', port: epProbe, token: 'y', pid: 2 }), 'utf8');
      const reread = await api(srv, '/api/identity?side=harness');
      ok('端点每次现读，不缓存', reread.json.sides[0].endpointText === `127.0.0.1:${epProbe}`, String(reread.json.sides[0].endpointText));
      fs.writeFileSync(epB, JSON.stringify({ version: 1, host: '127.0.0.1', port: deadPort, token: 'x', pid: 1 }), 'utf8');

      // 新会话检测：模拟"新开一个会话"
      ok('第一次看到会话不算"开了新会话"', d.changed === false);
      const originalSessions = mockA.state.sessions.slice;
      mockA.state.sessions[0] = Object.assign({}, SESSION, {
        externalSessionId: 'session-apptest-0002',
        title: '新建的会话'
      });
      const afterNew = await api(srv, '/api/identity?side=desktop');
      const d2 = afterNew.json.sides[0];
      ok('会话 id 变了 → changed=true', d2.changed === true, JSON.stringify({ changed: d2.changed, sessionId: d2.sessionId }));
      ok('带上了上一个会话 id（界面要显示"从哪换到哪"）', d2.previousSessionId === SESSION.externalSessionId, String(d2.previousSessionId));

      const acked = await api(srv, '/api/identity/ack', { method: 'POST', body: { side: 'desktop' } });
      ok('ack 之后提示消失', acked.status === 200 && acked.json.changed === false);
      const afterAck = await api(srv, '/api/identity?side=desktop');
      ok('再查不会又冒出来', afterAck.json.sides[0].changed === false);
      const ackBad = await api(srv, '/api/identity/ack', { method: 'POST', body: { side: 'nope' } });
      ok('ack 未知 side → 400', ackBad.status === 400 && ackBad.json.code === 'unknown_side');

      // 递牌：把 harness 的牌塞进 desktop 的当前会话
      const receivedBefore = mockA.state.received.length;
      const give = await api(srv, '/api/identity/give', { method: 'POST', body: { from: 'harness', to: 'desktop' } });
      ok('递牌成功', give.status === 200 && give.json.ok === true, JSON.stringify(give.json).slice(0, 300));
      ok('牌写进了目标侧的当前会话', give.json.sessionId === mockA.state.sessions[0].sessionId, String(give.json.sessionId));
      const card = mockA.state.received[receivedBefore];
      ok('对端确实收到了牌', !!(card && typeof card.content === 'string' && card.content.startsWith('[身份牌]')), card && card.content);
      ok('牌里有发牌方的工作区与端点', !!(card && /%WORKSPACE_A%/.test(card.content) && /127\.0\.0\.1:\d+/.test(card.content)), card && card.content);
      ok('牌指向详细文档（正文不进上下文）', !!(card && /身份牌\.md/.test(card.content)), card && card.content);
      ok('牌里有回信署名模板', !!(card && /\[.*→.*\]\s*意图/.test(card.content)), card && card.content);
      ok('牌里没有 token', !!(card && !card.content.includes(mockA.state.token) && !card.content.includes('test-token')));
      ok(`牌足够短（≤ ${give.json.maxChars} 字，为节省 token）`, !!(card && card.content.length <= give.json.maxChars), card && `len=${card.content.length}`);
      const afterGive = await api(srv, '/api/identity?side=desktop');
      ok('递牌后该侧的"新会话"待办被清掉', afterGive.json.sides[0].changed === false);

      // 显式指定会话：真机上同侧有 3 个 live 会话，递错会话对方就永远看不到牌
      const sessionsBefore2 = mockA.state.sessions.slice;
      mockA.state.sessions.push(Object.assign({}, SESSION, {
        sessionId: 'sess_<id>',
        externalSessionId: 'session-apptest-other',
        title: '另一个更晚活跃的会话',
        orderingTime: 999
      }));
      const receivedBefore2 = mockA.state.received.length;
      const wanted = mockA.state.sessions[0]; // 注意：这条的 externalSessionId 已被上面的"新会话"用例改过
      const give2 = await api(srv, '/api/identity/give', {
        method: 'POST',
        body: { from: 'harness', to: 'desktop', session: wanted.externalSessionId }
      });
      ok('显式指定会话时，牌投给指定的那个（而不是"最近活跃的"）',
        give2.status === 200 && give2.json.sessionId === wanted.sessionId,
        `status=${give2.status} sessionId=${give2.json.sessionId} want=${wanted.sessionId}`);
      ok('牌确实落在那条会话上',
        mockA.state.received[receivedBefore2].sessionId === wanted.sessionId,
        String(mockA.state.received[receivedBefore2].sessionId));
      mockA.state.sessions.length = 0;
      for (const s of sessionsBefore2) mockA.state.sessions.push(s);

      const same = await api(srv, '/api/identity/give', { method: 'POST', body: { from: 'desktop', to: 'desktop' } });
      ok('from === to → 400 same_side', same.status === 400 && same.json.code === 'same_side');
      const noFrom = await api(srv, '/api/identity/give', { method: 'POST', body: { to: 'desktop' } });
      ok('缺 from → 400 bad_give', noFrom.status === 400 && noFrom.json.code === 'bad_give');
      const unknownTo = await api(srv, '/api/identity/give', { method: 'POST', body: { from: 'harness', to: 'nope' } });
      ok('未知 to → 400 unknown_side', unknownTo.status === 400 && unknownTo.json.code === 'unknown_side');

      // 还原会话表，并清掉收到的牌 —— 后面的 /api/send 断言的是 received[0]
      mockA.state.sessions.length = 0;
      for (const s of originalSessions) mockA.state.sessions.push(s);
      mockA.state.received.length = 0;
    }

    // ------------------------------------------------------------ /api/sessions/new
    section('/api/sessions/new：新建会话');
    {
      const sessionsBeforeNew = mockA.state.sessions.slice;

      const r = await api(srv, '/api/sessions/new', { method: 'POST', body: { side: 'desktop' } });
      ok('新建成功', r.status === 200 && r.json.ok === true, JSON.stringify(r.json).slice(0, 300));
      ok('返回了新的 externalSessionId', /^session-/.test(String(r.json.externalSessionId)), String(r.json.externalSessionId));
      const sent = mockA.state.received[0];
      ok('桥收到的是 session.createAndStart', !!(sent && sent.method === 'session.createAndStart'), String(sent && sent.method));
      ok('新建**不带** sessionId（还没有会话 id 可带）', sent.sessionId === null, String(sent.sessionId));
      ok('带了 cwd = 该侧工作区（否则新会话会被工作区过滤掉）', sent.cwd === '%WORKSPACE_B%', String(sent.cwd));
      ok('默认带了开场白（空壳会话会被对端列表过滤掉）',
        r.json.chars > 0 && typeof sent.content === 'string' && sent.content.length > 0, String(sent.content));
      ok('如实告诉界面"这一轮真的跑了"（要花 token）', r.json.startedTurn === true);
      ok('新会话进了会话表', mockA.state.created.length === 1 && mockA.state.sessions.length === sessionsBeforeNew.length + 1);

      const custom = await api(srv, '/api/sessions/new', {
        method: 'POST',
        body: { side: 'desktop', text: '你好新会话', cwd: '%WORKSPACE_B%mp' }
      });
      const sent2 = mockA.state.received[mockA.state.received.length - 1];
      ok('自定义首条消息透传', custom.status === 200 && sent2.content === '你好新会话', String(sent2.content));
      ok('自定义 cwd 透传', sent2.cwd === '%WORKSPACE_B%mp', String(sent2.cwd));

      const noSide = await api(srv, '/api/sessions/new', { method: 'POST', body: {} });
      ok('没给 side → 400 unknown_side', noSide.status === 400 && noSide.json.code === 'unknown_side');

      // 对端不支持时（**真机现在就是这种情况**）必须给清楚的错误，不能挂死
      mockA.state.createAndStartError = { code: -32001, message: '本插件暂不支持新建会话' };
      const t0 = Date.now;
      const rejected = await api(srv, '/api/sessions/new', { method: 'POST', body: { side: 'desktop' } });
      ok('桥不支持时 → 502 且 ok:false',
        rejected.status === 502 && rejected.json.ok === false,
        `status=${rejected.status} ${JSON.stringify(rejected.json).slice(0, 200)}`);
      ok('错误里说得清原因', /不支持|unsupported/i.test(rejected.json.message), rejected.json.message);
      ok('不支持时不挂死（<10s）', Date.now - t0 < 10000);
      // 关键回归：这是**业务错误**，不该把整条连接作废（否则后面全离线、界面闪"离线"）
      const stillOnline = await api(srv, '/api/sides');
      ok('新建被拒后该侧仍然在线（业务错误不该作废连接）',
        stillOnline.json.sides.find((s) => s.id === 'desktop').online === true,
        JSON.stringify(stillOnline.json.sides.find((s) => s.id === 'desktop').error));
      delete mockA.state.createAndStartError;

      // 桥"假成功"（accepted 不是 true）也要当失败处理
      mockA.state.createAndStartResult = { accepted: false, reason: 'nope' };
      const fake = await api(srv, '/api/sessions/new', { method: 'POST', body: { side: 'desktop' } });
      ok('accepted !== true → 502', fake.status === 502 && fake.json.code === 'new_session_rejected',
        `status=${fake.status} ${JSON.stringify(fake.json).slice(0, 200)}`);
      delete mockA.state.createAndStartResult;

      const offline = await api(srv, '/api/sessions/new', { method: 'POST', body: { side: 'harness' } });
      ok('离线侧新建 → 503', offline.status === 503 && offline.json.ok === false, `status=${offline.status}`);

      // 还原，别影响后面的用例（/api/send 断言的是 received[0]）
      mockA.state.sessions.length = 0;
      for (const s of sessionsBeforeNew) mockA.state.sessions.push(s);
      mockA.state.received.length = 0;
      mockA.state.created.length = 0;
    }

    // ------------------------------------------------------------ /api/timeline
    section('/api/timeline：正文与状态');
    let lastSeqBeforeSend = 0;
    {
      const r = await api(srv, '/api/timeline?side=desktop&tail=30');
      ok('退出 200', r.status === 200 && r.json.ok === true, JSON.stringify(r.json).slice(0, 300));
      const kinds = r.json.items.map((i) => `${i.type}/${i.role}/${i.kind}`);
      ok('助手正文在里面', r.json.items.some((i) => i.text === '第一条助手回复'));
      ok('用户消息也在（界面要显示自己的话）', r.json.items.some((i) => i.role === 'user' && i.text === '第一条测试消息'));
      ok('reasoning 被丢掉（不会显示思考过程）', !r.json.items.some((i) => i.kind === 'reasoning'), kinds.join(' | '));
      const tool = r.json.items.find((i) => i.type === 'tool');
      ok('工具条目只给摘要不给 output', !!(tool && tool.outputChars === 1234 && tool.output === undefined));
      ok('带上了时间戳供界面显示', r.json.items.some((i) => i.time !== undefined));
      ok('会话信息齐（title/externalSessionId）', !!(r.json.session && r.json.session.title === '桌面程序测试会话' && r.json.session.externalSessionId));
      ok('status 是 idle', r.json.status === 'idle');
      lastSeqBeforeSend = r.json.lastSeq;
      ok('lastSeq 是最大 orderSeq', lastSeqBeforeSend === 4, String(lastSeqBeforeSend));

      const after = await api(srv, `/api/timeline?side=desktop&after=${lastSeqBeforeSend}&tail=30`);
      ok('after 过滤生效（没有新东西就返回空）', after.json.items.length === 0);
    }

    // ------------------------------------------------------------ /api/send
    section('/api/send：投递 + 增量拿到回复');
    {
      const tricky = '中文测试 🐍 “引号” \'单引号\' \n第二行\ttab emoji ✅\n';
      mockA.state.onStartTurn = (params, api2) => {
        api2.state.status = 'running';
        api2.appendItem(item({ type: 'message', role: 'user', content: { kind: 'markdown', text: params.content } }));
        setTimeout( => {
          api2.appendItem(
            item({ type: 'message', role: 'assistant', content: { kind: 'markdown', text: '收到，这是桌面程序里的回复 ✅' } })
          );
          api2.state.status = 'idle';
        }, 200);
      };

      const sent = await api(srv, '/api/send', {
        method: 'POST',
        body: { side: 'desktop', text: tricky }
      });
      ok('投递成功', sent.status === 200 && sent.json.accepted === true, JSON.stringify(sent.json));
      ok('对端收到的正文逐字符一致', mockA.state.received[0].content === tricky, JSON.stringify(mockA.state.received[0].content));
      ok('带了 clientMessageId', !!sent.json.clientMessageId);

      // 模拟界面轮询：running 状态要能看到
      let sawRunning = false;
      let reply = null;
      const deadline = Date.now + 8000;
      while (Date.now < deadline && !reply) {
        const r = await api(srv, `/api/timeline?side=desktop&after=${lastSeqBeforeSend}&tail=30`);
        if (r.json.status === 'running') sawRunning = true;
        const hit = r.json.items.find((i) => i.role === 'assistant' && i.text);
        if (hit) reply = hit.text;
        if (!reply) await sleep(200);
      }
      ok('轮询期间能看到 running（"谁在干活"的依据）', sawRunning);
      ok('增量轮询拿到了回复正文', reply === '收到，这是桌面程序里的回复 ✅', JSON.stringify(reply));
    }

    // ------------------------------------------------------------ 两边都发
    section('两边都发');
    {
      const r1 = await api(srv, '/api/send', { method: 'POST', body: { side: 'desktop', text: '给 Desktop 的一句' } });
      ok('desktop 发送成功', r1.status === 200 && r1.json.accepted === true, JSON.stringify(r1.json).slice(0, 200));
      ok('desktop 收到了', mockA.state.received.some((r) => r.content === '给 Desktop 的一句'));

      // B 现在还是离线，必须给出明确错误而不是挂死
      const t0 = Date.now;
      const r2 = await api(srv, '/api/send', { method: 'POST', body: { side: 'harness', text: '给 Harness 的一句' } });
      const ms = Date.now - t0;
      ok('离线侧发送 → 503 且 ok:false', r2.status === 503 && r2.json.ok === false, `status=${r2.status} ${JSON.stringify(r2.json).slice(0, 200)}`);
      ok('离线侧错误里有原因（含端口）', /127\.0\.0\.1:\d+|endpoint\.json/.test(r2.json.message), r2.json.message);
      ok('离线侧没有挂死（<10s）', ms < 10000, `ms=${ms}`);
    }

    // ------------------------------------------------------------ 参数校验
    section('参数校验');
    {
      const empty = await api(srv, '/api/send', { method: 'POST', body: { side: 'desktop', text: '   ' } });
      ok('空正文 → 400', empty.status === 400 && empty.json.code === 'empty_text');
      const noSide = await api(srv, '/api/send', { method: 'POST', body: { text: 'x' } });
      ok('没给 side → 400', noSide.status === 400 && noSide.json.code === 'unknown_side');
      const badJson = await fetch(`http://127.0.0.1:${port}/api/send`, {
        method: 'POST',
        headers: { 'x-dsh-pair': srv.token, 'content-type': 'application/json' },
        body: '{ not json'
      });
      ok('坏 JSON → 400', badJson.status === 400);
    }

    // ------------------------------------------------------------ 目录穿越
    section('静态服务安全');
    {
      for (const p of ['/../peer/peer.js', '/%2e%2e/peer/peer.js', '/..%2fpeer%2fpeer.js']) {
        const res = await fetch(`http://127.0.0.1:${port}${p}`);
        let body = '';
        try {
          body = await res.text;
        } catch (err) {
          /* 忽略 */
        }
        ok(`穿越尝试被挡住：${p}`, res.status !== 200 && !body.includes('dsh-peer'), `status=${res.status}`);
      }
    }

    // ------------------------------------------------------------ 恢复
    section('对方重启后能自动恢复（endpoint.json 变了就立刻重连）');
    {
      writeEndpoint(epB, mockB); // 模拟搭档的桥生效了：同一个路径，新的 port/token
      let online = false;
      const deadline = Date.now + 12000;
      while (Date.now < deadline && !online) {
        const r = await api(srv, '/api/sides');
        const harness = r.json.sides.find((s) => s.id === 'harness');
        online = !!(harness && harness.online);
        if (!online) await sleep(400);
      }
      ok('harness 重新上线', online);
      const t = await api(srv, '/api/timeline?side=harness&tail=30');
      ok('恢复后立刻能读它的时间线', t.status === 200 && t.json.ok === true, JSON.stringify(t.json).slice(0, 200));
      const s = await api(srv, '/api/send', { method: 'POST', body: { side: 'harness', text: '恢复后发给 Harness' } });
      ok('恢复后能发给它', s.status === 200 && s.json.accepted === true, JSON.stringify(s.json).slice(0, 200));
      ok('它确实收到了', mockB.state.received.some((r) => r.content === '恢复后发给 Harness'));
    }

    // ------------------------------------------------------------ 前端真跑一遍
    section('前端真的能跑起来（真浏览器 + 假 bridge）');
    {
      // 这一项是补课：上面全是 HTTP 层测试，前端 JS 一次都没执行过，
      // 结果 "pane 对象少一个字段 → 右边那栏整个没建出来" 这种错只能靠截图发现。
      const dom = await browserDom(`http://127.0.0.1:${port}/`, 6000);
      if (!dom) {
        console.log('  SKIP  本机没找到 Edge/Chrome，跳过浏览器检查');
      } else {
        ok('两栏都建出来了', (dom.match(/class="pane"/g) || []).length === 2, `panes=${(dom.match(/class="pane"/g) || []).length}`);
        ok('data-side 是 desktop 和 harness', /data-side="desktop"/.test(dom) && /data-side="harness"/.test(dom));
        ok('顶栏没有"后端连接失败"横幅', !/后端连接失败/.test(dom));
        ok('渲染出了助手正文', dom.includes('第一条助手回复'));
        ok('渲染出了用户自己的话', dom.includes('第一条测试消息'));
        ok('状态胶囊显示出来了', /空闲|正在跑/.test(dom));
        ok('reasoning 没被显示到页面上', !dom.includes('不该出现在界面上'));
        ok('工具调用折成了一行摘要', /pwsh/.test(dom));
        ok('会话下拉选到了 live 会话', /桌面程序测试会话/.test(dom));
        ok('手机端(v2)会话在界面上有标记', /📱/.test(dom), '没看到 📱 标记');
        ok('主题按钮渲染出来了', /id="theme-btn"/.test(dom));
        ok('身份牌条渲染出了两侧的牌', (dom.match(/class="dp-card"/g) || []).length === 2,
          `cards=${(dom.match(/class="dp-card"/g) || []).length}`);
        ok('牌上有"递牌"按钮', /dp-give/.test(dom));
        ok('牌上显示了端点 host:port', new RegExp(`127\\.0\\.0\\.1:${mockA.state.port}`).test(dom));
        ok('每栏都有「＋新建」按钮', (dom.match(/＋新建/g) || []).length === 2,
          `n=${(dom.match(/＋新建/g) || []).length}`);
        ok('身份牌条有收起开关', /id="identity-toggle"/.test(dom) && /身份牌/.test(dom));
        ok('身份牌条默认收起（默认收起更省空间）', /id="identity-bar"[^>]*data-collapsed="true"/.test(dom),
          (dom.match(/<section[^>]*id="identity-bar"[^>]*>/) || [''])[0]);
        ok('每栏都有任务检测行', (dom.match(/class="act-line"/g) || []).length === 2,
          `n=${(dom.match(/class="act-line"/g) || []).length}`);
        ok('任务检测行现在显示"空闲"', /空闲/.test(dom));
        ok('浏览器里 <html> 被写上了 data-theme', /<html[^>]*data-theme=/.test(dom), (dom.match(/<html[^>]*>/) || [''])[0]);
      }
    }

    // ------------------------------------------------------------ 工作区过滤
    section('按工作区过滤会话（Harness报的"harness 侧列了 110 条"问题）');
    {
      let mockMulti2 = null;
      const multi = createMockBridge({
        sessions: [
          { sessionId: 'sess_t1', externalSessionId: 'ext-t1', title: 'Desktop的会话1', cwd: '%WORKSPACE_B%', metadata: { live: false } },
          { sessionId: 'sess_t2', externalSessionId: 'ext-t2', title: 'Desktop的会话2', cwd: '%WORKSPACE_B%', metadata: { live: false } },
          { sessionId: 'sess_h1', externalSessionId: 'ext-h1', title: 'Harness的会话', cwd: '%WORKSPACE_A%', metadata: { live: true } }
        ],
        items: [
          item({ orderSeq: 1, type: 'message', role: 'assistant', content: { kind: 'markdown', text: 'Harness这边的正文' } })
        ]
      });
      await multi.listen;
      const epM = path.join(TMP, 'endpoint-multi.json');
      writeEndpoint(epM, multi);
      const sidesM = path.join(TMP, 'sides-multi.json');
      fs.writeFileSync(
        sidesM,
        JSON.stringify({
          sides: [
            { id: 'harness', short: 'Harness', label: 'H', workspace: '%WORKSPACE_A%', endpointPath: epM },
            { id: 'nowhere', short: 'Nowhere', label: 'N', workspace: 'E:\\nowhere', endpointPath: epM }
          ]
        }),
        'utf8'
      );
      const portM = await freePort;
      const srvM = await startServer(sidesM, portM);
      try {
        const t = await api(srvM, '/api/timeline?side=harness&tail=10');
        ok(
          '只列出本工作区的会话',
          t.json.sessions.length === 1 && t.json.sessions[0].externalSessionId === 'ext-h1',
          JSON.stringify(t.json.sessions.map((s) => s.externalSessionId))
        );
        ok('默认选中的就是本工作区的那个', t.json.session.externalSessionId === 'ext-h1');
        ok('标了 workspaceFiltered / totalSessions', t.json.workspaceFiltered === true && t.json.totalSessions === 3 && t.json.workspace === '%WORKSPACE_A%');
        ok('正文照常读到', t.json.items.some((i) => i.text === 'Harness这边的正文'));

        const all = await api(srvM, '/api/timeline?side=harness&all=1&tail=10');
        ok('all=1 时给全部 3 条', all.json.sessions.length === 3 && all.json.workspaceFiltered === false);

        const s1 = await api(srvM, '/api/sessions?side=harness');
        ok('/api/sessions 也过滤', s1.json.sessions.length === 1);
        const s2 = await api(srvM, '/api/sessions?side=harness&all=1');
        ok('/api/sessions&all=1 给全部', s2.json.sessions.length === 3);

        const nm = await api(srvM, '/api/timeline?side=nowhere&tail=10');
        ok(
          '工作区对不上时退回全部（不把功能弄死）',
          nm.json.sessions.length === 3 && nm.json.noWorkspaceMatch === true,
          JSON.stringify({ n: nm.json.sessions.length, noMatch: nm.json.noWorkspaceMatch })
        );

        const off = await api(srvM, '/api/timeline?side=harness&session=ext-t1&tail=10');
        ok(
          '显式指定别的工作区的会话仍然能读，并标注 offWorkspace',
          off.json.session.externalSessionId === 'ext-t1' && off.json.session.offWorkspace === true,
          JSON.stringify(off.json.session)
        );

        // 同一工作区有多个 live 会话时，默认选**最近活跃**的那个（用 orderingTime）
        mockMulti2 = createMockBridge({
          sessions: [
            { sessionId: 's_old', externalSessionId: 'ext-old', title: '较早', cwd: '%WORKSPACE_A%', orderingTime: '2026-01-03T10:00:00Z', metadata: { live: true } },
            { sessionId: 's_new', externalSessionId: 'ext-new', title: '最近', cwd: '%WORKSPACE_A%', orderingTime: '2026-01-03T20:00:00Z', metadata: { live: true } },
            { sessionId: 's_mid', externalSessionId: 'ext-mid', title: '中间', cwd: '%WORKSPACE_A%', orderingTime: '2026-01-03T15:00:00Z', metadata: { live: true } },
            // 手机端(v2)产生的会话：Harness的决定是"不隐藏、只标记"，kind 要原样透出来
            {
              sessionId: 's_phone',
              externalSessionId: 'aa_<id>',
              title: '手机端聊过的历史',
              cwd: '%WORKSPACE_A%',
              orderingTime: '2026-09-29T09:00:00Z',
              kind: 'agents-anywhere',
              metadata: { live: false }
            }
          ]
        });
        await mockMulti2.listen;
        const epM2 = path.join(TMP, 'endpoint-multi2.json');
        writeEndpoint(epM2, mockMulti2);
        const sidesM2 = path.join(TMP, 'sides-multi2.json');
        fs.writeFileSync(
          sidesM2,
          JSON.stringify({ sides: [{ id: 'harness', short: 'H', label: 'H', workspace: '%WORKSPACE_A%', endpointPath: epM2 }] }),
          'utf8'
        );
        const portM2 = await freePort;
        const srvM2 = await startServer(sidesM2, portM2);
        try {
          const t2 = await api(srvM2, '/api/timeline?side=harness&tail=5');
          ok('多个 live 时默认选最近活跃的那个', t2.json.session.externalSessionId === 'ext-new', JSON.stringify(t2.json.session));
          ok(
            '会话列表按最近活跃排序（手机端那条按时间排在最后）',
            t2.json.sessions.map((s) => s.externalSessionId).join(',') === 'ext-new,ext-mid,ext-old,aa_<id>',
            JSON.stringify(t2.json.sessions.map((s) => s.externalSessionId))
          );
          const phone = t2.json.sessions.find((s) => s.externalSessionId.startsWith('aa_'));
          ok('手机端会话不被隐藏，且带 kind 标记', !!(phone && phone.kind === 'agents-anywhere'), JSON.stringify(phone));
          ok(
            '本实例会话的 kind 是原生/native',
            t2.json.sessions.filter((s) => !s.externalSessionId.startsWith('aa_')).every((s) => !s.kind || s.kind === 'native'),
            JSON.stringify(t2.json.sessions.map((s) => s.kind))
          );
        } finally {
          await srvM2.stop;
          await mockMulti2.close;
        }
      } finally {
        await srvM.stop;
        await multi.close;
      }
    }

    // ------------------------------------------------------------ 注入消息与异常回合
    section('时间线过滤：假 user 消息要藏起来，被挡下的回合要看得见');
    {
      const mock = createMockBridge(
        mockOptions({
          sessions: [SESSION],
          items: [
            item({
              orderSeq: 1,
              type: 'message',
              role: 'user',
              content: { kind: 'markdown', text: '这是 DSH 注入的运行时上下文，不是人说的话' },
              source: { kind: 'runtime-context' }
            }),
            item({
              orderSeq: 2,
              type: 'message',
              role: 'user',
              content: { kind: 'markdown', text: '这是注入的技能目录，也不该显示' },
              source: { kind: 'skill-catalog' }
            }),
            item({ orderSeq: 3, type: 'message', role: 'user', content: { kind: 'markdown', text: '这是一条测试消息' } }),
            item({ orderSeq: 4, type: 'turn.end', role: 'system', content: { kind: 'turn_end', reason: { kind: 'completed' } } }),
            item({ orderSeq: 5, type: 'turn.end', role: 'system', content: { kind: 'turn_end', reason: { kind: 'blocked' } } })
          ]
        })
      );
      await mock.listen;
      const ep = path.join(TMP, 'endpoint-filter.json');
      writeEndpoint(ep, mock);
      const sidesP = path.join(TMP, 'sides-filter.json');
      fs.writeFileSync(
        sidesP,
        JSON.stringify({ sides: [{ id: 'desktop', short: 'D', label: 'D', workspace: '%WORKSPACE_B%', endpointPath: ep }] }),
        'utf8'
      );
      const portF = await freePort;
      const srvF = await startServer(sidesP, portF);
      try {
        const r = await api(srvF, '/api/timeline?side=desktop&tail=20');
        const texts = r.json.items.map((i) => i.text || `(${i.type}:${i.reasonKind})`);
        ok('注入的 runtime-context 被藏起来', !r.json.items.some((i) => i.text && i.text.includes('运行时上下文')), JSON.stringify(texts));
        ok('注入的 skill-catalog 被藏起来', !r.json.items.some((i) => i.text && i.text.includes('技能目录')), JSON.stringify(texts));
        ok('用户真正说的话还在', r.json.items.some((i) => i.text === '这是一条测试消息'));
        ok('正常结束的回合不打扰用户', !r.json.items.some((i) => i.type === 'turn.end' && i.reasonKind === 'completed'), JSON.stringify(texts));
        ok(
          '被 blocked 的回合要显示出来并带原因',
          r.json.items.some((i) => i.type === 'turn.end' && i.reasonKind === 'blocked' && i.abnormal === true),
          JSON.stringify(texts)
        );
      } finally {
        await srvF.stop;
        await mock.close;
      }
    }

    // ------------------------------------------------------------ 样式契约
    section('样式契约（样式契约：核对另一模块是否覆盖本模块发出的类名）');
    {
      const cssPath = path.join(PUBLIC_DIR, 'style.css');
      const css = fs.readFileSync(cssPath, 'utf8');
      const appJs = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
      const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');

      // 我在 DOM 里实际会用的类名（我这边是契约方；加新类时必须同步这份清单）
      const REQUIRED_CLASSES = [
        'panes', 'pane', 'pane-head', 'pane-sub', 'stream',
        'composer', 'composer-row', 'composer-hint', 'targets', 'target',
        'topbar', 'brand', 'brand-text', 'top-status', 'top-actions', 'chip', 'logo',
        'dot', 'name', 'ws', 'spacer', 'pill', 'session-select', 'ghost', 'primary',
        'msg', 'user', 'assistant', 'pending', 'meta', 'act', 'notice', 'thinking', 'empty', 'err'
      ];

      const missing = REQUIRED_CLASSES.filter((c) => !new RegExp('\\.' + c + '(?![\\w-])').test(css));
      ok(
        `style.css 覆盖了我发出的全部 ${REQUIRED_CLASSES.length} 个类名`,
        missing.length === 0,
        missing.length ? `缺: ${missing.join(', ')}` : ''
      );

      // 我靠这些属性选择器上样式（值由 app.js 设置，类名之外的第二层契约）
      const attrNeeds = ['[data-state', '[data-error', '[data-active', '[data-side'];
      const attrMissing = attrNeeds.filter((a) => !css.includes(a));
      ok('data-* 属性选择器都在', attrMissing.length === 0, attrMissing.join(', '));

      // hidden 属性陷阱：.thinking 是用 .hidden = true 切的。
      // 只要 CSS 给 .thinking 设了 display，UA 的 [hidden]{display:none} 就会被盖掉 →
      // "正在思考…"永远挂着。所以设了 display 就必须有 [hidden] 兜底。
      const thinkingSetsDisplay = /\.thinking\s*\{[^}]*display\s*:/.test(css);
      const hasHiddenRule = /\[hidden\]/.test(css);
      ok(
        '.thinking 用 hidden 切换：设了 display 就必须有 [hidden] 规则',
        !thinkingSetsDisplay || hasHiddenRule,
        thinkingSetsDisplay && !hasHiddenRule ? '.thinking 设了 display 但没有 [hidden]{display:none}' : ''
      );

      // 身份牌条 + 任务检测行是我自己的样式块（index.html 里的 <style>），
      // 为避免改动另一模块的 style.css。但不能因此变成"没有样式"或"偷偷覆盖别的类名"——所以单独立一份契约。
      const ownStyle = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
      const OWN_CLASSES = [
        'dp-identity', 'dp-cards', 'dp-toggle', 'dp-card', 'dp-name', 'dp-bits', 'dp-warn', 'dp-give',
        'act-line', 'act-step', 'act-what'
      ];
      const ownMissing = OWN_CLASSES.filter((c) => !new RegExp('\\.' + c + '(?![\\w-])').test(ownStyle));
      ok(
        `我自己发的 ${OWN_CLASSES.length} 个类都由本模块的样式块覆盖`,
        ownMissing.length === 0,
        ownMissing.length ? `缺: ${ownMissing.join(', ')}` : ''
      );
      const ownAttrNeeds = ['[data-online', '[data-changed', '[data-collapsed', '[data-state'];
      const ownAttrMissing = ownAttrNeeds.filter((a) => !ownStyle.includes(a));
      ok('我自己那些 data-* 属性选择器都在', ownAttrMissing.length === 0, ownAttrMissing.join(', '));
      // 末尾的 (?![\w-]) 很关键：否则 .act-line 会被当成"用了Harness的 .act"
      ok('本模块的样式块不碰另一模块的类名',
        !/\.(pane|stream|composer|topbar|chip|msg|act|notice|dot|pill|ghost)(?![\w-])/.test(ownStyle),
        (ownStyle.match(/\.(pane|stream|composer|topbar|chip|msg|act|notice|dot|pill|ghost)(?![\w-])/g) || []).join(', '));

      // 反向漂移：app.js 里 className = '…' 的字面量必须都在清单里（防止我偷偷加类）
      const emitted = new Set;
      for (const m of appJs.matchAll(/className\s*=\s*'([^']+)'/g)) {
        for (const c of m[1].split(/\s+/)) if (c) emitted.add(c);
      }
      for (const m of html.matchAll(/class="([^"]+)"/g)) {
        for (const c of m[1].split(/\s+/)) if (c) emitted.add(c);
      }
      const drift = [...emitted].filter((c) => !REQUIRED_CLASSES.includes(c) && !OWN_CLASSES.includes(c));
      ok('本模块发出的类名没有超出这份契约（超出就该同步给Harness）', drift.length === 0, drift.join(', '));

      // 浅色主题：Harness加了 prefers-color-scheme，确认不是只写了 media 却没写规则
      const lightBlocks = (css.match(/@media\s*\(prefers-color-scheme:\s*light\)/g) || []).length;
      ok('浅色主题有实际规则（不是空 @media）', lightBlocks === 0 || /@media\s*\(prefers-color-scheme:\s*light\)\s*\{[\s\S]{40,}/.test(css), `blocks=${lightBlocks}`);
    }

    // ------------------------------------------------------------ 主题三态
    section('主题三态（按Harness定的 data-theme 协议）');
    {
      const themeSrc = fs.readFileSync(path.join(PUBLIC_DIR, 'theme.js'), 'utf8');
      const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');

      // 协议的三条硬约束，静态先查
      ok('index.html 在样式表之前加载 theme.js（防主题闪烁）', /<script src="\/theme\.js"><\/script>\s*<link rel="stylesheet"/.test(html));
      ok('存在 #theme-btn 且用的是已有类名 ghost（不新增类）', /class="ghost" id="theme-btn"/.test(html));
      ok('主题只写 data-theme，不碰 class/DOM 结构', /dataset\.theme\s*=/.test(themeSrc) && !/classList\.(add|remove)/.test(themeSrc));

      // 用 vm 把 theme.js 跑在假 DOM 里，验证循环顺序 + 持久化
      function bootTheme(storageSeed) {
        const store = new Map(Object.entries(storageSeed || {}));
        // 注意：wire 期待的是 Storage 接口（getItem/setItem）。
        // 直接把 Map 传进去会因为 Map 没有 setItem 而被 writeStored 的 try/catch 静默吞掉
        // ——这个夹具 bug 就是被"断言真的写进去了"抓出来的。
        const storage = {
          getItem: (k) => (store.has(k) ? store.get(k) : null),
          setItem: (k, v) => store.set(k, String(v))
        };
        const btn = {
          textContent: '',
          title: '',
          dataset: {},
          handlers: {},
          addEventListener(type, fn) {
            (this.handlers[type] = this.handlers[type] || []).push(fn);
          },
          click {
            (this.handlers.click || []).forEach((fn) => fn);
          }
        };
        const doc = {
          documentElement: { dataset: {} },
          getElementById: (id) => (id === 'theme-btn' ? btn : null)
        };
        const sandbox = { console, document: doc, localStorage: storage };
        sandbox.window = sandbox;
        vm.createContext(sandbox);
        vm.runInContext(themeSrc, sandbox, { filename: 'public/theme.js' });
        return { api: sandbox.DshPairTheme, doc, btn, store, storage };
      }

      const t1 = bootTheme;
      ok('载入即写 data-theme=auto（跟随系统）', t1.doc.documentElement.dataset.theme === 'auto', String(t1.doc.documentElement.dataset.theme));
      t1.api.wire(t1.doc, t1.storage);
      ok('按钮初始文案是"跟随系统"', /跟随系统/.test(t1.btn.textContent), t1.btn.textContent);

      t1.btn.click;
      ok('第一次点击 → light', t1.doc.documentElement.dataset.theme === 'light', String(t1.doc.documentElement.dataset.theme));
      ok('按钮文案跟着变', /浅色/.test(t1.btn.textContent), t1.btn.textContent);
      t1.btn.click;
      ok('第二次点击 → dark', t1.doc.documentElement.dataset.theme === 'dark', String(t1.doc.documentElement.dataset.theme));
      t1.btn.click;
      ok('第三次点击回到 auto（三态循环）', t1.doc.documentElement.dataset.theme === 'auto', String(t1.doc.documentElement.dataset.theme));

      // 持久化：点两下（dark）→ 重新载入 → 应该还是 dark
      const t2 = bootTheme;
      t2.api.wire(t2.doc, t2.storage);
      t2.btn.click;
      t2.btn.click;
      ok('切换会写进 localStorage', t2.store.get('dsh-pair.theme') === 'dark', String(t2.store.get('dsh-pair.theme')));
      const t3 = bootTheme({ 'dsh-pair.theme': 'dark' });
      ok('刷新后保持上次选择', t3.doc.documentElement.dataset.theme === 'dark', String(t3.doc.documentElement.dataset.theme));

      const t4 = bootTheme({ 'dsh-pair.theme': '不是合法值' });
      ok('存了脏值就当跟随系统（不炸）', t4.doc.documentElement.dataset.theme === 'auto', String(t4.doc.documentElement.dataset.theme));

      const t5 = bootTheme({ 'dsh-pair.theme': 'light' });
      ok('显式 light 会立刻应用（覆盖系统偏好）', t5.doc.documentElement.dataset.theme === 'light');
    }

    // ------------------------------------------------------------ 运行日志
    section('运行日志（后端"干净地消失"过一次，必须留痕）');
    {
      const logPath = path.join(APP_DIR, 'logs', `server-${port}.log`);
      fs.rmSync(logPath, { force: true });

      // 重新起一个实例，专门看它有没有写日志
      const p2 = await freePort;
      const logPath2 = path.join(APP_DIR, 'logs', `server-${p2}.log`);
      fs.rmSync(logPath2, { force: true });
      const srv2 = await startServer(sidesPath, p2);
      try {
        const healthRes = await api(srv2, '/api/health');
        ok('/api/health 里带 logPath（界面据此告诉用户去哪儿看）', typeof healthRes.json.logPath === 'string' && healthRes.json.logPath.endsWith(`server-${p2}.log`), JSON.stringify(healthRes.json).slice(0, 200));
        ok('/api/health 里带 startedAt/uptimeMs', !!healthRes.json.startedAt && typeof healthRes.json.uptimeMs === 'number');

        const log = fs.readFileSync(logPath2, 'utf8');
        ok('日志文件真的写出来了', log.length > 0, logPath2);
        ok('记了启动信息（pid/port/appDir）', /started pid=\d+ port=\d+/.test(log) && log.includes('appDir='), log.slice(0, 300));
        ok('记了监听地址', new RegExp(`listening on http://127\\.0\\.0\\.1:${p2}/`).test(log), log.slice(0, 400));
        ok('记了两侧端点（只有 host:port，没有 token）', /side desktop ->/.test(log) && /side harness ->/.test(log));

        // 隐私：日志里绝不能出现桥的 token
        const tokenOfMock = mockA.state.token;
        ok('日志里没有桥 token（RULES 第 4 条）', !log.includes(tokenOfMock), '日志里出现了 token！');

        // 错误也要落日志（4xx/5xx）
        await api(srv2, '/api/sessions?side=nope');
        await sleep(150);
        const log2 = fs.readFileSync(logPath2, 'utf8');
        ok('接口报错会写进日志', /WARN|ERROR/.test(log2) && /unknown_side|未知的 side/.test(log2), log2.slice(-300));
      } finally {
        await srv2.stop;
      }
      fs.rmSync(logPath, { force: true });
      fs.rmSync(logPath2, { force: true });
    }

    // ------------------------------------------------------------ 看门狗提示
    section('后端挂掉时的可见提示（前端）');
    {
      const appJs = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
      ok('app.js 会区分"后端没了"和"某一侧离线"', /markBackendDown/.test(appJs) && /markBackendUp/.test(appJs));
      ok('后端挂了会给出重启指引', /后端已停止/.test(appJs) && /start-app\.cmd/.test(appJs));
      ok('提示里带上日志路径（来自 /api/health）', /logPath/.test(appJs) && /loadBackendInfo/.test(appJs));
      const cssContract = fs.readFileSync(path.join(PUBLIC_DIR, 'style.css'), 'utf8');
      ok('横幅只用已有类名 .chip（不新增类，样式归Harness）', /className = 'chip'/.test(appJs) && /\.chip/.test(cssContract));
    }

    // ------------------------------------------------------------ 用户文档
    section('面向用户的交付文档（B2）');
    {
      const guidePath = path.join(APP_DIR, 'USAGE.md');
      ok('USAGE.md 存在', fs.existsSync(guidePath), guidePath);
      const guide = fs.readFileSync(guidePath, 'utf8');

      const mustHave = [
        ['这是什么', '这是什么'],
        ['怎么开始', '怎么开始'],
        ['出问题怎么办', '出问题怎么办'],
        ['怎么停止', '怎么停止'],
        ['隐私说明', '隐私和安全'],
        ['停止方式提到 stop.cmd', 'stop.cmd'],
        ['明确警告不要 taskkill /IM node.exe', 'taskkill /IM node.exe'],
        ['告诉用户日志在哪', 'logs\\server-'],
        ['提到看门狗会自动重启', '看门狗'],
        ['提到端口占用这一常见故障', '端口被占用'],
        ['提到权限预设导致的 blocked', 'danger-full-access'],
        ['提到 exe 正在做（B1）', 'B1']
      ];
      for (const [label, needle] of mustHave) {
        ok(`文档包含：${label}`, guide.includes(needle), `没找到 ${JSON.stringify(needle)}`);
      }

      // 文档里引用的截图必须真的存在（避免交付文档指向不存在的图）
      const shots = [...guide.matchAll(/docs\\?\/?([\w.-]+\.png)/g)].map((m) => m[1]);
      const missingShots = shots.filter((s) => !fs.existsSync(path.join(APP_DIR, 'docs', s)));
      ok(`引用的截图都存在（${shots.length} 张）`, missingShots.length === 0, missingShots.join(', '));

      // 面向用户的文档不该出现凭据样式的字符串
      ok('文档里没有疑似凭据', !/sk-[A-Za-z0-9_-]{16,}/.test(guide) && !/"(?:token|authToken)":\s*"[^"]{8,}"/.test(guide));

      // 文档里给用户的命令/路径应当真实存在
      ok('文档提到的 start-app.cmd 存在', fs.existsSync(path.join(APP_DIR, 'start-app.cmd')));
      ok('文档提到的 make-desktop-shortcut.cmd 存在', fs.existsSync(path.join(APP_DIR, 'make-desktop-shortcut.cmd')));
    }

    // ------------------------------------------------------------ 打包契约
    section('打包契约（app/ 与 peer/ 必须平级 —— Harness踩过的坑）');
    {
      const walkAll = (dir) =>
        fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
          const p = path.join(dir, e.name);
          return e.isDirectory ? walkAll(p) : [p];
        });
      const appJsFiles = walkAll(APP_DIR).filter((f) => f.endsWith('.js'));

      // app/ 里跳出 app/ 的依赖。基线可能是 __dirname，也可能是文件里定义的常量（如 APP_DIR）。
      // 只认这两种已知基线；别的（例如临时目录变量）跳过并记 NOTE，避免用猜的。
      const KNOWN_BASES = {
        __dirname: (file) => path.dirname(file),
        APP_DIR:  => APP_DIR
      };
      const allRequires = [];
      const skippedBases = [];
      for (const file of appJsFiles) {
        const src = fs.readFileSync(file, 'utf8');
        for (const m of src.matchAll(/require\(\s*path\.join\(([^)]*)\)\s*\)/g)) {
          const expr = m[1];
          if (!/\.\./.test(expr)) continue;
          const ident = (expr.match(/^\s*([A-Za-z_$][\w$]*)/) || [])[1];
          const baseFn = ident ? KNOWN_BASES[ident] : null;
          if (!baseFn) {
            skippedBases.push({ from: path.relative(APP_DIR, file), ident: ident || '(字面量)' });
            continue;
          }
          const parts = [...expr.matchAll(/'([^']+)'/g)].map((x) => x[1]);
          const resolved = path.resolve(baseFn(file), ...parts);
          allRequires.push({
            from: path.relative(APP_DIR, file),
            to: path.relative(APP_DIR, resolved),
            resolved,
            // 只有"解析后落在 app/ 之外"才算跨目录依赖；bin/stop.js 的 '..' 仍在 app/ 内，不算
            escapes: path.relative(APP_DIR, resolved).startsWith('..'),
            ships: !path.relative(APP_DIR, file).split(path.sep).includes('test')
          });
        }
      }
      const crossDir = allRequires.filter((r) => r.escapes);
      const shipped = crossDir.filter((r) => r.ships);

      ok('跨目录的依赖都指向真实存在的文件',
        allRequires.every((r) => fs.existsSync(r.resolved)),
        allRequires.filter((r) => !fs.existsSync(r.resolved)).map((r) => `${r.from} -> ${r.to}`).join('; '));
      if (skippedBases.length) {
        console.log(`  NOTE  未解析基线（不在上面两条规则内，未检查）：${skippedBases.map((s) => `${s.from}:${s.ident}`).join(', ')}`);
      }

      // 打包契约：会进 exe 的那些文件，跨目录时只能依赖"平级的 peer/"
      // （Harness B1 踩过：只装 app 会 Cannot find module ...resources\peer\lib\bridge.js）
      ok(`打进包的文件里，跨目录依赖只有平级 peer/（实测 ${shipped.length} 处）`,
        shipped.length > 0 && shipped.every((r) => r.to.replace(/\//g, '\\').startsWith('..\\peer\\')),
        JSON.stringify(shipped.map((r) => `${r.from} -> ${r.to}`)));
      console.log(`  NOTE  打进包的跨目录依赖：${shipped.map((r) => `${r.from} → ${r.to}`).join('; ') || '(无)'}`);
      const testOnly = crossDir.filter((r) => !r.ships);
      if (testOnly.length) {
        console.log(`  NOTE  仅测试文件引用的跨目录路径（不影响打包）：${testOnly.map((r) => r.from).join(', ')}`);
      }

      // 如果 exe 包在，直接检查里面的平级关系（Harness B1 的产物）
      const packaged = path.join(APP_DIR, '..', 'desktop', 'out', 'DSH Pair', 'resources', 'pair');
      if (!fs.existsSync(packaged)) {
        console.log('  SKIP  没找到 exe 包（desktop\\out\\...\\resources\\pair），跳过打包结构检查');
      } else {
        ok('exe 包里 app/ 与 peer/ 平级',
          fs.existsSync(path.join(packaged, 'app', 'server.js')) && fs.existsSync(path.join(packaged, 'peer', 'lib', 'bridge.js')),
          packaged);
        ok('exe 包里 app/ 与 peer/ 的相对位置能解开 app 的 require',
          fs.existsSync(path.resolve(path.join(packaged, 'app', 'lib'), '..', '..', 'peer', 'lib', 'bridge.js')));

        // 信息性：exe 里的 app/ 是打包那一刻的快照，我改了 app/ 之后它就会过期
        const stale = [];
        for (const rel of ['server.js', 'public/app.js', 'lib/sides.js']) {
          const a = path.join(APP_DIR, rel);
          const b = path.join(packaged, 'app', rel);
          if (!fs.existsSync(a) || !fs.existsSync(b)) continue;
          if (fs.readFileSync(a).equals(fs.readFileSync(b))) continue;
          stale.push(rel);
        }
        if (stale.length) {
          console.log(`  NOTE  exe 里的 app/ 已过期（${stale.join(', ')}）—— 交付前需要用 desktop\\build.ps1 重新打包`);
        } else {
          console.log('  NOTE  exe 里的 app/ 快照与当前源码一致');
        }
        ok('exe 的可执行文件存在', fs.existsSync(path.join(packaged, '..', '..', 'DSH Pair.exe')), path.join(packaged, '..', '..', 'DSH Pair.exe'));
      }
    }

    // ------------------------------------------------------------ B5 空洞回填
    section('B5 · 高频输出不丢消息（时间线空洞检测 + 回填）');
    {
      // 服务端：after>0 且窗口最老的一条 > after+1 → 判定有空洞
      const gapMock = createMockBridge(
        mockOptions({
          sessions: [SESSION],
          items: Array.from({ length: 10 }, (_, i) =>
            item({ orderSeq: i + 1, type: 'message', role: 'assistant', content: { kind: 'markdown', text: `第 ${i + 1} 条` } })
          )
        })
      );
      await gapMock.listen;
      const epGap = path.join(TMP, 'endpoint-gap.json');
      writeEndpoint(epGap, gapMock);
      const sidesGap = path.join(TMP, 'sides-gap.json');
      fs.writeFileSync(
        sidesGap,
        JSON.stringify({ sides: [{ id: 'desktop', short: 'D', label: 'D', workspace: '%WORKSPACE_B%', endpointPath: epGap }] }),
        'utf8'
      );
      const portGap = await freePort;
      const srvGap = await startServer(sidesGap, portGap);
      try {
        const contiguous = await api(srvGap, '/api/timeline?side=desktop&after=3&tail=10');
        ok('连续窗口不报空洞', contiguous.json.gap === false, JSON.stringify({ gap: contiguous.json.gap }));
        const gapRes = await api(srvGap, '/api/timeline?side=desktop&after=2&tail=3');
        ok('窗口追不上 after 时报空洞', gapRes.json.gap === true, JSON.stringify({ gap: gapRes.json.gap, oldest: gapRes.json.oldestSeq }));
        ok('空洞时也照常返回窗口内条目', gapRes.json.items.length === 3 && gapRes.json.returned === 3);
      } finally {
        await srvGap.stop;
        await gapMock.close;
      }

      // 前端（真浏览器）：第二次轮询前塞 60 条 → 客户端应该自动回填，一条不丢
      let snapshots = 0;
      const burst = createMockBridge(
        mockOptions({
          sessions: [SESSION],
          items: [item({ orderSeq: 1, type: 'message', role: 'assistant', content: { kind: 'markdown', text: '起点' } })],
          onSnapshot: (params, api2) => {
            snapshots++;
            if (snapshots === 2) {
              for (let i = 1; i <= 60; i++) {
                api2.appendItem(
                  item({ type: 'message', role: 'assistant', content: { kind: 'markdown', text: `突发 ${i}` } })
                );
              }
            }
          }
        })
      );
      await burst.listen;
      const epBurst = path.join(TMP, 'endpoint-burst.json');
      writeEndpoint(epBurst, burst);
      const sidesBurst = path.join(TMP, 'sides-burst.json');
      fs.writeFileSync(
        sidesBurst,
        JSON.stringify({ sides: [{ id: 'desktop', short: 'D', label: 'D', workspace: '%WORKSPACE_B%', endpointPath: epBurst }] }),
        'utf8'
      );
      const portBurst = await freePort;
      const srvBurst = await startServer(sidesBurst, portBurst);
      try {
        const dom = await browserDom(`http://127.0.0.1:${portBurst}/`, 7000);
        if (!dom) {
          console.log('  SKIP  没找到浏览器，跳过空洞回填的浏览器检查');
        } else {
          const rendered = (dom.match(/突发 \d+/g) || []).length;
          ok(`一次涌入 60 条全部渲染出来（实测 ${rendered} 条）`, rendered >= 60, `只渲染了 ${rendered} 条`);
          ok('起点那条还在（说明是追加不是重载）', dom.includes('起点'));
        }
      } finally {
        await srvBurst.stop;
        await burst.close;
      }
    }

    // ------------------------------------------------------------ 零依赖
    section('零依赖');
    {
      const pkg = path.join(APP_DIR, 'package.json');
      ok('没有 package.json', !fs.existsSync(pkg));
      const builtin = new Set(require('module').builtinModules);
      const walk = (dir) =>
        fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
          const p = path.join(dir, e.name);
          return e.isDirectory ? walk(p) : [p];
        });
      const jsFiles = walk(APP_DIR).filter((f) => f.endsWith('.js'));
      const offenders = [];
      for (const file of jsFiles) {
        const src = fs.readFileSync(file, 'utf8');
        for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
          const target = m[1];
          if (target.startsWith('.') || target.startsWith('node:')) continue;
          if (!builtin.has(target)) offenders.push(`${path.relative(APP_DIR, file)} → ${target}`);
        }
      }
      ok(`require 都是内置或相对路径（扫了 ${jsFiles.length} 个文件）`, offenders.length === 0, offenders.join('; '));
    }
  } finally {
    await srv.stop;
    await mockA.close;
    await mockB.close;
  }

  // ------------------------------------------------------------ 端口占用
  section('端口被占用时的表现（启动器要能看懂）');
  {
    const sidesPath2 = path.join(TMP, 'sides2.json');
    fs.copyFileSync(sidesPath, sidesPath2);
    const p = await freePort;
    const first = await startServer(sidesPath2, p);
    const secondPort = p; // 同一个端口
    const child = spawn(process.execPath, [SERVER, '--port', String(secondPort), '--sides', sidesPath2], { cwd: APP_DIR });
    SPAWNED.add(child);
    child.on('close',  => SPAWNED.delete(child));
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr += d; });
    const code = await new Promise((resolve) => {
      child.on('close', resolve);
      setTimeout( => {
        child.kill;
        resolve('timeout');
      }, 8000);
    });
    ok('第二个实例退出码 2', code === 2, `code=${code}`);
    ok('提示里说清了端口被占 + 怎么看界面', /already in use/.test(stderr) && /http:\/\/127\.0\.0\.1/.test(stderr), stderr.slice(0, 300));
    await first.stop;
  }

  console.log(`\n${'='.repeat(60)}`);
  // Windows 上 child.kill 是硬终止，进程来不及跑清理，会留下 pid 文件；
  // 这里替它擦干净（stop.cmd 也能识别这种"pid 已消失"的残留并删掉）。
  for (const f of fs.readdirSync(APP_DIR).filter((n) => /^server.*\.pid$/.test(n))) {
    try {
      fs.unlinkSync(path.join(APP_DIR, f));
    } catch (err) {
      /* 忽略 */
    }
  }
  // 本次测试新增的日志也删掉（跑测试会起很多实例，每个都会写日志）。
  // 规则：保留默认端口(8787)的日志（那是正在跑的实例），其余只保留"端口还在监听"的，
  // 死端口的日志就是垃圾（也能顺手清掉以前崩掉那轮留下的）。
  try {
    for (const n of fs.readdirSync(LOG_DIR)) {
      if (logsBefore.has(n) && /8787/.test(n)) continue;
      const m = n.match(/-(\d+)\.log$/);
      const logPort = m ? Number(m[1]) : null;
      if (logPort === 8787) continue;
      if (logPort && isPortListening(logPort)) continue;
      fs.rmSync(path.join(LOG_DIR, n), { force: true });
    }
  } catch (err) {
    /* 忽略 */
  }
  if (failures.length === 0) {
    console.log(`全部通过：${pass} 项`);
  } else {
    console.log(`${pass} 通过, ${failures.length} 失败：`);
    for (const f of failures) console.log(`  - ${f}`);
  }
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (err) {
    /* 忽略 */
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

main.catch((err) => {
  console.error('测试自身崩了：', err);
  process.exit(1);
});
