import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

type ToastKind = "ok" | "err";

type ToastItem = {
  id: number;
  kind: ToastKind;
  text: string;
};

export type ToastApi = {
  ok: (text: string) => void;
  err: (text: string) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

const OK_TTL_MS = 3000;
/** Keep the stack short; oldest entries fall off. */
const MAX_VISIBLE = 4;

/**
 * Global toast layer: success toasts auto-dismiss, error toasts stay until
 * closed. Mounted once in main.tsx; pages consume via useToast().
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, text: string) => {
      const id = nextId.current++;
      setItems((prev) => [...prev, { id, kind, text }].slice(-MAX_VISIBLE));
      if (kind === "ok") {
        window.setTimeout(() => dismiss(id), OK_TTL_MS);
      }
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      ok: (text: string) => push("ok", text),
      err: (text: string) => push("err", text),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <span className="toast-text">{t.text}</span>
            <button
              type="button"
              className="toast-close"
              aria-label="关闭提示"
              onClick={() => dismiss(t.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
