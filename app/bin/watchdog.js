#!/usr/bin/env node
/*
 * bin/watchdog.js —— 后端看门狗：让"后端悄悄没了"这件事不再发生
 * ---------------------------------------------------------------
 * 背景：这个环境里后端被硬杀过好几次（日志里没有 SIGTERM/exiting 记录 = 外部 TerminateProcess）。
 * 用户只会看到界面连不上，而且没有任何自动恢复手段。看门狗负责：
 *   - 由它来拉起 server.js（子进程），自己写 watchdog-<port>.pid
 *   - 子进程退出就按退避重启（2s → 5s → 15s → 最长 60s）
 *   - 短时间连续失败超过阈值就放弃并大声记日志（避免无限崩溃循环）
 *   - 自己收到 SIGTERM/SIGINT、或**自己的 pid 文件被删掉**（stop.cmd 的停止协议）就干净退出
 *
 * 为什么用"pid 文件被删"当停止信号：Windows 上从别的进程 kill 过来是硬终止，
 * 目标进程的 handler 根本不会跑。所以 stop.js 的协议是：**先删看门狗的 pid 文件，再杀它**，
 * 杀完再按 pid 文件/健康校验停掉真正的 server。
 *
 * 日志：logs\watchdog-<port>.log（server 自己的日志在 logs\server-<port>.log）
 * 输出一律 ASCII：Windows 控制台默认代码页不是 UTF-8。
 */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const APP_DIR = path.join(__dirname, '..');
const LOG_DIR = path.join(APP_DIR, 'logs');
const PID_FILE = (port) => path.join(APP_DIR, `watchdog-${port}.pid`);

function parseArgv(argv) {
  const out = { port: 8787 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') out.port = Number(argv[++i]) || out.port;
  }
  return out;
}

const ARGS = parseArgv(process.argv.slice(2));
const PORT = ARGS.port;
const LOG_FILE = path.join(LOG_DIR, `watchdog-${PORT}.log`);
const SERVER = path.join(APP_DIR, 'server.js');
const RETRY_STEPS_MS = [2000, 5000, 15000, 30000, 60000];
const GIVE_UP_AFTER = 6; // 短时间连续失败这么多次就不再硬撑
const HEALTH_INTERVAL_MS = 30000;

let child = null;
let stopping = false;
let failures = 0;
let restarts = 0;

function logLine(level, message) {
  const line = `${new Date.toISOString} [${level}] ${message}`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (err) {
    /* 忽略 */
  }
  if (level === 'ERROR') console.error(line);
  else console.log(line);
}

function writePidFile {
  try {
    fs.writeFileSync(
      PID_FILE(PORT),
      JSON.stringify({ pid: process.pid, port: PORT, childPid: child ? child.pid : null, appDir: APP_DIR, startedAt: new Date.toISOString }),
      'utf8'
    );
  } catch (err) {
    logLine('ERROR', `cannot write pid file: ${err.message}`);
  }
}

function removePidFile {
  try {
    const cur = JSON.parse(fs.readFileSync(PID_FILE(PORT), 'utf8'));
    if (cur && cur.pid === process.pid) fs.unlinkSync(PID_FILE(PORT));
  } catch (err) {
    /* 不在就算了 */
  }
}

/** 我方 server 是否已经在跑（避免重复拉起撞端口） */
function probeHealth(timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout: timeoutMs || 3000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        body += d;
      });
      res.on('end',  => {
        try {
          const json = JSON.parse(body);
          resolve(json && json.ok ? json : null);
        } catch (err) {
          resolve(null);
        }
      });
    });
    req.on('timeout',  => {
      req.destroy;
      resolve(null);
    });
    req.on('error',  => resolve(null));
  });
}

