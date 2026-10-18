"use client";
import { useEffect, type ReactNode } from "react";
import { Check, ChevronLeft } from "./icons";

/** Coluna cheia: header fixo, conteúdo rolável, rodapé fixo. */
export function Screen({
  header, footer, children,
}: { header: ReactNode; footer?: ReactNode; children: ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col bg-white">
      <div className="shrink-0">{header}</div>
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-6">{children}</main>
      {footer && <div className="shrink-0 bg-white px-5 pb-5 pt-3 shadow-[0_-6px_16px_rgba(0,0,0,.04)]">{footer}</div>}
    </div>
  );
}

export function SacolaHeader({ onBack, title = "SACOLA" }: { onBack?: () => void; title?: string }) {
  return (
    <header className="grid grid-cols-[48px_1fr_48px] items-center gap-2 px-5 pb-3 pt-3">
      {onBack ? (
        <button
          aria-label="Voltar"
          onClick={onBack}
          className="flex h-12 w-12 items-center justify-center rounded-full bg-soft text-ink active:bg-line"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
      ) : (
        <span />
      )}
      <h1 className="text-center text-[17px] tracking-wide text-ink">{title}</h1>
      <span />
    </header>
  );
}

export function PlainHeader({
  onBack, title, right, children,
}: { onBack?: () => void; title?: ReactNode; right?: ReactNode; children?: ReactNode }) {
  return (
    <header className="px-4 pt-5">
      <div className="grid grid-cols-[48px_1fr_auto] items-center">
        <button aria-label="Voltar" onClick={onBack} className="flex h-12 w-10 items-center text-brand-dark">
          <ChevronLeft className="h-6 w-6" />
        </button>
        <div className="text-center text-[17px] tracking-wide text-ink">{title}</div>
        <div className="min-w-12 text-right text-[17px] font-medium text-brand">{right}</div>
      </div>
      {children}
    </header>
  );
}

export function PrimaryButton({
  children, onClick, disabled, loading, className = "",
}: { children: ReactNode; onClick?: () => void; disabled?: boolean; loading?: boolean; className?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className={`flex h-14 w-full items-center justify-center rounded-xl bg-brand text-[17px] font-semibold text-white transition active:scale-[.99] active:bg-brand-dark disabled:bg-line disabled:text-muted ${className}`}
    >
      {loading ? <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : children}
    </button>
  );
}

export function Sheet({
  open, onClose, children,
}: { open: boolean; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="absolute inset-0 z-30 flex items-end">
      <div className="absolute inset-0 animate-fadeIn bg-black/55" onClick={onClose} />
      <div role="dialog" aria-modal className="relative w-full animate-sheetUp rounded-t-[28px] bg-white px-6 pb-6 pt-3">
        <div className="mx-auto mb-6 h-1.5 w-20 rounded-full bg-line" />
        {children}
      </div>
    </div>
  );
}

export function Radio({ selected, tone = "dark" }: { selected: boolean; tone?: "dark" | "brand" }) {
  const ring = tone === "brand" ? "border-brand" : "border-black";
  return (
    <span
      aria-hidden
      className={`block h-7 w-7 shrink-0 rounded-full ${
        selected ? `border-[8px] ${ring} bg-white` : "border-0 bg-[#E4E4E4]"
      }`}
    />
  );
}

export function BottomTotal({
  total, count, onContinue, label = "Continuar", emptyText = "Selecione um subpedido",
}: { total: string | null; count: number; onContinue: () => void; label?: string; emptyText?: string }) {
  const empty = total === null;
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        {empty ? (
          <p className="text-[17px] text-muted">{emptyText}</p>
        ) : (
          <>
            <p className="text-[15px] text-muted">Total com a entrega</p>
            <p className="text-[22px] font-semibold text-ink">
              {total} <span className="text-[15px] font-normal text-muted">/ {count} {count === 1 ? "item" : "itens"}</span>
            </p>
          </>
        )}
      </div>
      <button
        onClick={onContinue}
        disabled={empty}
        className="h-14 min-w-[150px] shrink-0 rounded-xl bg-brand px-8 text-[17px] font-semibold text-white active:bg-brand-dark disabled:bg-line disabled:text-muted"
      >
        {label}
      </button>
    </div>
  );
}
