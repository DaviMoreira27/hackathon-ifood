import {
  CANCEL_DATA,
  CONFIRM_DATA,
  TelegramService,
} from './telegram.service.js';
import type { AgentService } from '../agent/agent.service.js';
import { resetAppConfig } from '../config/app-config.js';

type Handler = (payload: unknown) => void;

const bot = {
  handlers: new Map<string, Handler>(),
  on: vi.fn((event: string, handler: Handler) =>
    bot.handlers.set(event, handler),
  ),
  sendMessage: vi.fn().mockResolvedValue({}),
  sendChatAction: vi.fn().mockResolvedValue(true),
  answerCallbackQuery: vi.fn().mockResolvedValue(true),
  editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
  stopPolling: vi.fn(),
};

vi.mock('node-telegram-bot-api', () => ({
  default: vi.fn(function () {
    return bot;
  }),
}));

const CHAT = 99;
// O handler do bot dispara sem await: espera a fila de microtasks esvaziar.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('TelegramService (botões de confirmação)', () => {
  let agent: { handleRich: ReturnType<typeof vi.fn> };
  let service: TelegramService;

  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = 'test';
    resetAppConfig();
    bot.handlers.clear();
    vi.clearAllMocks();
    agent = { handleRich: vi.fn() };
    service = new TelegramService(agent as unknown as AgentService);
    service.onModuleInit();
  });

  const keyboardOf = (call: unknown[]) =>
    (
      call[2] as {
        reply_markup?: { inline_keyboard: { callback_data: string }[][] };
      }
    )?.reply_markup?.inline_keyboard;

  it('mostra ✅/❌ quando a resposta deixou uma ação esperando confirmação', async () => {
    agent.handleRich.mockResolvedValue({
      text: 'Confirmação necessária',
      images: [],
      awaitingConfirmation: true,
    });

    bot.handlers.get('message')!({
      chat: { id: CHAT },
      text: 'fecha o pedido',
    });
    await flush();

    const keyboard = keyboardOf(bot.sendMessage.mock.calls.at(-1)!);
    expect(keyboard?.[0].map((b) => b.callback_data)).toEqual([
      CONFIRM_DATA,
      CANCEL_DATA,
    ]);
  });

  it('resposta comum vai sem botões', async () => {
    agent.handleRich.mockResolvedValue({ text: 'oi', images: [] });

    bot.handlers.get('message')!({ chat: { id: CHAT }, text: 'oi' });
    await flush();

    expect(keyboardOf(bot.sendMessage.mock.calls.at(-1)!)).toBeUndefined();
  });

  it('tocar em Confirmar tira os botões e manda "confirmar" ao agente', async () => {
    agent.handleRich.mockResolvedValue({ text: 'Pedido feito!', images: [] });

    bot.handlers.get('callback_query')!({
      id: 'q1',
      data: CONFIRM_DATA,
      from: { id: 1, first_name: 'Ana' },
      message: { chat: { id: CHAT }, message_id: 7 },
    });
    await flush();

    expect(bot.answerCallbackQuery).toHaveBeenCalledWith('q1', {
      text: 'Confirmado',
    });
    expect(bot.editMessageReplyMarkup).toHaveBeenCalledWith(
      { inline_keyboard: [] },
      { chat_id: CHAT, message_id: 7 },
    );
    expect(agent.handleRich).toHaveBeenCalledWith(CHAT, 'confirmar', {
      name: 'Ana',
    });
  });

  it('tocar em Cancelar manda "cancelar" (qualquer outra mensagem cancela a ação)', async () => {
    agent.handleRich.mockResolvedValue({ text: 'Ok, cancelei.', images: [] });

    bot.handlers.get('callback_query')!({
      id: 'q2',
      data: CANCEL_DATA,
      from: { id: 1 },
      message: { chat: { id: CHAT }, message_id: 8 },
    });
    await flush();

    expect(agent.handleRich).toHaveBeenCalledWith(CHAT, 'cancelar', {
      name: undefined,
    });
  });

  it('botão desconhecido só responde ao Telegram e não fala com o agente', async () => {
    bot.handlers.get('callback_query')!({
      id: 'q3',
      data: 'outra-coisa',
      from: { id: 1 },
      message: { chat: { id: CHAT }, message_id: 9 },
    });
    await flush();

    expect(bot.answerCallbackQuery).toHaveBeenCalledWith('q3', {});
    expect(agent.handleRich).not.toHaveBeenCalled();
  });
});
