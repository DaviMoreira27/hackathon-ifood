import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import TelegramBot from 'node-telegram-bot-api';
import { AgentService } from '../agent/agent.service.js';
import type { ReplyImage } from '../agent/images.js';
import {
  PAYMENT_APPLIED,
  USER_LOGGED_IN,
  type UserLoggedIn,
} from '../common/events.js';
import type { PaymentApplied } from '../payments/payments.service.js';
import { markdownToTelegramHtml } from './markdown.js';
import { formatPaymentNotice } from './payment-notice.js';
import { appConfig } from '../config/app-config.js';

// Botões do pedido de confirmação. O toque vira a mesma mensagem que a pessoa digitaria, então
// passa pelas mesmas regras do agente (ação pendente, prazo, uso único).
export const CONFIRM_DATA = 'confirm';
export const CANCEL_DATA = 'cancel';
const CONFIRM_KEYBOARD: TelegramBot.InlineKeyboardMarkup = {
  inline_keyboard: [
    [
      { text: '✅ Confirmar', callback_data: CONFIRM_DATA },
      { text: '❌ Cancelar', callback_data: CANCEL_DATA },
    ],
  ],
};
const BUTTON_TEXT: Record<string, { text: string; toast: string }> = {
  [CONFIRM_DATA]: { text: 'confirmar', toast: 'Confirmado' },
  [CANCEL_DATA]: { text: 'cancelar', toast: 'Cancelado' },
};

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private bot: TelegramBot;

  constructor(private readonly agent: AgentService) {}

  onModuleInit(): void {
    const token = appConfig().telegramBotToken;
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN não definido no .env');

    this.bot = new TelegramBot(token, { polling: true });
    this.bot.on('message', (msg) => void this.handleMessage(msg));
    this.bot.on('callback_query', (query) => void this.handleButton(query));
    this.bot.on('polling_error', (err: Error & { code?: string }) =>
      this.logger.error(
        `[telegram] polling error ${err.code ?? ''}: ${err.message}`,
      ),
    );

    this.logger.log('Telegram bot iniciado com long polling');
  }

  // userId do agent = chat.id do Telegram, então dá para avisar o chat quando o login termina.
  @OnEvent(USER_LOGGED_IN)
  async onUserLoggedIn({ chatId }: UserLoggedIn): Promise<void> {
    await this.sendMessage(
      chatId,
      'Login no iFood feito ✅ Pode mandar seu pedido.',
    );
  }

  // Pagamento confirmado (vindo do RabbitMQ): avisa o dono do pedido no chat dele.
  @OnEvent(PAYMENT_APPLIED)
  async onPaymentApplied(applied: PaymentApplied): Promise<void> {
    if (applied.ownerChatId === null) return;
    await this.sendMessage(applied.ownerChatId, formatPaymentNotice(applied));
  }

  onModuleDestroy(): void {
    void this.bot?.stopPolling();
  }

  private async handleMessage(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    if (!msg.text) {
      this.logger.log(`[telegram] chat ${chatId}: mensagem sem texto ignorada`);
      return;
    }
    this.logger.log(
      `[telegram] ← chat ${chatId} (@${msg.from?.username ?? '-'}): ${JSON.stringify(msg.text)}`,
    );
    await this.respond(chatId, msg.text, msg.from);
  }

  // Toque em ✅/❌: tira os botões (não dá para tocar duas vezes) e segue como se a pessoa tivesse
  // digitado "confirmar" ou "cancelar".
  private async handleButton(query: TelegramBot.CallbackQuery): Promise<void> {
    const button = query.data ? BUTTON_TEXT[query.data] : undefined;
    const message = query.message;
    await this.bot
      .answerCallbackQuery(query.id, button ? { text: button.toast } : {})
      .catch(() => undefined);
    if (!button || !message) return;
    const chatId = message.chat.id;
    this.logger.log(
      `[telegram] ← chat ${chatId} (@${query.from.username ?? '-'}): botão ${JSON.stringify(query.data)}`,
    );
    await this.bot
      .editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: chatId, message_id: message.message_id },
      )
      .catch(() => undefined);
    await this.respond(chatId, button.text, query.from);
  }

  private async respond(
    chatId: number,
    text: string,
    from?: TelegramBot.User,
  ): Promise<void> {
    // "digitando..." é só cosmético: se falhar, segue o fluxo. O Telegram apaga o status depois de
    // ~5s, então ele é reenviado enquanto o agente trabalha.
    const typing = () =>
      void this.bot.sendChatAction(chatId, 'typing').catch(() => undefined);
    const typingTimer = setInterval(typing, TYPING_INTERVAL_MS);
    try {
      await this.withRetry('sendChatAction', () =>
        this.bot.sendChatAction(chatId, 'typing'),
      ).catch(() => undefined);
      const name =
        [from?.first_name, from?.last_name].filter(Boolean).join(' ') ||
        from?.username;
      const reply = await this.agent.handleRich(chatId, text, { name });
      await this.sendPhotos(chatId, reply.images);
      await this.sendMessage(chatId, reply.text, {
        confirmButtons: reply.awaitingConfirmation,
      });
    } catch (err) {
      this.logger.error(
        `Falha ao processar mensagem do chat ${chatId}: ${String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      await this.sendMessage(
        chatId,
        'Desculpe, ocorreu um erro interno. Tente novamente.',
      ).catch(() => undefined);
    } finally {
      clearInterval(typingTimer);
    }
  }

  async sendMessage(
    chatId: number,
    text: string,
    options: { confirmButtons?: boolean } = {},
  ): Promise<void> {
    this.logger.log(
      `[telegram] → chat ${chatId}: ${JSON.stringify(text.length > 200 ? `${text.slice(0, 200)}…` : text)}`,
    );
    const chunks = splitByLines(text, CHUNK_SIZE);
    for (const [index, chunk] of chunks.entries()) {
      // Os botões vão na última parte, logo abaixo do "Responda confirmar...".
      const markup =
        options.confirmButtons && index === chunks.length - 1
          ? { reply_markup: CONFIRM_KEYBOARD }
          : {};
      try {
        await this.withRetry('sendMessage', () =>
          this.bot.sendMessage(chatId, markdownToTelegramHtml(chunk), {
            parse_mode: 'HTML',
            ...markup,
          }),
        );
      } catch (err) {
        if (!isBadRequest(err)) throw err;
        // O Telegram rejeitou o HTML (ex.: "can't parse entities" ou um link que ele não aceita):
        // reenvia como texto puro para a mensagem, e os links, nunca se perderem.
        this.logger.warn(
          `[telegram] HTML recusado para chat ${chatId}, reenviando sem formatação: ${String(err)}`,
        );
        await this.withRetry('sendMessage', () =>
          this.bot.sendMessage(chatId, chunk, markup),
        );
      }
    }
  }

  // Fotos de pratos/lojas (já validadas pelo agente). São um complemento do texto: qualquer falha
  // aqui só é logada. O Telegram baixa cada URL; se uma falhar, o álbum inteiro é recusado, então
  // tenta foto por foto.
  async sendPhotos(chatId: number, images: ReplyImage[]): Promise<void> {
    if (images.length === 0) return;
    if (images.length > 1) {
      try {
        await this.withRetry('sendMediaGroup', () =>
          this.bot.sendMediaGroup(
            chatId,
            images.map((image) => ({
              type: 'photo' as const,
              media: image.url,
              caption: image.caption || undefined,
            })),
          ),
        );
        return;
      } catch (err) {
        this.logger.warn(
          `[telegram] álbum recusado para chat ${chatId}, enviando uma a uma: ${String(err)}`,
        );
      }
    }
    for (const image of images) {
      try {
        await this.withRetry('sendPhoto', () =>
          this.bot.sendPhoto(chatId, image.url, {
            caption: image.caption || undefined,
          }),
        );
      } catch (err) {
        this.logger.warn(
          `[telegram] foto ignorada para chat ${chatId} (${image.url}): ${String(err)}`,
        );
      }
    }
  }

  // Repete chamadas à API do Telegram em falhas de rede (EFATAL: ECONNRESET, timeout...),
  // 429 (respeitando retry_after) e 5xx. Erros 4xx de requisição não são repetidos.
  private async withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const delayMs = retryDelayMs(err, attempt);
        if (delayMs === null || attempt >= MAX_ATTEMPTS) throw err;
        this.logger.warn(
          `[telegram] ${label} falhou (tentativa ${attempt}/${MAX_ATTEMPTS}): ${String(err)} — nova tentativa em ${delayMs}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
}

const MAX_ATTEMPTS = 4;
const TYPING_INTERVAL_MS = 4000;

interface TelegramError {
  code?: string;
  response?: {
    statusCode?: number;
    body?: { description?: string; parameters?: { retry_after?: number } };
  };
}

function retryDelayMs(err: unknown, attempt: number): number | null {
  const { code, response } = (err ?? {}) as TelegramError;
  const backoff = 500 * 2 ** (attempt - 1); // 500ms, 1s, 2s
  if (code === 'EFATAL') return backoff;
  const status = response?.statusCode;
  if (status === 429) {
    return (response?.body?.parameters?.retry_after ?? 1) * 1000;
  }
  if (status !== undefined && status >= 500) return backoff;
  return null;
}

function isBadRequest(err: unknown): boolean {
  const { response } = (err ?? {}) as TelegramError;
  return response?.statusCode === 400;
}

// Limite do Telegram é 4096 chars; deixa folga porque a conversão para HTML aumenta o texto.
const CHUNK_SIZE = 3500;

// Quebra em linhas inteiras para não cortar formatação no meio.
function splitByLines(text: string, max: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= max) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    current = line;
    while (current.length > max) {
      chunks.push(current.slice(0, max));
      current = current.slice(max);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
