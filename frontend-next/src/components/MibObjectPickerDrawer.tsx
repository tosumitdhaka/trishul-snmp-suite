import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Plus, Search, X } from 'lucide-react';
import { api } from '../lib/api';
import {
  formatConstraintHint,
  inferSnmpVarbindType,
  normalizeEnums,
} from '../lib/workbench';
import type { MibObjectSearchItem } from '../types/api';
import { SlideDrawer } from './UiPrimitives';

interface MibObjectPickerDrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  actionLabel?: string;
  initialQuery?: string;
  onSelect: (item: MibObjectSearchItem) => void;
}

const SUGGESTED_TERMS = ['sysDescr', 'ifIndex', 'ifAdminStatus', 'ifSpeed', 'ifInOctets', 'snmpInPkts'];

export const MibObjectPickerDrawer: React.FC<MibObjectPickerDrawerProps> = ({
  open,
  onClose,
  title,
  subtitle = 'Search across all compiled MIB objects by symbol, module, or numeric OID',
  actionLabel = 'Add',
  initialQuery = '',
  onSelect,
}) => {
  const [query, setQuery] = useState(initialQuery);
  const [items, setItems] = useState<MibObjectSearchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    setQuery(initialQuery);
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 40);
    return () => window.clearTimeout(focusTimer);
  }, [open, initialQuery]);

  useEffect(() => {
    if (!open) return;
    const term = query.trim();
    const mySeq = ++seqRef.current;

    if (!term) {
      setLoading(true);
      const timer = window.setTimeout(async () => {
        try {
          const res = await api.searchObjects('if', 40);
          if (seqRef.current === mySeq) {
            setItems(res.objects || []);
          }
        } catch {
          if (seqRef.current === mySeq) setItems([]);
        } finally {
          if (seqRef.current === mySeq) setLoading(false);
        }
      }, 60);
      return () => window.clearTimeout(timer);
    }

    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const res = await api.searchObjects(term, 80);
        if (seqRef.current === mySeq) {
          setItems(res.objects || []);
        }
      } catch {
        if (seqRef.current === mySeq) setItems([]);
      } finally {
        if (seqRef.current === mySeq) setLoading(false);
      }
    }, 140);
    return () => window.clearTimeout(timer);
  }, [open, query]);

  return (
    <SlideDrawer open={open} onClose={onClose} title={title} subtitle={subtitle} widthClass="max-w-2xl">
      <div className="space-y-3.5">
        <div className="relative">
          <Search className="w-4 h-4 text-[var(--tui-ink-soft)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && items.length > 0) {
                e.preventDefault();
                onSelect(items[0]);
              }
            }}
            placeholder="Type symbol, module, or OID (e.g. ifAdminStatus, sysUpTime, 1.3.6.1.2.1.2)..."
            aria-label="Search MIB objects"
            className="w-full h-9 pl-9 pr-8 rounded-md text-xs bg-[var(--tui-bg-canvas)] border border-[var(--tui-border-default)] text-[var(--tui-ink-primary)] focus:outline-none focus:border-[var(--tui-brand)]"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear object search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--tui-ink-soft)] hover:text-[var(--tui-ink-primary)] cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Quick lookup chips */}
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="text-[var(--tui-ink-muted)] mr-0.5">Quick:</span>
          {SUGGESTED_TERMS.map((term) => (
            <button
              key={term}
              type="button"
              onClick={() => setQuery(term)}
              className={`px-2 py-0.5 rounded font-mono border transition-colors cursor-pointer ${
                query === term
                  ? 'bg-[var(--tui-brand-soft)] border-[var(--tui-brand-border)] text-[var(--tui-brand-ink)]'
                  : 'bg-[var(--tui-bg-subtle)] border-[var(--tui-border-default)] text-[var(--tui-ink-secondary)] hover:bg-[var(--tui-bg-hover)]'
              }`}
            >
              {term}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between text-[11px] font-mono text-[var(--tui-ink-muted)]">
          <span>
            {loading
              ? 'Searching active MIB catalog...'
              : query.trim()
              ? `${items.length} matching object${items.length === 1 ? '' : 's'}`
              : `Suggested MIB objects (${items.length}) — type to search full catalog`}
          </span>
          {items.length > 0 && <span className="hidden sm:inline">Enter selects top match</span>}
        </div>

        {loading ? (
          <div className="py-10 flex items-center justify-center gap-2 text-xs text-[var(--tui-ink-muted)]">
            <Loader2 className="w-4 h-4 animate-spin text-[var(--tui-brand)]" />
            Querying compiled MIB objects...
          </div>
        ) : items.length === 0 ? (
          <div className="py-10 text-center text-xs text-[var(--tui-ink-muted)] border border-[var(--tui-border-default)] rounded-lg bg-[var(--tui-bg-subtle)]">
            No compiled MIB objects matched &ldquo;{query}&rdquo;.
          </div>
        ) : (
          <div className="border border-[var(--tui-border-default)] rounded-lg overflow-hidden divide-y divide-[var(--tui-border-subtle)]">
            {items.map((obj) => {
              const inferredType = inferSnmpVarbindType(obj);
              const enums = normalizeEnums(obj.enum_values);
              const constraintHint = formatConstraintHint(obj.constraint, inferredType);
              return (
                <div
                  key={`${obj.full_name}-${obj.oid}`}
                  onClick={() => onSelect(obj)}
                  className="px-3.5 py-2.5 flex items-center justify-between gap-3 bg-[var(--tui-bg-surface)] hover:bg-[var(--tui-bg-hover)] cursor-pointer transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-xs font-semibold text-[var(--tui-ink-primary)] truncate">
                        {obj.full_name}
                      </span>
                      <span className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-[var(--tui-bg-muted)] border border-[var(--tui-border-default)] text-[var(--tui-ink-secondary)]">
                        {inferredType}
                      </span>
                      {enums.length > 0 && (
                        <span className="text-[10px] font-mono text-[var(--tui-info-ink)]">
                          {enums.length} enums
                        </span>
                      )}
                    </div>
                    <div className="font-mono text-[11px] text-[var(--tui-ink-muted)] mt-0.5 flex items-center gap-2 flex-wrap">
                      <span className="tabular-nums">{obj.oid}</span>
                      {obj.syntax && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{obj.syntax}</span>
                        </>
                      )}
                      {constraintHint && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-[var(--tui-brand)]">{constraintHint}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(obj);
                    }}
                    className="h-7 px-2.5 rounded-md text-[11px] font-semibold bg-[var(--tui-action-bg)] text-[var(--tui-action-ink)] hover:bg-[var(--tui-action-hover)] inline-flex items-center gap-1 shrink-0 cursor-pointer"
                  >
                    <Plus className="w-3 h-3" />
                    <span>{actionLabel}</span>
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </SlideDrawer>
  );
};
