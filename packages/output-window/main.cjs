// Electron main process: one hidden-from-taskbar, off-screen, transparent window
// per compose scene that has "OBS window capture" enabled. OBS captures them with
// Window Capture, which (unlike Browser Sources) is not starved by a fullscreen game.
//
// Protocol (from the vspark backend, over the Node IPC channel — stdin reads EOF
// immediately in Electron's main process on Windows):
//   { "windows": [{ "id", "url", "width", "height", "title" }] }
// Each message is the full desired set; windows are created/updated/closed to match.
// When the channel disconnects (backend gone) the process exits, so it never
// outlives the server.
const { app, BrowserWindow } = require('electron');

// Keep rendering at full rate while covered by a game, unfocused or off-screen.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

// Windows live far outside every monitor. Windows' capture API still delivers
// their frames; it cannot capture *minimized* windows, so they are never minimized.
const PARK_X = 20000;
const PARK_Y = 20000;
const PARK_STEP = 2400;

/** @type {Map<string, { win: BrowserWindow, spec: any, slot: number }>} */
const windows = new Map();

const log = (...a) => process.stdout.write(`[output-window] ${a.join(' ')}\n`);

function freeSlot() {
  const used = new Set([...windows.values()].map((w) => w.slot));
  let s = 0;
  while (used.has(s)) s++;
  return s;
}

async function place(entry) {
  const { win, spec, slot } = entry;
  // Size while on a monitor: sizing a window that sits off every monitor gets
  // mis-measured (+16/+8 px). It is still hidden here, so nothing flashes.
  win.setPosition(0, 0);
  win.setContentSize(spec.width, spec.height);
  win.setPosition(PARK_X, PARK_Y + slot * PARK_STEP);
  win.setContentSize(spec.width, spec.height);
}

async function create(spec) {
  const win = new BrowserWindow({
    x: 0,
    y: 0,
    width: spec.width,
    height: spec.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    skipTaskbar: true,
    enableLargerThanScreen: true,
    focusable: false,
    title: spec.title,
    webPreferences: { backgroundThrottling: false },
  });
  // OBS finds the window by title; keep ours instead of the page's <title>.
  win.on('page-title-updated', (e) => e.preventDefault());
  const entry = { win, spec, slot: freeSlot() };
  windows.set(spec.id, entry);
  await place(entry);
  win.loadURL(spec.url).catch((e) => log('load failed', spec.id, e.message));
  win.showInactive();
  log('opened', spec.id, `${spec.width}x${spec.height}`, JSON.stringify(spec.title));
}

async function update(entry, spec) {
  const prev = entry.spec;
  entry.spec = spec;
  if (prev.title !== spec.title) entry.win.setTitle(spec.title);
  if (prev.width !== spec.width || prev.height !== spec.height) {
    entry.win.hide();
    await place(entry);
    entry.win.showInactive();
  }
  if (prev.url !== spec.url) entry.win.loadURL(spec.url).catch(() => {});
}

async function sync(specs) {
  const wanted = new Map(specs.map((s) => [s.id, s]));
  for (const [id, entry] of windows) {
    if (!wanted.has(id)) {
      entry.win.destroy();
      windows.delete(id);
      log('closed', id);
    }
  }
  for (const spec of specs) {
    const entry = windows.get(spec.id);
    if (entry) await update(entry, spec);
    else await create(spec);
  }
}

app.on('window-all-closed', () => {
  // Stay alive with zero windows; the backend decides when we exit.
});

app.whenReady().then(() => {
  if (typeof process.send !== 'function') {
    log('no IPC channel — must be started by the vspark backend');
    app.quit();
    return;
  }
  let queue = Promise.resolve();
  process.on('message', (msg) => {
    if (!msg || !Array.isArray(msg.windows)) return;
    queue = queue.then(() => sync(msg.windows)).catch((e) => log('sync failed', e.message));
  });
  process.on('disconnect', () => app.quit());
  log('ready');
});
