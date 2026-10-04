/*
 * DSH Pair -- desktop shell (Electron)
 * Author: Xiao Hei
 *
 * It does only three things:
 *   1. make sure the local dsh-pair backend is running (start it if not)
 *   2. open a native window on http://127.0.0.1:<port>/
 *   3. shut the backend child down cleanly when the window closes
 *
 * Key design: the backend is started with ELECTRON_RUN_AS_NODE=1 through
 * process.execPath, i.e. this very exe acts as Node. That is why the user does
 * NOT need Node installed, and why the folder can be copied to another machine.
 */

'use strict'

const { app, BrowserWindow, shell, dialog } = require('electron')
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')

const HOST = '127.0.0.1'
const PORT = Number(process.env.PORT || 8787)

let serverChild = null
let win = null
let quitting = false

/* ------------------------------------------------------------ locate backend */

function serverDir {
  // 1) explicit override
  if (process.env.DSH_PAIR_APP && fs.existsSync(path.join(process.env.DSH_PAIR_APP, 'server.js'))) {
    return process.env.DSH_PAIR_APP
  }
  // 2) packaged: resources/pair/app  (peer/ sits next to it, both are needed)
  const packaged = path.join(process.resourcesPath || '', 'pair', 'app')
  if (fs.existsSync(path.join(packaged, 'server.js'))) return packaged
  // 3) development: the source tree
  const dev = '%REPO%\\app'
  if (fs.existsSync(path.join(dev, 'server.js'))) return dev

  return null
}

/* ------------------------------------------------------------ health probe */

// Health probe. Returns the parsed payload when the port is OUR backend,
// otherwise null. Checking appDir matters: if some unrelated program happens to
// hold the port and also answers 200, we must not treat it as ours and open a
// window onto a stranger. (Raised by Xiao Bai during review.)
function probeOurs(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: HOST, port: PORT, path: '/api/health', timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) { res.resume; resolve(null); return }
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { body += c })
        res.on('end',  => {
          try {
            const j = JSON.parse(body)
            resolve(j && j.ok === true && typeof j.appDir === 'string' ? j : null)
          } catch { resolve(null) }
        })
      }
    )
    req.on('timeout',  => { req.destroy; resolve(null) })
    req.on('error',  => resolve(null))
  })
}

const probe = async (timeoutMs) => (await probeOurs(timeoutMs)) !== null

async function waitUp(tries = 40, gapMs = 400) {
  for (let i = 0; i < tries; i++) {
    if (await probe) return true
    await new Promise((r) => setTimeout(r, gapMs))
  }
  return false
}

/* ------------------------------------------------------------ start backend */

const RESTART_BASE_MS = 2000
const RESTART_MAX_MS = 60000
let restartCount = 0

// Start the backend and keep it alive. If it dies on its own (hard-killed, OOM,
// crash) we bring it back with exponential backoff, so the window does not end
// up talking to nothing.
//
// Note: do NOT delegate this to app/bin/watchdog.js. On Windows Electron's
// child.kill is a hard terminate, so the watchdog never sees a SIGTERM and its
// own server child gets orphaned while still holding the port. (Xiao Bai's
// review point.)
function startServer {
  const dir = serverDir
  if (!dir) throw new Error('cannot find the dsh-pair backend (server.js)')

  serverChild = spawn(
    process.execPath,                                   // this very exe
    [path.join(dir, 'server.js'), '--port', String(PORT)],
    {
      cwd: dir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, // run the exe as Node
      stdio: 'ignore',
      windowsHide: true,
    }
  )

  const child = serverChild
  child.on('exit',  => {
    if (serverChild === child) serverChild = null
    if (quitting) return
    const delay = Math.min(RESTART_BASE_MS * Math.pow(2, restartCount), RESTART_MAX_MS)
    restartCount += 1
    setTimeout( => {
      if (quitting) return
      try { startServer } catch { /* next exit will schedule another try */ }
    }, delay)
  })

  return dir
}

async function ensureServer {
  if (await probe) { restartCount = 0; return { spawned: false } }
  const dir = startServer
  if (!(await waitUp)) throw new Error(`the backend did not come up on port ${PORT}`)
  return { spawned: true, dir }
}

/* ------------------------------------------------------------ window */

function openWindow {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0f16',
    title: 'DSH Pair',
    // 窗口/任务栏图标。Electron 的窗口图标不会自动用网页 favicon，
    // 必须在 BrowserWindow 里指定（否则一直是 electron.exe 的默认图标）。
    icon: path.join(__dirname, 'icon.ico'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.once('ready-to-show',  => win.show)
  win.loadURL(`http://${HOST}:${PORT}/`)

  // external links go to the system browser, never inside the app window
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://${HOST}:${PORT}`)) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  win.on('closed',  => { win = null })
}

/* ------------------------------------------------------------ lifecycle */

function shutdownServer {
  quitting = true
  if (!serverChild) return
  try { serverChild.kill } catch { /* ignore */ }
  serverChild = null
}

// single instance: a second launch just focuses the existing window
if (!app.requestSingleInstanceLock) {
  app.quit
} else {
  app.on('second-instance',  => {
    if (win) { if (win.isMinimized) win.restore; win.focus }
  })

  app.whenReady.then(async  => {
    try {
      await ensureServer
    } catch (err) {
      dialog.showErrorBox('DSH Pair failed to start', String(err && err.message ? err.message : err))
      app.quit
      return
    }
    openWindow

    app.on('activate',  => { if (BrowserWindow.getAllWindows.length === 0) openWindow })
  })

  app.on('window-all-closed',  => { app.quit })
  app.on('before-quit', shutdownServer)
  process.on('exit', shutdownServer)
}