import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import TelegramBot from 'node-telegram-bot-api';
import { AgentService } from '../agent/agent.service.js';
import { AuthService } from '../auth/auth.service.js';
import { markdownToTelegramHtml } from './markdown.js';

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private bot: TelegramBot;

  constructor(
    private readonly agent: AgentService,
    private readonly auth: AuthService,
  ) {}

  onModuleInit(): void {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN não definido no .env');

    this.bot = new TelegramBot(token, { polling: true });
    this.bot.on('message', (msg) => void this.handleMessage(msg));
    this.bot.on('polling_error', (err: Error & { code?: string }) =>
      this.logger.error(
        `[telegram] polling error ${err.code ?? ''}: ${err.message}`,
      ),
    );

    // userId do agent = chat.id do Telegram, então dá para avisar o chat quando o login termina.
    this.auth.onLogin((userId) =>
      this.sendMessage(
        Number(userId),
        'Login no iFood feito ✅ Pode mandar seu pedido.',
      ),
    );

    this.logger.log('Telegram bot iniciado com long polling');
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

    try {
      // "digitando..." é só cosmético: se falhar, segue o fluxo.
      await this.withRetry('sendChatAction', () =>
        this.bot.sendChatAction(chatId, 'typing'),
      ).catch(() => undefined);
      const reply = await this.agent.handle(String(chatId), msg.text);
      await this.sendMessage(chatId, reply);
    } catch (err) {
      this.logger.error(
        `Falha ao processar mensagem do chat ${chatId}: ${String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      await this.sendMessage(
        chatId,
        'Desculpe, ocorreu um erro interno. Tente novamente.',
      ).catch(() => undefined);
    }
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    this.logger.log(
      `[telegram] → chat ${chatId}: ${JSON.stringify(text.length > 200 ? `${text.slice(0, 200)}…` : text)}`,
    );
    for (const chunk of splitByLines(text, CHUNK_SIZE)) {
      try {
        await this.withRetry('sendMessage', () =>
          this.bot.sendMessage(chatId, markdownToTelegramHtml(chunk), {
            parse_mode: 'HTML',
          }),
        );
      } catch (err) {
        if (!isParseEntitiesError(err)) throw err;
        // Telegram rejeita HTML malformado ("can't parse entities"): reenvia como texto puro.
        this.logger.warn(
          `[telegram] HTML recusado para chat ${chatId}, reenviando sem formatação: ${String(err)}`,
        );
        await this.withRetry('sendMessage', () =>
          this.bot.sendMessage(chatId, chunk),
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

function isParseEntitiesError(err: unknown): boolean {
  const { response } = (err ?? {}) as TelegramError;
  return (
    response?.statusCode === 400 &&
    /can't parse entities/i.test(response.body?.description ?? '')
  );
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
