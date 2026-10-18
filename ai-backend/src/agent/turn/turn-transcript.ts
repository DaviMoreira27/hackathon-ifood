import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';

// A conversa viva de um turno: o histórico carregado e o que o turno acrescenta.
export class TurnTranscript {
  private readonly start: number;
  // Resposta rejeitada pelo validador e a nota de correção: valem só dentro do turno. Gravadas,
  // voltariam nos próximos turnos e o modelo passaria a comentar as correções com o usuário.
  private readonly scratch = new Set<MessageParam>();
  saved = false;

  // `messages` já inclui a mensagem do usuário que abriu o turno.
  constructor(readonly messages: MessageParam[]) {
    this.start = messages.length;
  }

  // Índice da mensagem do usuário que abriu o turno.
  get userIndex(): number {
    return this.start - 1;
  }

  push(message: MessageParam): void {
    this.messages.push(message);
  }

  pushScratch(message: MessageParam): void {
    this.scratch.add(message);
    this.messages.push(message);
  }

  // O que vai para o histórico.
  turn(): MessageParam[] {
    return this.messages.slice(this.start).filter((m) => !this.scratch.has(m));
  }

  get hasTurn(): boolean {
    return this.messages.length > this.start;
  }
}
