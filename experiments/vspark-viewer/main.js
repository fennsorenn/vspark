// vspark-viewer — standalone Electron launcher + viewer for vspark.
//
// It loads vspark's real viewer route (full parity: compose layers, effects,
// any scene) and can render it two ways:
//   • Windowed     — a normal visible viewer window (everyday use).
//   • Offscreen+FPS — renders offscreen and reports produced frames/sec back to
//                     the launcher. This is the throttle test: start a game
//                     fullscreen and watch whether the FPS holds.
//
// v2 will add GPU-direct Spout output from the offscreen path. See README.

const { app, BrowserWindow, ipcMain } = require('electron');

// Anti-throttle switches a plain Chrome tab can't get (harmless for offscreen).
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-gpu-vsync');
app.commandLine.appendSwitch('disable-frame-rate-limit');

let launcher = null;
let viewer = null;
let fpsTimer = null;
let paintCount = 0;

function createLauncher() {
  launcher = new BrowserWindow({
    width: 540,
    height: 620,
    title: 'vspark viewer launcher',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  launcher.loadFile('launcher.html');
  launcher.on('closed', () => {
    launcher = null;
  });
}

function closeViewer() {
  if (fpsTimer) {
    clearInterval(fpsTimer);
    fpsTimer = null;
  }
  if (viewer && !viewer.isDestroyed()) viewer.destroy();
  viewer = null;
}

// API calls go through the main process (Node fetch, no CORS headaches).
ipcMain.handle('api:projects', async (_e, base) => {
  const r = await fetch(`${base}/api/projects`);
  return r.json();
});
ipcMain.handle('api:scenes', async (_e, base, pid) => {
  const r = await fetch(`${base}/api/projects/${pid}/scenes`);
  return r.json();
});

ipcMain.on('open-viewer', (_e, { url, mode, width, height }) => {
  closeViewer();
  const offscreen = mode === 'offscreen';
  viewer = new BrowserWindow({
    width: width || 1280,
    height: height || 720,
    show: !offscreen,
    title: 'vspark viewer',
    backgroundColor: '#000000',
    webPreferences: { offscreen },
  });

  if (offscreen) {
    viewer.webContents.setFrameRate(60);
    paintCount = 0;
    viewer.webContents.on('paint', () => {
      paintCount += 1;
    });
    fpsTimer = setInterval(() => {
      if (launcher && !launcher.isDestroyed()) launcher.webContents.send('fps', paintCount);
      paintCount = 0;
    }, 1000);
  }

  viewer.loadURL(url);
  viewer.on('closed', () => {
    viewer = null;
  });
});

ipcMain.on('close-viewer', () => closeViewer());

app.whenReady().then(createLauncher);
app.on('window-all-closed', () => app.quit());
