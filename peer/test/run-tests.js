/*
 * test/run-tests.js —— 离线验收
 * ---------------------------------------------------------------
 * 全部跑在本地假 bridge（test/mock-bridge.js）上，**不碰真通道**，
 * 所以即使 DSH Desktop 正在跑也不会往任何会话里投消息。
 *
 * 覆盖 SPEC 第 5 节的 8 条验收标准 + 第 4.3 节的健壮性要求。
 * 跑法：node test/run-tests.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createMockBridge, writeEndpoint, item } = require('./mock-bridge');

const PEER_DIR = path.join(__dirname, '..');
const PEER = path.join(PEER_DIR, 'peer.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-peer-test-'));
const REAL_EXT = 'session-<id>';

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

/**
 * 必须用异步 spawn，**不能用 spawnSync**：
 * 假 bridge 服务端就跑在本进程里，spawnSync 会把本进程的事件循环堵死，
 * 于是 mock 永远回不了包，子进程每次都卡到 20s 请求超时。
 */
function runCli(args, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [PEER, ...args], { cwd: PEER_DIR });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, o.timeout || 30000);
    const finish = (code, signal, spawnError) => {
      clearTimeout(timer);
      resolve({
        status: code,
        signal,
        stdout,
        stderr,
        ms: Date.now() - started,
        timedOut,
        spawnError: spawnError || null
      });
    };
    child.on('close', (code, signal) => finish(code, signal, null));
    child.on('error', (err) => finish(null, null, err));
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

let epCounter = 0;
async function withMock(options, fn) {
  const mock = createMockBridge(options);
  await mock.listen();
  const ep = path.join(TMP, `endpoint-${++epCounter}.json`);
  writeEndpoint(ep, mock);
  try {
    return await fn(mock, ep);
  } finally {
    await mock.close();
  }
}

// 一个"标准"的 mock：一条 live 会话，外部 id 用真机那个
function realishOptions(extra) {
  return Object.assign(
    {
      sessions: [
        {
          sessionId: 'sess_<id>',
          externalSessionId: REAL_EXT,
          title: '两个agent协作贪吃蛇分工',
          cwd: '%WORKSPACE_B%',
          orderingTime: 1,
          metadata: { live: true, persisted: true, readOnly: false }
        }
      ]
    },
    extra || {}
  );
}

