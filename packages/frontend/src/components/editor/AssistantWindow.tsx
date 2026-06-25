import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAssistantStore } from '../../store/assistantStore';
import {
  sendAssistantMessage,
  sendAssistantReset,
} from '../../hooks/useWsSync';
import { HelpButton } from '../../help/HelpButton';

/**
 * Floating chat window for the in-app Assistant. Mirrors HelpWindow's
 * draggable shell. Sends user turns to the backend agent over WS and renders
 * the streamed transcript (assistant text + tool-call activity).
 */
export function AssistantWindow() {
  const { t } = useTranslation('assistant');
  const open = useAssistantStore((s) => s.open);
  const streaming = useAssistantStore((s) => s.streaming);
  const entries = useAssistantStore((s) => s.entries);
  const available = useAssistantStore((s) => s.available);
  const closeAssistant = useAssistantStore((s) => s.closeAssistant);
  const setAvailable = useAssistantStore((s) => s.setAvailable);
  const clear = useAssistantStore((s) => s.clear);
  const pushUser = useAssistantStore((s) => s.pushUser);

  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [placed, setPlaced] = useState(false);
  const [input, setInput] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);

  // Probe whether an LLM endpoint is configured the first time we open.
  useEffect(() => {
    if (!open || available !== null) return;
    fetch('/api/config')
      .then((r) => r.json())
      .then((j) =>
        setAvailable(Boolean(j?.data?.assistant?.enabled && j?.data?.assistant?.baseUrl))
      )
      .catch(() => setAvailable(false));
  }, [open, available, setAvailable]);

  // Initial placement: bottom-right.
  useEffect(() => {
    if (open && !placed) {
      setPos({ x: window.innerWidth - 440, y: 80 });
      setPlaced(true);
    }
  }, [open, placed]);

  // Auto-scroll to the newest entry.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [entries]);

  if (!open) return null;

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const dx = e.clientX - pos.x;
    const dy = e.clientY - pos.y;
    const onMove = (ev: PointerEvent) =>
      setPos({
        x: Math.min(Math.max(0, ev.clientX - dx), window.innerWidth - 120),
        y: Math.min(Math.max(0, ev.clientY - dy), window.innerHeight - 40),
      });
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const submit = () => {
    const text = input.trim();
    if (!text || streaming) return;
    pushUser(text);
    sendAssistantMessage(text);
    setInput('');
  };

  return (
    <div
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        width: 420,
        height: 520,
        background: '#1b1b1b',
        border: '1px solid #3a3a3a',
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'column',
        zIndex: 9400,
        boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
      }}
    >
      {/* Header */}
      <div
        onPointerDown={startDrag}
        style={{
          cursor: 'move',
          touchAction: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          borderBottom: '1px solid #3a3a3a',
          background: '#222',
          borderTopLeftRadius: 8,
          borderTopRightRadius: 8,
        }}
      >
        <span style={{ fontSize: 13, color: '#60a5fa' }}>🤖 {t('title')}</span>
        <div style={{ flex: 1 }} />
        <HelpButton topic="assistant" anchor="how-to-use" tip={t('helpTip')} size={15} />
        <button
          className="vs-assistant-clear"
          onClick={clear}
          title={t('clear')}
          style={headerBtn}
        >
          ⟲
        </button>
        <button
          className="vs-assistant-close"
          onClick={closeAssistant}
          title={t('close')}
          style={headerBtn}
        >
          ×
        </button>
      </div>

      {/* Transcript */}
      <div
        ref={listRef}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 10 }}
      >
        {available === false && (
          <div style={{ ...bubble, background: '#3a2a1a', color: '#fbbf24' }}>
            {t('notConfigured')}
          </div>
        )}
        {entries.length === 0 && available !== false && (
          <div style={{ color: '#777', fontSize: 12, padding: 8 }}>
            {t('emptyHint')}
          </div>
        )}
        {entries.map((e) => {
          if (e.kind === 'user')
            return (
              <div key={e.id} style={{ ...bubble, ...userBubble }}>
                {e.text}
              </div>
            );
          if (e.kind === 'assistant')
            return (
              <div key={e.id} style={{ ...bubble, ...asstBubble }}>
                {e.text}
              </div>
            );
          if (e.kind === 'error')
            return (
              <div key={e.id} style={{ ...bubble, background: '#3a1a1a', color: '#f87171' }}>
                {e.text}
              </div>
            );
          // tool entry
          return (
            <div key={e.id} style={toolRow}>
              <span style={{ color: e.ok === false ? '#f87171' : '#4ade80' }}>
                {e.ok === undefined ? '…' : e.ok ? '✓' : '✗'}
              </span>
              <code style={{ color: '#9aa', fontSize: 11 }}>{e.toolName}</code>
            </div>
          );
        })}
        {streaming && (
          <div style={{ color: '#777', fontSize: 12, padding: 6 }}>
            {t('working')}
          </div>
        )}
      </div>

      {/* Input */}
      <div
        style={{
          display: 'flex',
          gap: 6,
          padding: 8,
          borderTop: '1px solid #3a3a3a',
        }}
      >
        <textarea
          className="vs-assistant-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={t('placeholder')}
          rows={2}
          style={{
            flex: 1,
            resize: 'none',
            background: '#111',
            color: '#ddd',
            border: '1px solid #333',
            borderRadius: 5,
            padding: '6px 8px',
            fontSize: 12,
            fontFamily: 'inherit',
          }}
        />
        <button
          className="vs-assistant-send"
          onClick={submit}
          disabled={streaming || !input.trim()}
          style={{
            background: streaming || !input.trim() ? '#2a2a2a' : '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: 5,
            padding: '0 14px',
            cursor: streaming || !input.trim() ? 'default' : 'pointer',
            fontSize: 12,
          }}
        >
          {t('send')}
        </button>
      </div>
      <button
        className="vs-assistant-reset"
        onClick={() => {
          sendAssistantReset();
          clear();
        }}
        style={{
          background: 'transparent',
          color: '#666',
          border: 'none',
          fontSize: 10,
          padding: '0 0 6px',
          cursor: 'pointer',
        }}
      >
        {t('resetConversation')}
      </button>
    </div>
  );
}

const headerBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#aaa',
  cursor: 'pointer',
  fontSize: 14,
  padding: '0 4px',
};
const bubble: React.CSSProperties = {
  borderRadius: 8,
  padding: '7px 10px',
  margin: '4px 0',
  fontSize: 12.5,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};
const userBubble: React.CSSProperties = {
  background: '#1e3a5f',
  color: '#dbeafe',
  marginLeft: 40,
};
const asstBubble: React.CSSProperties = {
  background: '#262626',
  color: '#e5e5e5',
  marginRight: 24,
};
const toolRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '2px 6px',
  margin: '2px 0',
};
