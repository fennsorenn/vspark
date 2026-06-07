import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import './FileDrop.css';

interface FileDropProps {
  onVrm: (path: string) => void;
  onAnim: (path: string) => void;
}

export function FileDrop({ onVrm, onAnim }: FileDropProps) {
  const { t } = useTranslation('media');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    files.forEach((file) => processFile(file));
  }, []);

  const handleFiles = useCallback(() => {
    if (inputRef.current?.files) {
      Array.from(inputRef.current.files).forEach(processFile);
    }
  }, []);

  function processFile(file: File) {
    const ext = file.name.split('.').pop()?.toLowerCase();
    const reader = new FileReader();
    if (ext === 'vrm' || ext === 'glb') {
      reader.onload = () => {
        const blob = new Blob([reader.result as ArrayBuffer], {
          type: 'application/octet-stream',
        });
        const url = URL.createObjectURL(blob);
        if (ext === 'vrm') onVrm(url);
        else onAnim(url);
      };
      reader.readAsArrayBuffer(file);
    }
  }

  return (
    <div
      className="file-drop"
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
    >
      <p>{t('fileDrop.dropPrompt')}</p>
      <input
        ref={inputRef}
        type="file"
        accept=".vrm,.glb"
        multiple
        onChange={handleFiles}
        style={{ display: 'none' }}
      />
      <button onClick={() => inputRef.current?.click()}>{t('fileDrop.browseBtn')}</button>
    </div>
  );
}