function startServer {
  logLine('INFO', `starting server: node ${SERVER} --port ${PORT}`);
  child = spawn(process.execPath, [SERVER, '--port', String(PORT)], {
    cwd: APP_DIR,
    stdio: 'ignore',
    detached: false
  });
  writePidFile;
  child.on('exit', (code, signal) => {
    const pid = child ? child.pid : null;
    child = null;
    if (stopping) {
      logLine('INFO', `server pid=${pid} exited (code=${code} signal=${signal}) while stopping - fine`);
      finish(0);
      return;
    }
    logLine('ERROR', `server pid=${pid} exited unexpectedly (code=${code} signal=${signal}) - will restart`);
    scheduleRestart;
  });
}

function scheduleRestart {
  failures++;
  restarts++;
  if (failures > GIVE_UP_AFTER) {
    logLine('ERROR', `gave up after ${failures} consecutive failures - not restarting anymore. Check logs/server-${PORT}.log`);
    removePidFile;
    finish(1);
    return;
  }
  const wait = RETRY_STEPS_MS[Math.min(failures - 1, RETRY_STEPS_MS.length - 1)];
  logLine('WARN', `restart #${restarts} in ${wait}ms`);
  setTimeout( => {
    if (stopping) return;
    startServer;
  }, wait);
}

function finish(code) {
  removePidFile;
  try {
    logLine('INFO', `watchdog exiting code=${code} restarts=${restarts} uptime=${Math.round(process.uptime)}s`);
  } catch (err) {
    /* 忽略 */
  }
  process.exit(code);
}

function stopEverything(reason) {
  if (stopping) return;
  stopping = true;
  logLine('INFO', `stopping (${reason})`);
  if (child && child.pid) {
    try {
      process.kill(child.pid, 'SIGTERM');
    } catch (err) {
      logLine('WARN', `could not signal child: ${err.message}`);
    }
  }
  // 子进程不退就强杀，然后收工
  setTimeout( => {
    if (child && child.pid) {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch (err) {
        /* 忽略 */
      }
    }
    removePidFile;
    finish(0);
  }, 1500);
}

process.on('SIGINT',  => stopEverything('SIGINT'));
process.on('SIGTERM',  => stopEverything('SIGTERM'));
process.on('uncaughtException', (err) => {
  logLine('ERROR', `uncaughtException in watchdog: ${err && err.stack ? err.stack : err}`);
  stopEverything('uncaughtException');
});

(async  => {
  logLine('INFO', `watchdog start pid=${process.pid} port=${PORT} appDir=${APP_DIR} node=${process.version}`);

  // 停止协议：自己的 pid 文件被删掉 = 有人（stop.cmd）要求我们停
  // 硬杀之前会先删文件，所以这个检查必须比任何杀进程的方式都可靠。
  setInterval( => {
    if (stopping) return;
    if (!fs.existsSync(PID_FILE(PORT))) {
      stopEverything('pid file removed (stop requested)');
    }
  }, 1000).unref;

  const existing = await probeHealth(3000);
  if (existing && existing.appDir && path.resolve(existing.appDir) === path.resolve(APP_DIR)) {
    logLine('WARN', `a server of ours is already listening on ${PORT} (pid ${existing.pid}) - adopting it, not starting another`);
    writePidFile;
    // 采用模式：只守着端口，等它消失后再自己拉起
    setInterval(async  => {
      if (stopping) return;
      const h = await probeHealth(3000);
      if (!h) {
        logLine('WARN', 'adopted server is gone - taking over and starting our own');
        startServer;
        return;
      }
      failures = 0;
    }, HEALTH_INTERVAL_MS);
    return;
  }

  startServer;

  // 周期性健康确认：只记日志（进程活着但无响应时便于事后判断），不主动杀
  setInterval(async  => {
    if (stopping || !child) return;
    const h = await probeHealth(3000);
    if (h && h.pid === child.pid) {
      failures = 0;
      return;
    }
    logLine('WARN', `health probe did not answer as our child (pid ${child.pid}) - still watching`);
  }, HEALTH_INTERVAL_MS).unref;
}).catch((err) => {
  logLine('ERROR', `watchdog failed to start: ${err && err.message ? err.message : err}`);
  finish(1);
});
