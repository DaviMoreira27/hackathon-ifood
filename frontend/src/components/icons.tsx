import type { SVGProps } from "react";

const base = (p: SVGProps<SVGSVGElement>) => ({
  width: 24, height: 24, viewBox: "0 0 24 24", fill: "none",
  stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, ...p,
});

export const ChevronLeft = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M15 5l-7 7 7 7" /></svg>;
export const ChevronRight = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M9 5l7 7-7 7" /></svg>;
export const ChevronDown = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M5 9l7 7 7-7" /></svg>;
export const Plus = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M12 5v14M5 12h14" /></svg>;
export const Trash = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base({ fill: "currentColor", stroke: "none", ...p })}>
    <path d="M9 3h6l1 2h4v2H4V5h4l1-2zM6 9h12l-1 11a1 1 0 01-1 1H8a1 1 0 01-1-1L6 9z" />
  </svg>
);
export const Pencil = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base({ fill: "currentColor", stroke: "none", ...p })}>
    <path d="M3 17.25V21h3.75L18.8 8.95l-3.75-3.75L3 17.25zM20.7 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
  </svg>
);
export const Pin = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base({ fill: "currentColor", stroke: "none", ...p })}>
    <path d="M12 2a7 7 0 00-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 00-7-7zm0 9.5A2.5 2.5 0 119.5 9 2.5 2.5 0 0112 11.5z" />
  </svg>
);
export const Lock = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base({ fill: "currentColor", stroke: "none", ...p })}>
    <path d="M17 9h-1V7a4 4 0 00-8 0v2H7a2 2 0 00-2 2v9a2 2 0 002 2h10a2 2 0 002-2v-9a2 2 0 00-2-2zm-7-2a2 2 0 014 0v2h-4V7zm3 8.7V18h-2v-2.3a1.5 1.5 0 112 0z" />
  </svg>
);
export const Bike = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base({ strokeWidth: 2, ...p })}>
    <circle cx="12" cy="5" r="2" fill="currentColor" />
    <path d="M9 21v-5a3 3 0 016 0v5M8 11h8M7 21h10" />
  </svg>
);
export const Copy = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base({ strokeWidth: 2.4, ...p })}>
    <rect x="9" y="9" width="11" height="11" rx="1.5" />
    <path d="M15 9V4.5A1.5 1.5 0 0013.5 3h-9A1.5 1.5 0 003 4.5v9A1.5 1.5 0 004.5 15H9" />
  </svg>
);
export const Receipt = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base({ fill: "currentColor", stroke: "none", ...p })}>
    <path d="M6 2h12a1 1 0 011 1v19l-3-2-3 2-3-2-3 2V3a1 1 0 011-1zm2 5v2h8V7H8zm0 4v2h8v-2H8z" />
  </svg>
);
export const Wallet = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base({ strokeWidth: 2, ...p })}>
    <path d="M4 7a2 2 0 012-2h12v4M4 7v10a2 2 0 002 2h13a1 1 0 001-1v-9a1 1 0 00-1-1H6a2 2 0 01-2-2z" />
    <circle cx="16.5" cy="13.5" r="1" fill="currentColor" />
  </svg>
);
export const Cards = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base({ strokeWidth: 2, ...p })}>
    <rect x="2.5" y="7" width="19" height="13" rx="2" />
    <path d="M6 4h14a2 2 0 012 2M2.5 12h19" />
  </svg>
);
export const Check = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M5 12.5l4.5 4.5L19 7" /></svg>;

export const PixLogo = ({ size = 28 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
    <g fill="#32BCAD">
      <path d="M16 2.8l4.9 4.9a2.4 2.4 0 010 3.4l-3.2 3.2a2.4 2.4 0 01-3.4 0l-3.2-3.2a2.4 2.4 0 010-3.4L16 2.8z" />
      <path d="M16 29.2l-4.9-4.9a2.4 2.4 0 010-3.4l3.2-3.2a2.4 2.4 0 013.4 0l3.2 3.2a2.4 2.4 0 010 3.4L16 29.2z" />
      <path d="M2.8 16l4.9-4.9 3.2 3.2a2.4 2.4 0 010 3.4l-3.2 3.2L2.8 16z" />
      <path d="M29.2 16l-4.9 4.9-3.2-3.2a2.4 2.4 0 010-3.4l3.2-3.2L29.2 16z" />
    </g>
  </svg>
);

export const GPayLogo = () => (
  <span className="inline-flex h-[22px] w-[34px] items-center justify-center rounded-[3px] border border-ink/60 bg-white text-[10px] font-semibold leading-none text-ink">
    <span className="text-[#4285F4]">G</span>&nbsp;Pay
  </span>
);

export const IfoodPago = ({ className = "" }: { className?: string }) => (
  <span className={`font-extrabold italic tracking-tight text-pago ${className}`}>
    ifood <span className="font-semibold">Pago</span>
  </span>
);
