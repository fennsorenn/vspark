import React from 'react';
import ReactDOM from 'react-dom/client';
import { MeshProvider } from '@vspark/mesh-react';
import App from './App';
import i18n from './i18n';
import { initMeshPeer } from './mesh/peer';
import { startPreviewSmoothing } from './previewSmoother';
// Registers the dev-only `dev_facecal()` console command (face heuristic calibration).
import './components/FaceCalibrationWindow';

const root = ReactDOM.createRoot(document.getElementById('root')!);

/** The mesh peer is the app's store, so it exists before the first render:
 *  components reach collections synchronously instead of handling a window
 *  where there is none. Creating it only needs the server's identity; until
 *  that answers, say so and keep trying. */
async function boot(): Promise<void> {
  for (;;) {
    try {
      const { peer } = await initMeshPeer();
      startPreviewSmoothing(peer);
      root.render(
        <React.StrictMode>
          <MeshProvider peer={peer}>
            <App />
          </MeshProvider>
        </React.StrictMode>
      );
      return;
    } catch {
      root.render(
        <p style={{ fontFamily: 'sans-serif', padding: 24 }}>
          {i18n.t('common:connecting')}
        </p>
      );
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

void boot();
