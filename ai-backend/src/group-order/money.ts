import { GroupOrderError } from './group-order.errors.js';

// Limite de sanidade (R$ 100 mil): evita lixo vindo do LLM e mantém as contas dentro de 2^53.
const MAX_CENTS = 10_000_000;

// Valor em reais (number do LLM ou string do banco) → centavos inteiros.
// Rejeita mais de 2 casas decimais em vez de arredondar em silêncio: dinheiro não se adivinha.
export function toCents(value: number | string, field = 'valor'): number {
  const reais = typeof value === 'string' ? Number(value) : value;
  if (typeof reais !== 'number' || !Number.isFinite(reais)) {
    throw new GroupOrderError(`${field} inválido: ${String(value)}`);
  }
  const cents = Math.round(reais * 100);
  if (Math.abs(reais * 100 - cents) > 1e-6) {
    throw new GroupOrderError(
      `${field} deve ter no máximo 2 casas decimais: ${String(value)}`,
    );
  }
  if (Math.abs(cents) > MAX_CENTS) {
    throw new GroupOrderError(`${field} fora do limite: ${String(value)}`);
  }
  return cents;
}

// Centavos → string decimal para colunas NUMERIC ("42.90").
export function fromCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

// Centavos → texto para o usuário ("R$ 42,90").
export function formatBRL(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const reais = String(Math.floor(abs / 100)).replace(
    /\B(?=(\d{3})+(?!\d))/g,
    '.',
  );
  return `${sign}R$ ${reais},${String(abs % 100).padStart(2, '0')}`;
}
