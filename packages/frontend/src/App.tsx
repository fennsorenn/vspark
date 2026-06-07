import './App.css';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Home } from './pages/Home';
import { Editor } from './pages/Editor';
import { ViewerPage } from './pages/ViewerPage';
import { MediaInputPage } from './pages/MediaInputPage';
import { DocsPage } from './pages/DocsPage';
import { DialogProvider } from './components/DialogProvider';

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
      </DialogProvider>
    </BrowserRouter>
  );
}
