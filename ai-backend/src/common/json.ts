// Leitura tolerante de JSON vindo de ferramentas: o formato não é garantido, então tudo aqui aceita
// qualquer valor e devolve um vazio em vez de lançar.

export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// O primeiro campo presente (nem undefined nem null) entre `keys`.
export function pick(o: Obj, keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

// String com espaços normalizados e cortada em `max`; qualquer outra coisa vira ''.
export const text = (v: unknown, max = 200): string =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';

export function parseJsonSafe(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
