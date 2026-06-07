import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useEscapeKey } from '../hooks/useEscapeKey';

/**
 * App-wide styled replacements for the jarring native `window.confirm` /
 * `window.prompt`, exposed as promise-returning hooks so call sites read almost
 * exactly like the blocking originals:
 *
 *   if (await confirm({ message })) { … }
 *   const name = await prompt({ message, defaultValue });
 *
 * A single dialog is shown at a time; the provider is mounted once near the app
 * root so every page/editor surface shares it.
 */

interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as a destructive action. */
  danger?: boolean;
}

interface PromptOptions {
  title?: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

type DialogState =
  | { kind: 'confirm'; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: 'prompt'; opts: PromptOptions; resolve: (v: string | null) => void }
  | null;

interface DialogApi {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  prompt: (opts: PromptOptions) => Promise<string | null>;
}

const DialogContext = createContext<DialogApi | null>(null);

function useDialogApi(): DialogApi {
  const ctx = useContext(DialogContext);
  if (!ctx)
    throw new Error('useConfirm/usePrompt must be used within a DialogProvider');
  return ctx;
}

export function useConfirm() {
  return useDialogApi().confirm;
}

export function usePrompt() {
  return useDialogApi().prompt;
}

export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<DialogState>(null);

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) =>
        setState({ kind: 'confirm', opts, resolve })
      ),
    []
  );
  const prompt = useCallback(
    (opts: PromptOptions) =>
      new Promise<string | null>((resolve) =>
        setState({ kind: 'prompt', opts, resolve })
      ),
    []
  );

  const close = useCallback(
    (value: boolean | string | null) => {
      setState((cur) => {
        cur?.resolve(value as never);
        return null;
      });
    },
    []
  );

  return (
    <DialogContext.Provider value={{ confirm, prompt }}>
      {children}
      {state && <DialogHost state={state} onClose={close} />}
    </DialogContext.Provider>
  );
}

function DialogHost({
  state,
  onClose,
}: {
  state: NonNullable<DialogState>;
  onClose: (value: boolean | string | null) => void;
}) {
  const { t } = useTranslation('common');
  const isPrompt = state.kind === 'prompt';
  const opts = state.opts;
  const [value, setValue] = useState(
    isPrompt ? ((opts as PromptOptions).defaultValue ?? '') : ''
  );
  const inputRef = useRef<HTMLInputElement>(null);

  const cancel = () => onClose(isPrompt ? null : false);
  const accept = () => onClose(isPrompt ? value : true);

  // Esc cancels; backdrop click cancels too.
  useEscapeKey(cancel);

  useEffect(() => {
    if (isPrompt) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isPrompt]);

  const danger = !isPrompt && (opts as ConfirmOptions).danger;
  const confirmLabel = opts.confirmLabel ?? t('actions.ok');
  const cancelLabel = opts.cancelLabel ?? t('actions.cancel');

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10000,
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div
        style={{
          background: '#1e1e1e',
          border: '1px solid #333',
          borderRadius: 8,
          boxShadow: '0 8px 32px rgba(0,0,0,.6)',
          width: 'min(420px, calc(100vw - 32px))',
          padding: 20,
          color: '#e0e0e0',
        }}
      >
        {opts.title && (
          <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 10 }}>
            {opts.title}
          </div>
        )}
        {(isPrompt ? (opts as PromptOptions).message : opts.message) && (
          <div
            style={{
              fontSize: 13,
              lineHeight: 1.5,
              color: '#bbb',
              marginBottom: isPrompt ? 12 : 18,
              whiteSpace: 'pre-line',
            }}
          >
            {isPrompt ? (opts as PromptOptions).message : opts.message}
          </div>
        )}
        {isPrompt && (
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') accept();
            }}
            placeholder={(opts as PromptOptions).placeholder}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              background: '#2a2a2a',
              border: '1px solid #3a3a3a',
              borderRadius: 6,
              color: '#fff',
              padding: '8px 12px',
              fontSize: 14,
              outline: 'none',
              marginBottom: 18,
            }}
          />
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={cancel}
            style={{
              background: '#2a2a2a',
              color: '#ccc',
              border: '1px solid #3a3a3a',
              borderRadius: 6,
              padding: '6px 14px',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            {cancelLabel}
          </button>
          <button
            onClick={accept}
            autoFocus={!isPrompt}
            style={{
              background: danger ? '#7a2a2a' : '#2563eb',
              color: danger ? '#f88' : '#fff',
              border: 'none',
              borderRadius: 6,
              padding: '6px 14px',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 500,
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
