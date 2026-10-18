"use client";
import { useEffect, useState, type ReactNode } from "react";

// Tela do app (área útil) + moldura do aparelho. Tudo é escalado por transform
// para caber na altura da janela (ex.: notebook 15,6").
const SCREEN_W = 420;
const SCREEN_H = 800;
const BEZEL = 12;
const OUTER_W = SCREEN_W + BEZEL * 2;
const OUTER_H = SCREEN_H + BEZEL * 2;
const MAX_SCALE = 1.15;

function StatusBar() {
  const [time, setTime] = useState("");
  useEffect(() => {
    const tick = () =>
      setTime(new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex h-10 shrink-0 items-center justify-between px-9 text-[13px] font-medium text-ink" aria-hidden>
      <span>{time}</span>
      <span className="flex items-center gap-1.5">
        <svg width="16" height="12" viewBox="0 0 16 12" fill="currentColor">
          <rect x="0" y="8" width="3" height="4" rx=".6" /><rect x="4.3" y="5.5" width="3" height="6.5" rx=".6" />
          <rect x="8.6" y="3" width="3" height="9" rx=".6" /><rect x="12.9" y="0" width="3" height="12" rx=".6" />
        </svg>
        <svg width="16" height="12" viewBox="0 0 16 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M1.5 4.2a9 9 0 0113 0M3.8 6.8a5.7 5.7 0 018.4 0M6.2 9.3a2.4 2.4 0 013.6 0" />
        </svg>
        <svg width="26" height="12" viewBox="0 0 26 12" fill="none">
          <rect x=".7" y=".7" width="21.6" height="10.6" rx="3" stroke="currentColor" strokeWidth="1.4" />
          <rect x="2.6" y="2.6" width="14" height="6.8" rx="1.6" fill="currentColor" />
          <rect x="23.4" y="4" width="1.8" height="4" rx=".9" fill="currentColor" />
        </svg>
      </span>
    </div>
  );
}

export function PhoneShell({ children }: { children: ReactNode }) {
  // null = ainda não medido; 0 = celular de verdade (sem moldura)
  const [scale, setScale] = useState<number | null>(null);

  useEffect(() => {
    const calc = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (vw < 520) return setScale(0);
      setScale(Math.max(0.5, Math.min(MAX_SCALE, (vh - 32) / OUTER_H, (vw - 32) / OUTER_W)));
    };
    calc();
    window.addEventListener("resize", calc);
    return () => window.removeEventListener("resize", calc);
  }, []);

  if (scale === null) return <div className="min-h-dvh bg-[#E9E9EC]" />;

  if (scale === 0) {
    return <div className="relative h-dvh w-full overflow-hidden bg-white">{children}</div>;
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[#E9E9EC]">
      <div className="shrink-0" style={{ width: OUTER_W * scale, height: OUTER_H * scale }}>
        <div
          className="relative rounded-[58px] bg-[#17171b] shadow-[0_30px_80px_rgba(0,0,0,.35),inset_0_0_0_2px_#2e2e34]"
          style={{
            width: OUTER_W,
            height: OUTER_H,
            padding: BEZEL,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
          }}
        >
          {/* botões laterais */}
          <span className="absolute -right-[3px] top-[170px] h-[84px] w-[3px] rounded-r bg-[#2a2a2f]" aria-hidden />
          <span className="absolute -left-[3px] top-[130px] h-[56px] w-[3px] rounded-l bg-[#2a2a2f]" aria-hidden />
          <span className="absolute -left-[3px] top-[200px] h-[56px] w-[3px] rounded-l bg-[#2a2a2f]" aria-hidden />

          <div className="relative flex h-full w-full flex-col overflow-hidden rounded-[46px] bg-white">
            <StatusBar />
            <div className="relative min-h-0 flex-1">
              {children}
              <span
                aria-hidden
                className="pointer-events-none absolute bottom-1.5 left-1/2 z-40 h-1 w-32 -translate-x-1/2 rounded-full bg-black/70"
              />
            </div>
            {/* câmera frontal */}
            <span aria-hidden className="absolute left-1/2 top-3 z-50 h-3 w-3 -translate-x-1/2 rounded-full bg-[#0b0b0d] ring-2 ring-[#1d1d22]" />
          </div>
        </div>
      </div>
    </div>
  );
}
