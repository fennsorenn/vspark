import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './i18n';
// Registers the dev-only `dev_facecal()` console command (face heuristic calibration).
import './components/FaceCalibrationWindow';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
