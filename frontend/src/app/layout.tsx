import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { PhoneShell } from "@/components/PhoneShell";
import "./globals.css";

export const metadata: Metadata = { title: "iFood – fluxo de pedido (simulação)" };
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        <PhoneShell>{children}</PhoneShell>
      </body>
    </html>
  );
}
