import './App.css'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Home } from './pages/Home'
import { Editor } from './pages/Editor'
import { ViewerPage } from './pages/ViewerPage'
import { MediaInputPage } from './pages/MediaInputPage'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/editor/:projectId" element={<Editor />} />
        <Route path="/viewer/:projectId/:nodeId" element={<ViewerPage />} />
        <Route path="/media-input/:projectId" element={<MediaInputPage />} />
      </Routes>
    </BrowserRouter>
  )
}
