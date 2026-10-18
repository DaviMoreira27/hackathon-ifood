export const brl = (value: number) =>
  value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }).replace(/\u00a0/g, " ");

export const formatTimer = (totalSeconds: number) => {
  const m = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const s = Math.floor(totalSeconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
};

export const maskCpf = (raw: string) => {
  const d = raw.replace(/\D/g, "").slice(0, 11);
  return d
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d{1,2})$/, "$1-$2");
};
