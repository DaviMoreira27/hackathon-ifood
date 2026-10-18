import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AgentService } from '../agent/agent.service.js';
import type { ReplyImage } from '../agent/images.js';
import { ChatsService } from '../chats/chats.service.js';
import {
  PAYMENT_APPLIED,
  USER_LOGGED_IN,
  type UserLoggedIn,
} from '../common/events.js';
import { formatPaymentNotice } from '../common/payment-notice.js';
import { splitByLines } from '../common/split-by-lines.js';
import { DbService } from '../db/db.service.js';
import { processedEvents } from '../db/schema.js';
import type { PaymentApplied } from '../payments/payments.service.js';
import { markdownToWhatsapp } from './markdown.js';
import { WhatsappApiError, WhatsappClient } from './whatsapp.client.js';

// Botões do pedido de confirmação. O toque vira a mesma mensagem que a pessoa digitaria, então
// passa pelas mesmas regras do agente (ação pendente, prazo, uso único).
export const CONFIRM_ID = 'confirm';
export const CANCEL_ID = 'cancel';
const CONFIRM_BUTTONS = [
  { id: CONFIRM_ID, title: 'Confirmar' },
  { id: CANCEL_ID, title: 'Cancelar' },
];
const BUTTON_TEXT: Record<string, string> = {
  [CONFIRM_ID]: 'confirmar',
  [CANCEL_ID]: 'cancelar',
};

export const PROCESSED_TYPE = 'whatsapp.message';
// Código da Meta para mensagem livre fora da janela de 24h desde a última mensagem do usuário.
const OUTSIDE_WINDOW_CODE = 131047;

// Limite do WhatsApp é 4096 chars por texto e 1024 no corpo de uma mensagem com botões.
const CHUNK_SIZE = 3500;
const BUTTON_BODY_MAX = 1024;

