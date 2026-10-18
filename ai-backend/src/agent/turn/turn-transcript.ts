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

  // A mensagem do usuário que abriu o turno.
  get userMessage(): MessageParam {
    return this.messages[this.start - 1];
  }

  // O estado do pedido entra na mensagem do usuário e fica no histórico com ela: os próximos
  // turnos recebem exatamente o mesmo texto (o prefixo do cache se mantém).
  attachToUserMessage(text: string): void {
    const target = this.messages[this.start - 1];
    if (!text || target?.role !== 'user') return;
    const content =
      typeof target.content === 'string'
        ? [{ type: 'text' as const, text: target.content }]
        : target.content;
    this.messages[this.start - 1] = {
      ...target,
      content: [...content, { type: 'text', text }],
    };
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
