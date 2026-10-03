import './App.css';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Home } from './pages/Home';
import { Editor } from './pages/Editor';
import { ViewerPage } from './pages/ViewerPage';
import { MediaInputPage } from './pages/MediaInputPage';
import { DocsPage } from './pages/DocsPage';
import { DialogProvider } from './components/DialogProvider';
import { Toasts } from './components/Toasts';

export default function App() {
  return (
    <BrowserRouter>
      <DialogProvider>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/editor/:projectId" element={<Editor />} />
          <Route
            path="/viewer/:projectId/compose/:composeSceneId"
            element={<ViewerPage />}
          />
          <Route path="/viewer/:projectId/:nodeId" element={<ViewerPage />} />
          <Route path="/media-input/:projectId" element={<MediaInputPage />} />
          <Route path="/docs" element={<DocsPage />} />
          <Route path="/docs/:topic" element={<DocsPage />} />
        </Routes>
        {/* One stack for every route — a refused write can land on any of
            them, and the notice must not be scoped to the editor. */}
        <Toasts />
      </DialogProvider>
    </BrowserRouter>
  );
}
