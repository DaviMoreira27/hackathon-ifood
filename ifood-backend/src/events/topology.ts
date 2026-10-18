// Topologia do RabbitMQ para eventos de pagamento.
// ATENÇÃO: o ai-backend tem uma cópia idêntica (src/payments/topology.ts) e declara a mesma fila
// com os mesmos argumentos. Se mudar aqui, mude lá, senão o RabbitMQ recusa a declaração.
//
//   exchange  ifood.payments (topic, durável)
//   evento    payment.confirmed   → publicado por este mock quando uma cobrança é paga
//   fila      ai-backend.payments → ligada a "payment.*"
//
// A fila também é declarada aqui para que eventos publicados antes de o consumidor subir
// fiquem guardados em vez de serem descartados pelo exchange.
export const PAYMENTS_EXCHANGE = 'ifood.payments';
export const PAYMENTS_QUEUE = 'ai-backend.payments';
export const PAYMENTS_BINDING_KEY = 'payment.*';
export const PAYMENT_CONFIRMED = 'payment.confirmed';

export interface PaymentConfirmedEvent {
  eventId: string;
  type: typeof PAYMENT_CONFIRMED;
  version: 1;
  occurredAt: string;
  data: {
    paymentId: string;
    // O "reference" que o ai-backend enviou ao criar a cobrança (id do pagamento dele).
    reference: string;
    amountCents: number;
    paidAt: string;
  };
}