// Formato do webhook da Cloud API (só o que é usado aqui).
export interface WhatsappMessage {
  id: string;
  from: string;
  type: string;
  text?: { body: string };
  interactive?: { type: string; button_reply?: { id: string; title: string } };
}
export interface WhatsappWebhook {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      value?: {
        contacts?: Array<{ wa_id: string; profile?: { name?: string } }>;
        messages?: WhatsappMessage[];
      };
    }>;
  }>;
}

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    private readonly agent: AgentService,
    private readonly chats: ChatsService,
    private readonly database: DbService,
    private readonly client: WhatsappClient,
  ) {}

  // Roda depois do 200 ao webhook: nada aqui pode escapar sem ser logado. Status de entrega
  // (value.statuses) não têm messages e são ignorados.
  async handleWebhook(payload: WhatsappWebhook): Promise<void> {
    for (const entry of payload?.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        for (const message of value?.messages ?? []) {
          try {
            await this.handleMessage(
              message,
              value?.contacts?.[0]?.profile?.name,
            );
          } catch (err) {
            this.logger.error(
              `[whatsapp] falha ao processar a mensagem ${message.id}: ${String(err)}`,
              err instanceof Error ? err.stack : undefined,
            );
          }
        }
      }
    }
  }

  // Login concluído / pagamento confirmado: só os chats do WhatsApp são deste canal.
  @OnEvent(USER_LOGGED_IN)
  async onUserLoggedIn({ chatId }: UserLoggedIn): Promise<void> {
    await this.notify(
      chatId,
      'Login no iFood feito ✅ Pode mandar seu pedido.',
    );
  }

  @OnEvent(PAYMENT_APPLIED)
  async onPaymentApplied(applied: PaymentApplied): Promise<void> {
    if (applied.ownerChatId === null) return;
    await this.notify(applied.ownerChatId, formatPaymentNotice(applied));
  }

  async sendMessage(
    to: string,
    text: string,
    options: { confirmButtons?: boolean } = {},
  ): Promise<void> {
    this.logger.log(
      `[whatsapp] → ${to}: ${JSON.stringify(text.length > 200 ? `${text.slice(0, 200)}…` : text)}`,
    );
    const chunks = splitByLines(text, CHUNK_SIZE).map(markdownToWhatsapp);
    // Os botões vão logo abaixo do "Responda confirmar...": a última parte vira o corpo deles
    // quando cabe no limite; senão vai como texto e os botões seguem com um corpo curto.
    const last = options.confirmButtons ? chunks.pop() : undefined;
    const buttonBody =
      last !== undefined && last.length <= BUTTON_BODY_MAX ? last : 'Confirma?';
    if (last !== undefined && buttonBody !== last) chunks.push(last);
    for (const chunk of chunks) {
      await this.client.sendText(to, chunk);
    }
    if (options.confirmButtons) {
      await this.client.sendButtons(to, buttonBody, CONFIRM_BUTTONS);
    }
  }

  private async handleMessage(
    message: WhatsappMessage,
    name: string | undefined,
  ): Promise<void> {
    if (!(await this.markProcessed(message.id))) {
      this.logger.log(`[whatsapp] ${message.id} já processada — ignorando`);
      return;
    }
    const text = textOf(message);
    if (text === null) {
      this.logger.log(
        `[whatsapp] ${message.from}: mensagem do tipo ${message.type} ignorada`,
      );
      return;
    }
    this.logger.log(`[whatsapp] ← ${message.from}: ${JSON.stringify(text)}`);
    await this.respond(message.from, message.id, text, name);
  }

  // A Meta reentrega o webhook quando não recebe 200 a tempo: o wamid só é processado uma vez.
  private async markProcessed(messageId: string): Promise<boolean> {
    const inserted = await this.database.db
      .insert(processedEvents)
      .values({ eventId: messageId, type: PROCESSED_TYPE })
      .onConflictDoNothing()
      .returning({ eventId: processedEvents.eventId });
    return inserted.length > 0;
  }

  private async respond(
    waId: string,
    messageId: string,
    text: string,
    name: string | undefined,
  ): Promise<void> {
    try {
      // "digitando..." é só cosmético: se falhar, segue o fluxo.
      await this.client.markReadWithTyping(messageId).catch(() => undefined);
      const chatId = await this.chats.resolve('whatsapp', waId);
      const reply = await this.agent.handleRich(chatId, text, { name });
      await this.sendImages(waId, reply.images);
      await this.sendMessage(waId, reply.text, {
        confirmButtons: reply.awaitingConfirmation,
      });
    } catch (err) {
      this.logger.error(
        `Falha ao processar mensagem de ${waId}: ${String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      await this.sendMessage(
        waId,
        'Desculpe, ocorreu um erro interno. Tente novamente.',
      ).catch(() => undefined);
    }
  }

  // Fotos de pratos/lojas (já validadas pelo agente), uma por mensagem: o WhatsApp não tem álbum.
  // São um complemento do texto: qualquer falha aqui só é logada.
  private async sendImages(to: string, images: ReplyImage[]): Promise<void> {
    for (const image of images) {
      try {
        await this.client.sendImage(to, image.url, image.caption || undefined);
      } catch (err) {
        this.logger.warn(
          `[whatsapp] foto ignorada para ${to} (${image.url}): ${String(err)}`,
        );
      }
    }
  }

  private async notify(chatId: number, text: string): Promise<void> {
    const address = await this.chats.address(chatId);
    if (address?.channel !== 'whatsapp') return;
    try {
      await this.sendMessage(address.externalId, text);
    } catch (err) {
      // Fora da janela de 24h a Cloud API só aceita template aprovado: o aviso se perde.
      const reason =
        err instanceof WhatsappApiError && err.code === OUTSIDE_WINDOW_CODE
          ? 'fora da janela de 24h'
          : String(err);
      this.logger.warn(
        `[whatsapp] aviso não entregue para ${address.externalId}: ${reason}`,
      );
    }
  }
}

function textOf(message: WhatsappMessage): string | null {
  if (message.type === 'text') return message.text?.body ?? null;
  const buttonId = message.interactive?.button_reply?.id;
  if (message.type === 'interactive' && buttonId) {
    return BUTTON_TEXT[buttonId] ?? null;
  }
  return null;
}
