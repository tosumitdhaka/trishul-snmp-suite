import React, { useId, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle, CheckCircle2, Eye, EyeOff, Info, X, XCircle } from 'lucide-react';
import { useWorkbench } from '../context/WorkbenchContext';

export const TrishulMark: React.FC<{ className?: string }> = ({ className = 'w-6 h-6' }) => {
  const gradId = useId();
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={className}
    >
      <defs>
        <linearGradient id={gradId} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#f59e0b" />
          <stop offset="100%" stopColor="#d97706" />
        </linearGradient>
      </defs>
      <path
        d="M57 24.6C54 17.4 44.8 8.7 44.8 8.7s3 7.4.8 17.3l3.5-3s3.3 1.4 3.7 5c.5 4.4-2 10.6-2 10.6s-5.5-1.7-13.9-1.6l-3-19.6l7.2 4.7L32 2l-9 19.9l7.2-4.7l-3 19.6c-8.4-.1-13.9 1.6-13.9 1.6s-2.5-6.2-2-10.6c.4-3.5 3.7-5 3.7-5l3.5 3c-2.2-9.8.8-17.3.8-17.3S10 17.4 7 24.6C3.9 32 2 40.8 2 40.8l6.4 5.9s5.6-1.7 10-2c4.1-.3 8.9-.4 8.9-.4l-.6 8.7l5.3 9l5.3-9l-.6-8.7s4.8.1 8.9.4c4.3.3 10 2 10 2l6.4-5.9s-1.9-8.8-5-16.2"
        fill={`url(#${gradId})`}
      />
    </svg>
  );
};

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

export const SecretInput: React.FC<{
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  minLength?: number;
  autoComplete?: string;
  ariaLabel?: string;
  className?: string;
  toggleLabel?: string;
}> = ({
  id,
  value,
  onChange,
  placeholder,
  disabled,
  readOnly,
  required,
  minLength,
  autoComplete,
  ariaLabel,
  className = '',
  toggleLabel = 'secret value',
}) => {
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="relative flex items-center">
      <input
        id={id}
        type={revealed ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        readOnly={readOnly}
        required={required}
        minLength={minLength}
        autoComplete={autoComplete}
        aria-label={ariaLabel}
        className={`w-full h-8 pl-2.5 pr-8 rounded-md font-mono text-xs bg-[var(--tui-bg-surface)] text-[var(--tui-ink-primary)] border border-[var(--tui-border-control)] disabled:opacity-60 disabled:cursor-not-allowed ${className}`}
      />
      <button
        type="button"
        onClick={() => setRevealed((prev) => !prev)}
        disabled={disabled}
        aria-pressed={revealed}
        aria-label={revealed ? `Hide ${toggleLabel}` : `Show ${toggleLabel}`}
        title={revealed ? `Hide ${toggleLabel}` : `Show ${toggleLabel}`}
        className="absolute right-1.5 p-1 rounded text-[var(--tui-ink-muted)] hover:text-[var(--tui-ink-primary)] disabled:opacity-50 cursor-pointer"
      >
        {revealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
      </button>
    </div>
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
}> = ({ open, onClose, title, subtitle, widthClass = 'max-w-xl', footer, children }) => (
  <Dialog.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--tui-backdrop)] backdrop-blur-[2px]" />
      <Dialog.Content
        className={`fixed inset-y-0 right-0 z-50 w-full ${widthClass} h-full flex flex-col bg-[var(--tui-bg-surface)] border-l border-[var(--tui-border-default)] shadow-2xl`}
      >
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-[var(--tui-border-default)] bg-[var(--tui-bg-subtle)]">
          <div className="min-w-0">
            <Dialog.Title className="text-sm font-semibold text-[var(--tui-ink-primary)] truncate">
              {title}
            </Dialog.Title>
            {subtitle ? (
              <Dialog.Description className="text-xs font-mono text-[var(--tui-ink-muted)] mt-0.5 truncate">
                {subtitle}
              </Dialog.Description>
            ) : (
              <Dialog.Description className="sr-only">{title}</Dialog.Description>
            )}
          </div>
          <Dialog.Close asChild>
            <button
              type="button"
              aria-label={`Close ${title}`}
              className="p-1.5 rounded-md text-[var(--tui-ink-muted)] hover:text-[var(--tui-ink-primary)] hover:bg-[var(--tui-bg-hover)] transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </Dialog.Close>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
        {footer && (
          <div className="px-5 py-3.5 border-t border-[var(--tui-border-default)] bg-[var(--tui-bg-subtle)] flex items-center justify-end gap-2">
            {footer}
          </div>
        )}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
);

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
            className="text-[var(--tui-ink-muted)] hover:text-[var(--tui-ink-primary)] p-0.5 cursor-pointer"
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
  const isDanger = (confirmState?.variant || 'danger') === 'danger';

  return (
    <Dialog.Root
      open={Boolean(confirmState)}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) resolveConfirm(false);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-[var(--tui-backdrop)] backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[70] w-[calc(100%-2rem)] max-w-md rounded-xl bg-[var(--tui-bg-surface)] border border-[var(--tui-border-default)] shadow-2xl p-5">
          {confirmState && (
            <>
              <div
                className={`w-10 h-10 rounded-lg border flex items-center justify-center mb-3.5 ${
                  isDanger
                    ? 'bg-[var(--tui-danger-soft)] border-[var(--tui-danger-border)] text-[var(--tui-danger-ink)]'
                    : 'bg-[var(--tui-brand-soft)] border-[var(--tui-brand-border)] text-[var(--tui-brand)]'
                }`}
              >
                <AlertTriangle className="w-5 h-5" />
              </div>
              <Dialog.Title className="text-base font-semibold text-[var(--tui-ink-primary)]">
                {confirmState.title}
              </Dialog.Title>
              <Dialog.Description className="text-sm text-[var(--tui-ink-secondary)] mt-1.5 leading-relaxed">
                {confirmState.message}
              </Dialog.Description>
              <div className="mt-5 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => resolveConfirm(false)}
                  className="px-3.5 py-2 text-xs font-medium rounded-md border border-[var(--tui-border-control)] bg-[var(--tui-bg-surface)] text-[var(--tui-ink-primary)] hover:bg-[var(--tui-bg-hover)] transition-colors cursor-pointer"
                >
                  {confirmState.cancelLabel || 'Cancel'}
                </button>
                <button
                  type="button"
                  onClick={() => resolveConfirm(true)}
                  className={`px-3.5 py-2 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                    isDanger
                      ? 'bg-[var(--tui-danger-btn-bg)] text-[var(--tui-danger-btn-ink)] hover:bg-[var(--tui-danger-btn-hover)]'
                      : 'tui-btn-primary'
                  }`}
                >
                  {confirmState.confirmLabel || 'Confirm'}
                </button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