async function main() {
  console.log(`dsh-peer 验收测试  (tmp=${TMP})`);

  // ---------------------------------------------------------- 验收 1
  section('验收 1：status —— 握手 + identity + 能力表');
  await withMock(realishOptions(), async (mock, ep) => {
    const r = await runCli(['status', '--json', '--endpoint', ep]);
    const j = parseJson(r.stdout);
    ok('退出码 0', r.status === 0, `status=${r.status} stderr=${r.stderr}`);
    ok('stdout 是合法 JSON', !!j, r.stdout.slice(0, 300));
    ok('identity.runtime === "dsh"', !!(j && j.identity && j.identity.runtime === 'dsh'));
    ok('session.send_message.allowed === true', !!(j && j.sendMessageAllowed === true));
    ok('endpoint 里带 port', !!(j && j.endpoint && j.endpoint.port === mock.state.port));

    const human = await runCli(['status', '--endpoint', ep]);
    ok(
      '人类可读输出含 identity.runtime / allowed',
      human.status === 0 &&
        human.stdout.includes('identity.runtime') &&
        human.stdout.includes('session.send_message.allowed true'),
      human.stdout.slice(0, 300)
    );
  });

  // ---------------------------------------------------------- 验收 2
  section('验收 2：list --json 能列出目标会话');
  await withMock(realishOptions(), async (mock, ep) => {
    const r = await runCli(['list', '--json', '--endpoint', ep]);
    const j = parseJson(r.stdout);
    ok('退出码 0', r.status === 0, r.stderr);
    ok('含有 ' + REAL_EXT, r.stdout.includes(REAL_EXT));
    ok('metadata.live 传下来了', !!(j && j.sessions[0] && j.sessions[0].metadata && j.sessions[0].metadata.live === true));
    ok('cwd 传下来了', !!(j && j.sessions[0] && j.sessions[0].cwd === '%WORKSPACE_B%'));
  });

  // ---------------------------------------------------------- state
  section('state：status / cwd / 模型');
  await withMock(realishOptions(), async (mock, ep) => {
    const r = await runCli(['state', '--json', '--endpoint', ep]);
    const j = parseJson(r.stdout);
    ok('退出码 0 且 status=idle', r.status === 0 && j && j.status === 'idle', r.stderr);
    ok('cwd 正确', !!(j && j.cwd === '%WORKSPACE_B%'));
    ok('模型信息在', !!(j && j.model === 'deepseek-flash' && j.provider === 'deepseek-official'));

    mock.state.status = 'running';
    const r2 = await runCli(['state', '--json', '--endpoint', ep]);
    ok('status 能反映 running', (parseJson(r2.stdout) || {}).status === 'running');
  });

  // ---------------------------------------------------------- read
  section('read：正文取得到，reasoning 不能混进来');
  await withMock(
    realishOptions({
      items: [
        item({ orderSeq: 1, type: 'message', role: 'user', content: { kind: 'markdown', text: '用户的问题' } }),
        item({
          orderSeq: 2,
          type: 'system',
          role: 'assistant',
          content: { kind: 'reasoning', text: '这是思考过程，不该被当成回复' }
        }),
        item({
          orderSeq: 3,
          type: 'tool',
          role: 'assistant',
          content: { kind: 'tool_call', toolName: 'read', input: {}, output: 'X'.repeat(5000), isError: false }
        }),
        item({ orderSeq: 4, type: 'message', role: 'assistant', content: { kind: 'markdown', text: '这是助手正文' } })
      ]
    }),
    async (mock, ep) => {
      const r = await runCli(['read', '--json', '--tail', '10', '--endpoint', ep]);
      const j = parseJson(r.stdout);
      ok('退出码 0', r.status === 0, r.stderr);
      ok('4 条都在', !!(j && j.items.length === 4), JSON.stringify(j && j.items.map((i) => i.kind)));
      const assistant = j && j.items.find((i) => i.kind === 'markdown' && i.role === 'assistant');
      ok('助手正文完整', !!(assistant && assistant.text === '这是助手正文'));
      const reasoning = j && j.items.find((i) => i.kind === 'reasoning');
      ok('reasoning 的 text 没被当成正文', !!(reasoning && reasoning.text === undefined));
      const tool = j && j.items.find((i) => i.type === 'tool');
      ok('工具条目只给长度不给 output', !!(tool && tool.output === undefined && tool.outputChars === 5000));
      ok('用户消息正文完整', !!(j && j.items[0].text === '用户的问题'));

      const rf = await runCli(['read', '--json', '--tail', '10', '--full', '--endpoint', ep]);
      const jf = parseJson(rf.stdout);
      ok('--full 时带 output', !!(jf && jf.items.find((i) => i.type === 'tool').output === 'X'.repeat(5000)));
    }
  );

  // ---------------------------------------------------------- send（不等）
  section('send（不带 --wait）：投递成功即返回');
  await withMock(realishOptions(), async (mock, ep) => {
    const r = await runCli(['send', '--session', REAL_EXT, '--text', '你好，这是一条测试', '--json', '--endpoint', ep]);
    const j = parseJson(r.stdout);
    ok('退出码 0 且 accepted', r.status === 0 && j && j.accepted === true, r.stderr);
    ok('对端收到的正文一致', mock.state.received.length === 1 && mock.state.received[0].content === '你好，这是一条测试');
    ok('带了 clientMessageId', !!(mock.state.received[0].clientMessageId && mock.state.received[0].clientMessageId.length > 10));
  });

  // ---------------------------------------------------------- 验收 3
  section('验收 3：send --wait --json —— stdout 只有那段 JSON，reply 是真实回复');
  await withMock(
    realishOptions({
      onStartTurn: (params, api) => {
        api.state.status = 'running';
        api.appendItem(item({ type: 'message', role: 'user', content: { kind: 'markdown', text: params.content } }));
        setTimeout(() => {
          api.appendItem(
            item({ type: 'message', role: 'assistant', content: { kind: 'markdown', text: '我是 mock 的回复：收到 ✅' } })
          );
          api.state.status = 'idle';
        }, 250);
      }
    }),
    async (mock, ep) => {
      const r = await runCli(['send', '--session', REAL_EXT, '--text', '喂', '--wait', '--json', '--endpoint', ep], {
        timeout: 30000
      });
      ok('退出码 0', r.status === 0, `status=${r.status} stderr=${r.stderr}`);
      const j = parseJson(r.stdout);
      ok('stdout 整段就是合法 JSON（没混日志）', !!j, JSON.stringify(r.stdout.slice(0, 200)));
      ok('ok === true', !!(j && j.ok === true));
      ok('reply 就是对方正文', !!(j && j.reply === '我是 mock 的回复：收到 ✅'), j && JSON.stringify(j.reply));
      ok('elapsedMs 是数字', !!(j && typeof j.elapsedMs === 'number' && j.elapsedMs >= 0));
      ok('诊断信息都在 stderr', r.stderr.includes('[info]') && !r.stdout.includes('[info]'));
      ok('确实等到了 running→idle', r.stderr.includes('回合结束'), r.stderr);
    }
  );

  section('send --wait（不带 --json）：stdout 恰好是正文');
  await withMock(
    realishOptions({
      onStartTurn: (params, api) => {
        api.state.status = 'running';
        api.appendItem(item({ type: 'message', role: 'user', content: { kind: 'markdown', text: params.content } }));
        setTimeout(() => {
          api.appendItem(item({ type: 'message', role: 'assistant', content: { kind: 'markdown', text: '纯正文回复' } }));
          api.state.status = 'idle';
        }, 200);
      }
    }),
    async (mock, ep) => {
      const r = await runCli(['send', '--session', REAL_EXT, '--text', 'x', '--wait', '--endpoint', ep]);
      ok('退出码 0', r.status === 0, r.stderr);
      ok('stdout === 正文 + 换行', r.stdout === '纯正文回复\n', JSON.stringify(r.stdout));
    }
  );

  // ---------------------------------------------------------- 验收 7
  section('验收 7：--text-file 中文/换行/引号/emoji 逐字符一致');
  const tricky =
    '第一行：中文 “引号” 和 \'单引号\'\n第二行：tab\t制表 emoji 🐍✅🎮\n第三行："双引号内的逗号, 和反斜杠\\ 结尾\n\n';
  const trickyFile = path.join(TMP, 'tricky.txt');
  fs.writeFileSync(trickyFile, tricky, 'utf8');
  await withMock(
    realishOptions({
      onStartTurn: (params, api) => {
        api.state.status = 'running';
        api.appendItem(item({ type: 'message', role: 'user', content: { kind: 'markdown', text: params.content } }));
        setTimeout(() => {
          api.appendItem(
            item({ type: 'message', role: 'assistant', content: { kind: 'markdown', text: 'echo:' + params.content } })
          );
          api.state.status = 'idle';
        }, 150);
      }
    }),
    async (mock, ep) => {
      const r = await runCli(['send', '--session', REAL_EXT, '--text-file', trickyFile, '--wait', '--json', '--endpoint', ep]);
      const j = parseJson(r.stdout);
      ok('退出码 0', r.status === 0, r.stderr);
      ok(
        '对端收到的内容与文件逐字符一致',
        mock.state.received[0].content === tricky,
        JSON.stringify(mock.state.received[0].content)
      );
      ok('换行数量一致', mock.state.received[0].content.split('\n').length === tricky.split('\n').length);
      ok('回复里也原样回来了', !!(j && j.reply === 'echo:' + tricky));
      ok('chars 没算错', !!(j && j.chars === ('echo:' + tricky).length));
    }
  );

  // ---------------------------------------------------------- 验收 4
  section('验收 4：重启后端口/token 变化 —— 每次重新读 endpoint.json');
  {
    const mockA = createMockBridge(realishOptions({ token: 'token-A' }));
    const mockB = createMockBridge(realishOptions({ token: 'token-B' }));
    await mockA.listen();
    await mockB.listen();
    const ep = path.join(TMP, 'endpoint-swap.json');
    writeEndpoint(ep, mockA, { token: 'token-A' });
    const r1 = await runCli(['status', '--json', '--endpoint', ep]);
    ok('第一次（mock A）成功', r1.status === 0 && (parseJson(r1.stdout) || {}).ok === true, r1.stderr);

    // 模拟 DSH Desktop 重启：同一路径的 endpoint.json 换了 port + token
    writeEndpoint(ep, mockB, { token: 'token-B' });
    const r2 = await runCli(['status', '--json', '--endpoint', ep]);
    const j2 = parseJson(r2.stdout);
    ok('换成 mock B 后无需改任何参数仍成功', r2.status === 0 && j2 && j2.ok === true, r2.stderr);
    ok('确实连到了新端口', !!(j2 && j2.endpoint.port === mockB.state.port), JSON.stringify(j2 && j2.endpoint));

    await mockB.close();
    const r3 = await runCli(['status', '--json', '--endpoint', ep], { timeout: 15000 });
    ok('新端口关掉后立刻失败（没缓存旧连接）', r3.status !== 0 && r3.ms < 12000, `status=${r3.status} ms=${r3.ms}`);
    await mockA.close();
  }

  // ---------------------------------------------------------- 验收 5
  section('验收 5：错误路径 —— 报错清楚、退出码非 0、不挂死');
  {
    const missing = path.join(TMP, 'not-here.json');
    const r = await runCli(['status', '--endpoint', missing], { timeout: 15000 });
    ok('endpoint 不存在 → 非 0', r.status !== 0);
    ok('退出码是 3（endpoint 类）', r.status === 3, `status=${r.status}`);
    ok('报错里含路径', r.stderr.includes(missing), r.stderr);
    ok('没有挂死（<3s）', r.ms < 3000, `ms=${r.ms}`);
    ok('stdout 干净', r.stdout === '', JSON.stringify(r.stdout));

    // 端口不通：先占一个端口再放掉
    const mock = createMockBridge(realishOptions());
    await mock.listen();
    const deadPort = mock.state.port;
    await mock.close();
    const deadEp = path.join(TMP, 'dead.json');
    fs.writeFileSync(deadEp, JSON.stringify({ version: 1, host: '127.0.0.1', port: deadPort, token: 'x', pid: 1 }), 'utf8');
    const r2 = await runCli(['status', '--endpoint', deadEp], { timeout: 15000 });
    ok('端口不通 → 非 0', r2.status !== 0);
    ok('退出码是 4（连接类）', r2.status === 4, `status=${r2.status}`);
    ok('报错里含 host:port', r2.stderr.includes(`127.0.0.1:${deadPort}`), r2.stderr);
    ok('没有挂死（<8s）', r2.ms < 8000, `ms=${r2.ms}`);
  }

  section('错误路径：endpoint.json 内容坏掉 / token 不对 / 能力不足');
  {
    const badJson = path.join(TMP, 'bad.json');
    fs.writeFileSync(badJson, '{ this is not json', 'utf8');
    const r = await runCli(['status', '--endpoint', badJson]);
    ok('JSON 坏了 → 退出码 3 且报错清楚', r.status === 3 && r.stderr.includes('不是合法 JSON'), r.stderr);

    await withMock(realishOptions({ token: 'right-token' }), async (mock, ep) => {
      writeEndpoint(ep, mock, { token: 'wrong-token' });
      const r2 = await runCli(['status', '--endpoint', ep]);
      ok('token 不对 → 非 0 且报出 authToken 错误', r2.status !== 0 && /authToken/i.test(r2.stderr), r2.stderr);
    });

    await withMock(realishOptions({ sendAllowed: false }), async (mock, ep) => {
      const r3 = await runCli(['status', '--endpoint', ep]);
      ok('send_message 不许 → 非 0 并说明原因', r3.status !== 0 && r3.stderr.includes('session.send_message'), r3.stderr);
    });
  }

  // ---------------------------------------------------------- 验收 6
  section('验收 6：参数校验');
  await withMock(realishOptions(), async (mock, ep) => {
    const r = await runCli(['send', '--session', REAL_EXT, '--json', '--endpoint', ep]);
    ok('缺 --text/--text-file → 退出码 2', r.status === 2, `status=${r.status}`);
    ok('提示里写明要用 --text-file', r.stderr.includes('--text-file'), r.stderr);
    ok('没有真的发出去', mock.state.received.length === 0);
  });

  await withMock(
    realishOptions({
      sessions: [
        { sessionId: 'sess_A', externalSessionId: 'ext-A', title: '会话A', cwd: 'E:\\a', metadata: { live: true } },
        { sessionId: 'sess_B', externalSessionId: 'ext-B', title: '会话B', cwd: 'E:\\b', metadata: { live: true } }
      ]
    }),
    async (mock, ep) => {
      const r = await runCli(['send', '--text', 'hi', '--json', '--endpoint', ep]);
      ok('两个 live 会话且没指定 → 退出码 2', r.status === 2, `status=${r.status} ${r.stderr}`);
      ok('列出两个候选让人选', r.stderr.includes('ext-A') && r.stderr.includes('ext-B'), r.stderr);
      ok('没有瞎猜发出去', mock.state.received.length === 0);

      const r2 = await runCli(['send', '--session', 'ext-B', '--text', 'hi', '--json', '--endpoint', ep]);
      ok('显式指定 externalSessionId 就能发', r2.status === 0 && mock.state.received.length === 1, r2.stderr);
      ok('发给了 B 而不是 A', mock.state.received[0].sessionId === 'sess_B');
    }
  );

  // ---------------------------------------------------------- 健壮性
  section('健壮性：8 MiB 帧保护 / 请求超时 / ok:false / 通知 / 竞态');
  await withMock(realishOptions(), async (mock, ep) => {
    const bigFile = path.join(TMP, 'big.txt');
    fs.writeFileSync(bigFile, 'x'.repeat(9 * 1024 * 1024), 'utf8');
    const r = await runCli(['send', '--session', REAL_EXT, '--text-file', bigFile, '--json', '--endpoint', ep], {
      timeout: 30000
    });
    ok('9 MiB 正文 → 拒绝且退出码 2', r.status === 2, `status=${r.status} ${r.stderr.slice(0, 200)}`);
    ok('报错提到 8 MiB', /8 MiB/.test(r.stderr), r.stderr.slice(0, 300));
    ok('真的没发出去', mock.state.received.length === 0);
  });

  await withMock(
    realishOptions({
      onStartTurn: () => {
        // 永远保持 running → 触发总超时
      },
      status: 'running'
    }),
    async (mock, ep) => {
      const r = await runCli(
        [
          'send', '--session', REAL_EXT, '--text', 'x', '--wait', '--json',
          '--timeout-ms', '1200', '--interval-ms', '200', '--endpoint', ep
        ],
        { timeout: 20000 }
      );
      ok('总超时 → 退出码 7', r.status === 7, `status=${r.status} ${r.stderr.slice(0, 200)}`);
      ok('报错说明超时原因', /等待超时/.test(r.stderr), r.stderr.slice(0, 300));
      ok('stdout 为空（不输出半截 JSON）', r.stdout === '', JSON.stringify(r.stdout));
    }
  );

  await withMock(
    realishOptions({ startTurnResult: { ok: false, code: 'session_archived', message: '会话已归档' } }),
    async (mock, ep) => {
      const r = await runCli(['send', '--session', REAL_EXT, '--text', 'x', '--wait', '--json', '--endpoint', ep]);
      ok('ok:false → 退出码 6', r.status === 6, `status=${r.status} ${r.stderr}`);
      ok('报错里带 code', r.stderr.includes('session_archived'), r.stderr);
      ok('stdout 干净', r.stdout === '');
    }
  );

  await withMock(
    realishOptions({
      notifications: [
        { jsonrpc: '2.0', method: 'timeline.itemUpsert', params: { itemId: 'x' } },
        { jsonrpc: '2.0', method: 'session.state.updated', params: { status: 'idle' } },
        { jsonrpc: '2.0', method: '某个从未见过的通知', params: {} },
        { jsonrpc: '2.0', method: 'notice.upsert', params: { text: 'hello' } }
      ],
      onStartTurn: (params, api) => {
        api.state.status = 'running';
        api.appendItem(item({ type: 'message', role: 'user', content: { kind: 'markdown', text: params.content } }));
        setTimeout(() => {
          api.appendItem(
            item({ type: 'message', role: 'assistant', content: { kind: 'markdown', text: '通知轰炸下依然正常' } })
          );
          api.state.status = 'idle';
        }, 200);
      }
    }),
    async (mock, ep) => {
      const r = await runCli(['send', '--session', REAL_EXT, '--text', 'x', '--wait', '--json', '--endpoint', ep]);
      const j = parseJson(r.stdout);
      ok('未知通知不影响功能', r.status === 0 && j && j.reply === '通知轰炸下依然正常', r.stderr);
      ok('stdout 仍然是纯 JSON', !!j);
    }
  );

  await withMock(
    realishOptions({
      onStartTurn: (params, api) => {
        // 一轮跑得极快：从未观测到 running，直接出正文并保持 idle
        api.appendItem(item({ type: 'message', role: 'user', content: { kind: 'markdown', text: params.content } }));
        api.appendItem(item({ type: 'message', role: 'assistant', content: { kind: 'markdown', text: '快到没抓到 running' } }));
      }
    }),
    async (mock, ep) => {
      const r = await runCli(['send', '--session', REAL_EXT, '--text', 'x', '--wait', '--json', '--endpoint', ep]);
      const j = parseJson(r.stdout);
      ok('没抓到 running 也能正确收尾（竞态保护）', r.status === 0 && j && j.reply === '快到没抓到 running', r.stderr);
    }
  );

  await withMock(
    realishOptions({
      status: 'running',
      items: [
        item({ orderSeq: 10, type: 'message', role: 'assistant', content: { kind: 'markdown', text: '上一轮的旧正文' } })
      ],
      onStartTurn: (params, api) => {
        api.appendItem(item({ type: 'message', role: 'user', content: { kind: 'markdown', text: params.content } }));
        setTimeout(() => {
          api.appendItem(item({ type: 'message', role: 'assistant', content: { kind: 'markdown', text: '新回复' } }));
          api.state.status = 'idle';
        }, 200);
      }
    }),
    async (mock, ep) => {
      const r = await runCli(['send', '--session', REAL_EXT, '--text', '新消息', '--wait', '--json', '--endpoint', ep]);
      const j = parseJson(r.stdout);
      ok('目标会话原本在跑别的回合时，取的是新回复', !!(j && j.reply === '新回复'), j && JSON.stringify(j.reply));
      ok('且提示了归属风险', r.stderr.includes('[warn]'), r.stderr.slice(0, 400));
    }
  );

  // 回归测试：目标会话原本在跑 → 它的旧回合先结束（正文已出现），我们发的消息还没落地。
  // 这个窗口里绝不能把旧回合的正文当成本次回复。
  await withMock(
    realishOptions({
      status: 'running',
      items: [
        item({ orderSeq: 10, type: 'message', role: 'assistant', content: { kind: 'markdown', text: '更早的正文' } })
      ],
      onStartTurn: (params, api) => {
        setTimeout(() => {
          // 危险窗口：旧回合结束、正文落地，但我们的消息还没进时间线
          api.appendItem(
            item({ type: 'message', role: 'assistant', content: { kind: 'markdown', text: '旧回合的收尾正文（不是回复）' } })
          );
          api.state.status = 'idle';
        }, 300);
        setTimeout(() => {
          api.appendItem(item({ type: 'message', role: 'user', content: { kind: 'markdown', text: params.content } }));
          api.state.status = 'running';
        }, 800);
        setTimeout(() => {
          api.appendItem(
            item({ type: 'message', role: 'assistant', content: { kind: 'markdown', text: '真正给这条消息的回复' } })
          );
          api.state.status = 'idle';
        }, 1100);
      }
    }),
    async (mock, ep) => {
      const r = await runCli(['send', '--session', REAL_EXT, '--text', '新消息', '--wait', '--json', '--endpoint', ep], {
        timeout: 25000
      });
      const j = parseJson(r.stdout);
      ok('退出码 0', r.status === 0, r.stderr);
      ok(
        '不会把"旧回合收尾正文"误当回复',
        !!(j && j.reply === '真正给这条消息的回复'),
        j && JSON.stringify(j.reply)
      );
      ok('stderr 里能看到定位到了我们发出的消息', /定位到刚发出的用户消息/.test(r.stderr), r.stderr.slice(0, 500));
    }
  );

  // 对端中途断线：连接被掐掉后要能重连（重连会重读 endpoint.json）并继续等到回复
  await withMock(
    realishOptions({
      onStartTurn: (params, api) => {
        api.state.status = 'running';
        api.appendItem(item({ type: 'message', role: 'user', content: { kind: 'markdown', text: params.content } }));
        setTimeout(() => {
          for (const s of api.state.sockets) {
            try {
              s.destroy();
            } catch (err) {
              /* 忽略 */
            }
          }
        }, 300);
        setTimeout(() => {
          api.appendItem(
            item({ type: 'message', role: 'assistant', content: { kind: 'markdown', text: '断线之后依然拿到了回复' } })
          );
          api.state.status = 'idle';
        }, 1500);
      }
    }),
    async (mock, ep) => {
      const r = await runCli(['send', '--session', REAL_EXT, '--text', 'x', '--wait', '--json', '--endpoint', ep], {
        timeout: 30000
      });
      const j = parseJson(r.stdout);
      ok('对端中途断线后能自愈并拿到回复', r.status === 0 && j && j.reply === '断线之后依然拿到了回复', `status=${r.status} ${r.stderr.slice(0, 400)}`);
      ok('stderr 里能看到重连过程', /重连/.test(r.stderr), r.stderr.slice(0, 300));
      ok('stdout 依然是纯 JSON', !!j);
    }
  );

  // 对端**重启**：连接被掐断 + endpoint.json 短暂消失（ENOENT）+ 换 token。
  // 这正是小黑改插件后重启 App 的真实形态 —— 等待必须熬过去。
  {
    let epForRestart = null;
    await withMock(
      realishOptions({
        onStartTurn: (params, api) => {
          api.state.status = 'running';
          api.appendItem(item({ type: 'message', role: 'user', content: { kind: 'markdown', text: params.content } }));
          setTimeout(() => {
            for (const s of api.state.sockets) {
              try {
                s.destroy();
              } catch (err) {
                /* 忽略 */
              }
            }
            try {
              fs.unlinkSync(epForRestart); // 宿主重启时端点文件会短暂消失
            } catch (err) {
              /* 忽略 */
            }
          }, 300);
          setTimeout(() => {
            api.state.token = 'token-after-restart'; // 重启后 token 也换了
            writeEndpoint(epForRestart, { state: api.state }); // 端点文件写回来（新 token）
            api.appendItem(
              item({ type: 'message', role: 'assistant', content: { kind: 'markdown', text: '对端重启期间也等到了回复' } })
            );
            api.state.status = 'idle';
          }, 3000);
        }
      }),
      async (mock, ep) => {
        epForRestart = ep;
        const r = await runCli(['send', '--session', REAL_EXT, '--text', 'x', '--wait', '--json', '--timeout-ms', '30000', '--endpoint', ep], {
          timeout: 40000
        });
        const j = parseJson(r.stdout);
        ok(
          '对端重启（断线 + 端点文件消失 + 换 token）也能等到回复',
          r.status === 0 && j && j.reply === '对端重启期间也等到了回复',
          `status=${r.status} ${r.stderr.slice(0, 400)}`
        );
        ok('stderr 里说明了在等对端重启', /对端端点文件不在|重连/.test(r.stderr), r.stderr.slice(0, 300));
      }
    );
  }

  await withMock(
    realishOptions({
      onStartTurn: (params, api) => {
        api.appendItem(item({ type: 'message', role: 'user', content: { kind: 'markdown', text: params.content } }));
        api.state.status = 'idle'; // 这一轮只调工具、没有文字
      }
    }),
    async (mock, ep) => {
      const r = await runCli(
        ['send', '--session', REAL_EXT, '--text', 'x', '--wait', '--json', '--timeout-ms', '5000', '--endpoint', ep],
        { timeout: 20000 }
      );
      ok('回合结束但没有正文 → 退出码 8', r.status === 8, `status=${r.status} ${r.stderr.slice(0, 200)}`);
      ok('报错说明是"没有正文"而不是超时', /没有找到/.test(r.stderr), r.stderr.slice(0, 300));
    }
  );

  // ---------------------------------------------------------- wait / watch
  section('wait：本来 idle 就立刻返回');
  await withMock(
    realishOptions({
      items: [
        item({ orderSeq: 1, type: 'message', role: 'assistant', content: { kind: 'markdown', text: '历史正文' } })
      ]
    }),
    async (mock, ep) => {
      const r = await runCli(['wait', '--json', '--session', REAL_EXT, '--timeout-ms', '5000', '--endpoint', ep], {
        timeout: 15000
      });
      const j = parseJson(r.stdout);
      ok('退出码 0', r.status === 0, r.stderr);
      ok('立刻返回（<3s）', r.ms < 3000, `ms=${r.ms}`);
      ok('status=idle', !!(j && j.status === 'idle'));
      ok('顺带给出最近一条正文', !!(j && j.reply === '历史正文'));
    }
  );

  section('wait：正在跑就等它跑完');
  await withMock(
    realishOptions({
      status: 'running',
      items: [item({ orderSeq: 5, type: 'message', role: 'user', content: { kind: 'markdown', text: '进行中的消息' } })]
    }),
    async (mock, ep) => {
      setTimeout(() => {
        mock.appendItem(item({ type: 'message', role: 'assistant', content: { kind: 'markdown', text: '跑完了的正文' } }));
        mock.state.status = 'idle';
      }, 400);
      const r = await runCli(['wait', '--json', '--session', REAL_EXT, '--timeout-ms', '8000', '--endpoint', ep], {
        timeout: 20000
      });
      const j = parseJson(r.stdout);
      ok('退出码 0', r.status === 0, r.stderr);
      ok('确实等了一会儿（>=400ms）', r.ms >= 400, `ms=${r.ms}`);
      ok('结束时 status=idle', !!(j && j.status === 'idle'));
      ok('拿到了这一轮的正文', !!(j && j.reply === '跑完了的正文'), j && JSON.stringify(j.reply));
      ok('标记了正文是本次等待期间产生的', !!(j && j.replyIsFromThisWait === true));
    }
  );

  section('watch：轮询能打出新条目（可选命令）');
  await withMock(realishOptions(), async (mock, ep) => {
    const child = spawn(process.execPath, [PEER, 'watch', '--session', REAL_EXT, '--interval-ms', '200', '--endpoint', ep], {
      cwd: PEER_DIR
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    await sleep(800);
    mock.appendItem(item({ type: 'message', role: 'assistant', content: { kind: 'markdown', text: 'watch 抓到的新条目' } }));
    await sleep(1200);
    child.kill();
    await sleep(300);
    ok('watch 把新条目打到 stdout', out.includes('watch 抓到的新条目'), `stdout=${out.slice(0, 200)} stderr=${err.slice(0, 200)}`);
    ok('watch 的启动说明走 stderr', err.includes('[info]'), err.slice(0, 200));
  });

  // ---------------------------------------------------------- 验收 8
  section('验收 8：零依赖');
  {
    const pkgPath = path.join(PEER_DIR, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = Object.keys(pkg.dependencies || {});
      ok('package.json 没有 dependencies', deps.length === 0, deps.join(','));
    } else {
      ok('没有 package.json（等价于零依赖）', true);
    }

    const builtin = new Set(require('module').builtinModules);
    const walk = (dir) =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : [p];
      });
    const jsFiles = walk(PEER_DIR).filter((f) => f.endsWith('.js'));
    const offenders = [];
    for (const file of jsFiles) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const target = m[1];
        if (target.startsWith('.') || target.startsWith('node:')) continue;
        if (!builtin.has(target)) offenders.push(`${path.relative(PEER_DIR, file)} → ${target}`);
      }
    }
    ok(
      `所有 require 都是 Node 内置或相对路径（扫了 ${jsFiles.length} 个文件）`,
      offenders.length === 0,
      offenders.join('; ')
    );
  }

  // ---------------------------------------------------------- 杂项
  section('杂项：--help / 未知命令 / 未知选项');
  {
    const r = await runCli(['--help']);
    ok('--help 退出码 0 且有用法', r.status === 0 && r.stdout.includes('用法'), r.stdout.slice(0, 200));
    const r2 = await runCli(['bogus-command']);
    ok('未知命令 → 退出码 2', r2.status === 2, `status=${r2.status}`);
    const r3 = await runCli(['status', '--nope', '1']);
    ok('未知选项 → 退出码 2', r3.status === 2, `status=${r3.status}`);
    const r4 = await runCli(['status', '--endpoint']);
    ok('选项缺值 → 退出码 2', r4.status === 2, `status=${r4.status}`);
  }

  console.log(`\n${'='.repeat(60)}`);
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

main().catch((err) => {
  console.error('测试自身崩了：', err);
  process.exit(1);
});
