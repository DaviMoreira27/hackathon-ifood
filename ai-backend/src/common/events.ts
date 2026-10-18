// Eventos de domínio (via @nestjs/event-emitter). Quem emite não conhece quem escuta.

// Login no iFood concluído. Payload: UserLoggedIn.
export const USER_LOGGED_IN = 'user.logged-in';
export interface UserLoggedIn {
  chatId: number;
}

// Pagamento confirmado e aplicado no pedido. Payload: PaymentApplied (payments.service.ts).
export const PAYMENT_APPLIED = 'payment.applied';
