// Topologia do RabbitMQ para eventos de pagamento.
// ATENÇÃO: o mock do iFood (ifood-backend/src/events/topology.ts) tem uma cópia idêntica e
// declara a mesma fila principal com os mesmos argumentos. Se mudar aqui, mude lá.
//
//   exchange  ifood.payments (topic, durável)
//   evento    payment.confirmed   → publicado pelo mock quando uma cobrança é paga
//
//   ai-backend.payments        fila principal (ligada a "payment.*")
//   ai-backend.payments.retry  espera N segundos e devolve a mensagem para a fila principal
//   ai-backend.payments.dlq    mensagens que não podem ser processadas (inspeção manual)
export const PAYMENTS_EXCHANGE = 'ifood.payments';
export const PAYMENTS_QUEUE = 'ai-backend.payments';
export const PAYMENTS_RETRY_QUEUE = 'ai-backend.payments.retry';
export const PAYMENTS_DLQ = 'ai-backend.payments.dlq';
export const PAYMENTS_BINDING_KEY = 'payment.*';
export const PAYMENT_CONFIRMED = 'payment.confirmed';

export interface PaymentConfirmedEvent {
  eventId: string;
  type: typeof PAYMENT_CONFIRMED;
  version: 1;
  occurredAt: string;
  data: {
    paymentId: string;
    // payments.id do ai-backend, enviado ao criar a cobrança.
    reference: string;
    amountCents: number;
    paidAt: string;
  };
}
