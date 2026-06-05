// spout-cube-test — Electron offscreen renderer + (optional) Spout output.
//
// Purpose: answer two questions on the real Windows machine:
//   1) Does an OFFSCREEN Chromium surface keep producing frames when a game
//      grabs the foreground in fullscreen? (the throttle test)
//   2) Can we push those frames to Spout GPU-direct? (the capture path)
//
// The FPS test works immediately. The Spout output only activates once the
// native addon `electron_spout.node` is present next to this file — see
// README.md. Without it, the app still runs and logs produced-frame FPS.

const { app, BrowserWindow } = require('electron');

// --- Defensive anti-throttle switches --------------------------------------
// Harmless for offscreen rendering; included so this also behaves if you ever
// flip the window visible. These are the flags a plain Chrome tab can't get.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-gpu-vsync');
app.commandLine.appendSwitch('disable-frame-rate-limit');

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 60;
const SENDER_NAME = 'vspark-cube-test'; // this is the name you'll pick in OBS

// --- Try to load the Spout native addon (built separately) -----------------
let spout = null;
try {
  // eslint-disable-next-line import/no-unresolved, global-require
  const { SpoutOutput } = require('./electron_spout.node');
  spout = new SpoutOutput(SENDER_NAME);
  console.log(`[spout] sender "${SENDER_NAME}" ready (GPU-direct).`);
} catch (e) {
  console.warn('[spout] electron_spout.node not loaded — running WITHOUT Spout.');
  console.warn('[spout] The FPS / throttle test still works. See README.md to enable Spout.');
  console.warn(`[spout] reason: ${e.message}`);
}

// --- Frame counter ---------------------------------------------------------
let frames = 0;
setInterval(() => {
  console.log(`[fps] ${frames} produced frames/s`);
  frames = 0;
}, 1000);

function createWindow() {
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false, // offscreen: no visible window at all
    webPreferences: {
      offscreen: true,
      // Shared GPU texture is only needed for the GPU-direct Spout path.
      // Without the addon we use the (slower) bitmap path so the FPS test
      // still runs on machines where shared textures misbehave.
      offscreenUseSharedTexture: !!spout,
    },
  });

  win.webContents.setFrameRate(FPS);
  win.loadFile('index.html');

  // The exact 'paint' signature varies across Electron versions: some pass the
  // shared texture as a 4th arg, others expose it as `event.texture`. Handle
  // both so this survives Electron upgrades.
  win.webContents.on('paint', (event, _dirty, image, textureArg) => {
    frames += 1;
    if (!spout) return;

    const sharedTexture = textureArg || (event && event.texture) || null;
    try {
      if (sharedTexture) {
        spout.updateTexture(sharedTexture);
      } else if (image && !image.isEmpty()) {
        spout.updateFrame(image.getBitmap(), image.getSize());
      }
    } catch (e) {
      console.error('[spout] update failed:', e.message);
    } finally {
      // Shared textures must be released back to Electron or you leak GPU mem.
      if (sharedTexture && typeof sharedTexture.release === 'function') {
        sharedTexture.release();
      }
    }
  });

  return win;
}

app.whenReady().then(() => {
  createWindow();
  console.log(`[run] offscreen ${WIDTH}x${HEIGHT} @ ${FPS}fps target.`);
  console.log('[run] Watch the [fps] lines. Then start your game FULLSCREEN on');
  console.log('[run] the other monitor and watch whether [fps] holds at ~60.');
});

app.on('window-all-closed', () => app.quit());
