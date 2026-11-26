import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { CoreApiError } from '@promptlens/api-client';
import {
  EVALUATION_STATUS_LABELS,
  OUTPUT_VALIDITY_LABELS,
  RUN_STATUS_LABELS,
  TRIAL_STATUS_LABELS,
} from '@promptlens/contracts';

/* ---------------- 按钮 ---------------- */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'default' | 'small';
  loading?: boolean;
  block?: boolean;
};

export function Button({ variant = 'default', size = 'default', loading, block, className = '', children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={`btn ${variant !== 'default' ? variant : ''} ${size === 'small' ? 'small' : ''} ${block ? 'block' : ''} ${className}`}
    >
      {loading ? <span className="spinner" aria-hidden /> : null}
      {children}
    </button>
  );
}

/* ---------------- 表单 ---------------- */

export function Field({ label, hint, error, children }: { label?: string; hint?: ReactNode; error?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      {label ? <span className="label">{label}</span> : null}
      {children}
      {error ? <span className="hint" style={{ color: 'var(--red)' }}>{error}</span> : null}
      {hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className = '', ...rest } = props;
  return <input {...rest} className={`input ${className}`} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = '', ...rest } = props;
  return <textarea {...rest} className={`textarea ${className}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = '', children, ...rest } = props;
  return (
    <select {...rest} className={`select ${className}`}>
      {children}
    </select>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (value: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="checkline">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>
        <span>{label}</span>
        {hint ? <span className="hint" style={{ display: 'block', color: 'var(--muted)', fontSize: 11 }}>{hint}</span> : null}
      </span>
    </label>
  );
}

/* ---------------- 容器 ---------------- */

export function Card({ title, subtitle, actions, children, flush, className = '' }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {title ? (
        <header className="card-head">
          <div>
            <h3>{title}</h3>
            {subtitle ? <div className="sub">{subtitle}</div> : null}
          </div>
          <span className="spacer" />
          {actions}
        </header>
      ) : null}
      <div className={`card-body ${flush ? 'flush' : ''}`}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'ok' | 'warn' | 'error' }) {
  const color = tone === 'ok' ? 'var(--green)' : tone === 'warn' ? 'var(--accent)' : tone === 'error' ? 'var(--red)' : undefined;
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <span className="value" style={color ? { color } : undefined}>{value}</span>
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="title">{title}</div>
      {description ? <div>{description}</div> : null}
      {action}
    </div>
  );
}

export function Section({ title, children, actions }: { title: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="stack">
      <div className="section-title">
        <span>{title}</span>
        <span className="spacer" />
        {actions}
      </div>
      {children}
    </div>
  );
}

/* ---------------- 徽标 ---------------- */

export function Badge({ tone = 'muted', children, title }: { tone?: 'ok' | 'warn' | 'error' | 'info' | 'accent' | 'muted' | 'violet'; children: ReactNode; title?: string }) {
  return (
    <span className={`badge ${tone}`} title={title}>
      {children}
    </span>
  );
}

export function RunStatusBadge({ status }: { status: string }) {
  const tone = status === 'completed' ? 'ok' : status === 'completed_with_errors' ? 'warn' : status === 'failed' ? 'error' : status === 'canceled' ? 'muted' : 'info';
  return <Badge tone={tone}>{RUN_STATUS_LABELS[status] ?? status}</Badge>;
}

export function TrialStatusBadge({ status }: { status: string }) {
  const tone = status === 'completed' ? 'ok' : status === 'failed' ? 'error' : status === 'canceled' ? 'muted' : 'info';
  return <Badge tone={tone}>{TRIAL_STATUS_LABELS[status] ?? status}</Badge>;
}

export function ValidityBadge({ validity }: { validity: string }) {
  const tone = validity === 'valid' ? 'ok' : validity === 'not_available' ? 'muted' : 'error';
  return <Badge tone={tone}>{OUTPUT_VALIDITY_LABELS[validity] ?? validity}</Badge>;
}

export function EvaluationBadge({ status }: { status: string }) {
  const tone = status === 'completed' ? 'ok' : status === 'incomplete' ? 'warn' : status === 'failed' ? 'error' : 'muted';
  return <Badge tone={tone}>{EVALUATION_STATUS_LABELS[status] ?? status}</Badge>;
}

export function HealthDot({ status }: { status: string }) {
  return <span className={`dot ${status === 'ok' ? 'ok' : status === 'degraded' ? 'warn' : 'error'}`} title={status} />;
}

/* ---------------- 弹层 ---------------- */

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'wide' : ''}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="modal-head">
        <h3>{title}</h3>
        <span className="spacer" />
        <Button variant="ghost" size="small" onClick={onClose} aria-label="关闭">
          ✕
        </Button>
      </div>
      <div className="modal-body">{children}</div>
      {footer ? <div className="modal-foot">{footer}</div> : null}
    </dialog>
  );
}

export function Drawer({ open, title, onClose, children, actions }: { open: boolean; title: ReactNode; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="drawer-backdrop" onClick={onClose} role="presentation">
      <aside className="drawer" onClick={(event) => event.stopPropagation()} aria-label={typeof title === 'string' ? title : '详情'}>
        <header className="drawer-head">
          <h3>{title}</h3>
          <span className="spacer" />
          {actions}
          <Button variant="ghost" size="small" onClick={onClose} aria-label="关闭">
            ✕
          </Button>
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}

/* ---------------- 提示 ---------------- */

export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const api = error instanceof CoreApiError ? error : null;
  return (
    <div className="notice error" role="alert">
      <div className="stack" style={{ gap: 4, flex: 1 }}>
        <strong>{api?.message ?? (error as Error)?.message ?? '操作失败'}</strong>
        <span className="small mono">{api?.code ?? 'UNKNOWN'}{api?.status ? ` · HTTP ${api.status}` : ''}</span>
        {api?.remediation ? <span className="small">{api.remediation}</span> : null}
        {api?.traceId ? <span className="small mono">trace: {api.traceId}</span> : null}
      </div>
      {onRetry ? (
        <Button size="small" onClick={onRetry}>
          重试
        </Button>
      ) : null}
    </div>
  );
}

export function CopyButton({ value, label = '复制', small }: { value: string; label?: string; small?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size={small ? 'small' : 'default'}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        } catch {
          setCopied(false);
        }
      }}
      title={value}
    >
      {copied ? '已复制' : label}
    </Button>
  );
}

export function IdText({ value, chars = 8 }: { value: string; chars?: number }) {
  const short = value.length > chars + 2 ? `${value.slice(0, chars)}…` : value;
  return (
    <span className="mono small" title={value}>
      {short}
    </span>
  );
}

type ToastTone = 'info' | 'success' | 'warn' | 'error';
interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
  detail?: string;
}

const ToastContext = createContext<{ push: (message: string, tone?: ToastTone, detail?: string) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const push = useCallback((message: string, tone: ToastTone = 'info', detail?: string) => {
    const id = ++seq.current;
    setItems((list) => [...list.slice(-4), { id, tone, message, detail }]);
    setTimeout(() => setItems((list) => list.filter((item) => item.id !== id)), 5200);
  }, []);
  const value = useMemo(() => ({ push }), [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`toast ${item.tone}`}>
            <div>
              <div>{item.message}</div>
              {item.detail ? <div className="small dim">{item.detail}</div> : null}
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast 必须在 ToastProvider 内使用');
  return ctx;
}

/* ---------------- 标签页 ---------------- */

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<{ id: T; label: ReactNode }>; value: T; onChange: (id: T) => void }) {
  const id = useId();
  return (
    <div className="tabs" role="tablist" aria-label={id}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={value === tab.id}
          className={`tab ${value === tab.id ? 'active' : ''}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function Progress({ value, max }: { value: number; max: number }) {
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="progress" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
      <span style={{ width: `${percent}%` }} />
    </div>
  );
}

export function formatDateTime(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

export function formatDuration(startedAt?: string, finishedAt?: string) {
  if (!startedAt) return '—';
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const ms = end - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function formatAmountValue(amount?: string | null, currency?: string | null, complete = true) {
  if (amount === null || amount === undefined) return complete ? '—' : '未知';
  return `${amount}${currency ? ` ${currency}` : ''}`;
}

export function formatPercent(value?: number | null) {
  if (value === null || value === undefined) return '—';
  return `${(value * 100).toFixed(1)}%`;
}
