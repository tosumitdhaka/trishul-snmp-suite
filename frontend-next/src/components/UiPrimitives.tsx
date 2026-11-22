import React, { useEffect } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useWorkbench } from '../context/WorkbenchContext';

export const TrishulMark: React.FC<{ className?: string }> = ({ className = 'w-6 h-6' }) => (
  <svg
    viewBox="0 0 64 64"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    className={className}
  >
    <defs>
      <linearGradient id="tuiTrishulGrad" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor="#FFB84D" />
        <stop offset="100%" stopColor="#D97706" />
      </linearGradient>
    </defs>
    <path
      d="M57 24.6C54 17.4 44.8 8.7 44.8 8.7s3 7.4.8 17.3l3.5-3s3.3 1.4 3.7 5c.5 4.4-2 10.6-2 10.6s-5.5-1.7-13.9-1.6l-3-19.6l7.2 4.7L32 2l-9 19.9l7.2-4.7l-3 19.6c-8.4-.1-13.9 1.6-13.9 1.6s-2.5-6.2-2-10.6c.4-3.5 3.7-5 3.7-5l3.5 3c-2.2-9.8.8-17.3.8-17.3S10 17.4 7 24.6C3.9 32 2 40.8 2 40.8l6.4 5.9s5.6-1.7 10-2c4.1-.3 8.9-.4 8.9-.4l-.6 8.7l5.3 9l5.3-9l-.6-8.7s4.8.1 8.9.4c4.3.3 10 2 10 2l6.4-5.9s-1.9-8.8-5-16.2"
      fill="url(#tuiTrishulGrad)"
    />
  </svg>
);

export const StatusLabel: React.FC<{
  tone: 'success' | 'danger' | 'warning' | 'info' | 'neutral';
  label: string;
  liveDot?: boolean;
}> = ({ tone, label, liveDot = false }) => {
  const styles: Record<typeof tone, string> = {
    success: 'bg-[var(--tui-success-soft)] text-[var(--tui-success-ink)] border-[var(--tui-success-border)]',
    danger: 'bg-[var(--tui-danger-soft)] text-[var(--tui-danger-ink)] border-[var(--tui-danger-border)]',
    warning: 'bg-[var(--tui-warning-soft)] text-[var(--tui-warning-ink)] border-[var(--tui-warning-border)]',
    info: 'bg-[var(--tui-info-soft)] text-[var(--tui-info-ink)] border-[var(--tui-info-border)]',
    neutral: 'bg-[var(--tui-bg-muted)] text-[var(--tui-ink-secondary)] border-[var(--tui-border-default)]',
  };
  const dotColors: Record<typeof tone, string> = {
    success: 'bg-[var(--tui-success)]',
    danger: 'bg-[var(--tui-danger)]',
    warning: 'bg-[var(--tui-warning)]',
    info: 'bg-[var(--tui-info)]',
    neutral: 'bg-[var(--tui-ink-soft)]',
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-mono font-semibold border rounded-[4px] whitespace-nowrap shrink-0 ${styles[tone]}`}
    >
      {liveDot && <span className={`w-1.5 h-1.5 rounded-full ${dotColors[tone]}`} aria-hidden="true" />}
      {label}
    </span>
  );
};

export const SlideDrawer: React.FC<{
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  widthClass?: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
}> = ({ open, onClose, title, subtitle, widthClass = 'max-w-xl', footer, children }) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={title}>
      <div
        className="fixed inset-0 bg-slate-950/60 backdrop-blur-[2px] transition-opacity"
        onClick={onClose}
      />
      <div
        className={`relative z-10 w-full ${widthClass} h-full flex flex-col bg-[var(--tui-bg-surface)] border-l border-[var(--tui-border-default)] shadow-2xl`}
      >
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-[var(--tui-border-default)] bg-[var(--tui-bg-subtle)]">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-[var(--tui-ink-primary)] truncate">{title}</h2>
            {subtitle && (
              <p className="text-xs font-mono text-[var(--tui-ink-muted)] mt-0.5 truncate">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${title}`}
            className="p-1.5 rounded-md text-[var(--tui-ink-muted)] hover:text-[var(--tui-ink-primary)] hover:bg-[var(--tui-bg-hover)] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
        {footer && (
          <div className="px-5 py-3.5 border-t border-[var(--tui-border-default)] bg-[var(--tui-bg-subtle)] flex items-center justify-end gap-2">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};

export const EmptyPane: React.FC<{
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}> = ({ icon, title, description, action }) => (
  <div className="flex flex-col items-center justify-center text-center py-12 px-6">
    <div className="w-10 h-10 rounded-lg bg-[var(--tui-bg-muted)] border border-[var(--tui-border-default)] flex items-center justify-center text-[var(--tui-ink-muted)] mb-3">
      {icon}
    </div>
    <p className="text-sm font-semibold text-[var(--tui-ink-primary)]">{title}</p>
    <p className="text-xs text-[var(--tui-ink-muted)] max-w-sm mt-1 leading-relaxed">{description}</p>
    {action && <div className="mt-4">{action}</div>}
  </div>
);

export const ToastStack: React.FC = () => {
  const { toasts, dismissToast } = useWorkbench();
  if (toasts.length === 0) return null;

  const iconFor = (tone: 'success' | 'error' | 'warning' | 'info') => {
    if (tone === 'success') return <CheckCircle2 className="w-4 h-4 text-[var(--tui-success)] shrink-0" />;
    if (tone === 'error') return <XCircle className="w-4 h-4 text-[var(--tui-danger)] shrink-0" />;
    if (tone === 'warning') return <AlertTriangle className="w-4 h-4 text-[var(--tui-warning)] shrink-0" />;
    return <Info className="w-4 h-4 text-[var(--tui-info)] shrink-0" />;
  };

  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)]">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          aria-live="polite"
          className="flex items-start gap-2.5 px-3.5 py-2.5 rounded-lg bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)] shadow-lg text-xs text-[var(--tui-ink-primary)]"
        >
          <div className="mt-0.5">{iconFor(t.tone)}</div>
          <span className="flex-1 leading-relaxed break-words">{t.message}</span>
          <button
            type="button"
            onClick={() => dismissToast(t.id)}
            aria-label="Dismiss notification"
            className="text-[var(--tui-ink-soft)] hover:text-[var(--tui-ink-primary)] p-0.5"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
};

