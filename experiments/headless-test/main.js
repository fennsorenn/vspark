// headless-test — does a HEADLESS Chromium surface escape the fullscreen-game
// throttle? This is the fallback experiment, only relevant if the offscreen
// Electron viewer (vspark-viewer) turns out to be throttled.
//
// It launches headless Microsoft Edge (always present on Windows, so no bundled
// Chromium), renders a rotating cube, and measures real produced frames/sec via
// the DevTools Protocol screencast while you run a game fullscreen. Headless has
// no on-screen window for Windows to deprioritize, so if it holds ~60 fps the
// headless path escapes the throttle.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const puppeteer = require('puppeteer-core');

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 520,
    height: 380,
    title: 'headless throttle test',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  win.loadFile('result.html');
  win.on('closed', () => {
    win = null;
  });
}

function status(msg) {
  if (win && !win.isDestroyed()) win.webContents.send('status', msg);
  console.log('[test]', msg);
}

async function runTest() {
  status('Launching headless Microsoft Edge…');
  let browser;
  try {
    browser = await puppeteer.launch({
      channel: 'msedge',
      headless: true,
      args: [
        '--enable-gpu',
        '--ignore-gpu-blocklist',
        '--disable-features=CalculateNativeWinOcclusion',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--disable-background-timer-throttling',
        '--disable-gpu-vsync',
        '--disable-frame-rate-limit',
        '--window-size=1280,720',
      ],
    });
  } catch (e) {
    status('Could not launch Edge: ' + e.message + '\nIs Microsoft Edge installed?');
    return;
  }

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    const cubeUrl = 'file://' + path.join(__dirname, 'cube.html').replace(/\\/g, '/');
    await page.goto(cubeUrl, { waitUntil: 'load' });

    const client = await page.target().createCDPSession();
    let frames = 0;
    client.on('Page.screencastFrame', async ({ sessionId }) => {
      frames += 1;
      try {
        await client.send('Page.screencastFrameAck', { sessionId });
      } catch {
        /* ignore */
      }
    });

    status('Measuring for 10 seconds… start your game FULLSCREEN now.');
    await client.send('Page.startScreencast', { format: 'jpeg', quality: 40, everyNthFrame: 1 });
    await new Promise((r) => setTimeout(r, 10000));
    await client.send('Page.stopScreencast').catch(() => {});

    const fps = frames / 10;
    const verdict =
      fps >= 45
        ? 'HOLDS — headless escapes the throttle. Owning the frame clock works.'
        : 'DROPPED — headless is throttled too; only a native (non-Chromium) renderer escapes.';
    status(`Result: ${fps.toFixed(1)} fps over 10s.\n${verdict}`);
  } catch (e) {
    status('Test error: ' + e.message);
  } finally {
    await browser.close().catch(() => {});
  }
}

app.whenReady().then(createWindow);
ipcMain.on('run', () => {
  runTest();
});
app.on('window-all-closed', () => app.quit());
