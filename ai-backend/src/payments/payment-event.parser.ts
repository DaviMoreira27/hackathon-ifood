import { PAYMENT_CONFIRMED, type PaymentConfirmedEvent } from './topology.js';

// Leitura e validação de uma mensagem `payment.*` vinda do RabbitMQ.

// Mensagem malformada ou de versão desconhecida: não adianta tentar de novo.
export class InvalidEventError extends Error {}

export function parseEvent(
  content: Buffer,
): PaymentConfirmedEvent | { ignored: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(content.toString('utf8'));
  } catch {
    throw new InvalidEventError('JSON inválido');
  }
  const event = raw as Partial<PaymentConfirmedEvent> | null;
  if (
    !event ||
    typeof event !== 'object' ||
    typeof event.eventId !== 'string' ||
    !event.eventId
  ) {
    throw new InvalidEventError('eventId ausente');
  }
  if (event.type !== PAYMENT_CONFIRMED) {
    // Outros eventos "payment.*" que venham a existir: não é erro, só não é com a gente.
    return { ignored: String(event.type) };
  }
  if (event.version !== 1) {
    throw new InvalidEventError(
      `versão não suportada: ${String(event.version)}`,
    );
  }
  const data = event.data;
  if (
    !data ||
    typeof data.reference !== 'string' ||
    !Number.isInteger(data.amountCents) ||
    (data.amountCents as number) <= 0 ||
    typeof data.paidAt !== 'string' ||
    Number.isNaN(Date.parse(data.paidAt))
  ) {
    throw new InvalidEventError('campos de data inválidos');
  }
  return event as PaymentConfirmedEvent;
}