export const ConfirmModal: React.FC = () => {
  const { confirmState, resolveConfirm } = useWorkbench();

  useEffect(() => {
    if (!confirmState) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') resolveConfirm(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmState, resolveConfirm]);

  if (!confirmState) return null;

  const isDanger = (confirmState.variant || 'danger') === 'danger';

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div
        className="fixed inset-0 bg-slate-950/65 backdrop-blur-[2px]"
        onClick={() => resolveConfirm(false)}
      />
      <div className="relative z-10 w-full max-w-md rounded-xl bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)] shadow-2xl p-5">
        <div
          className={`w-10 h-10 rounded-lg border flex items-center justify-center mb-3.5 ${
            isDanger
              ? 'bg-[var(--tui-danger-soft)] border-[var(--tui-danger-border)] text-[var(--tui-danger-ink)]'
              : 'bg-[var(--tui-brand-soft)] border-[var(--tui-brand-border)] text-[var(--tui-brand)]'
          }`}
        >
          <AlertTriangle className="w-5 h-5" />
        </div>
        <h2 className="text-base font-semibold text-[var(--tui-ink-primary)]">{confirmState.title}</h2>
        <p className="text-sm text-[var(--tui-ink-secondary)] mt-1.5 leading-relaxed">
          {confirmState.message}
        </p>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => resolveConfirm(false)}
            className="px-3.5 py-2 text-xs font-medium rounded-md border border-[var(--tui-border-default)] bg-[var(--tui-bg-surface)] text-[var(--tui-ink-primary)] hover:bg-[var(--tui-bg-hover)] transition-colors"
          >
            {confirmState.cancelLabel || 'Cancel'}
          </button>
          <button
            type="button"
            onClick={() => resolveConfirm(true)}
            className={`px-3.5 py-2 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
              isDanger
                ? 'bg-[var(--tui-danger-btn-bg)] text-[var(--tui-danger-btn-ink)] hover:bg-[var(--tui-danger-btn-hover)]'
                : 'bg-[var(--tui-action-bg)] text-[var(--tui-action-ink)] hover:bg-[var(--tui-action-hover)]'
            }`}
          >
            {confirmState.confirmLabel || 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
};
