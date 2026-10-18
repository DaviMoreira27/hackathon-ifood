import {
  CANCEL_DATA,
  CONFIRM_DATA,
  TelegramService,
} from './telegram.service.js';
import type { AgentService } from '../agent/agent.service.js';
import type { ChatsService } from '../chats/chats.service.js';
import type { PaymentApplied } from '../payments/payments.service.js';
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
  editMessageText: vi.fn().mockResolvedValue(true),
  deleteMessage: vi.fn().mockResolvedValue(true),
  stopPolling: vi.fn(),
};

vi.mock('node-telegram-bot-api', () => ({
  default: vi.fn(function () {
    return bot;
  }),
}));

const CHAT = 99;
// chats.id do chat 99 do Telegram.
const INTERNAL = 501;
// O handler do bot dispara sem await: espera a fila de microtasks esvaziar.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('TelegramService (botões de confirmação)', () => {
  let agent: { handleRich: ReturnType<typeof vi.fn> };
  let chats: {
    resolve: ReturnType<typeof vi.fn>;
    address: ReturnType<typeof vi.fn>;
  };
  let service: TelegramService;

  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = 'test';
    resetAppConfig();
    bot.handlers.clear();
    vi.clearAllMocks();
    agent = { handleRich: vi.fn() };
    chats = {
      resolve: vi.fn().mockResolvedValue(INTERNAL),
      address: vi.fn(),
    };
    service = new TelegramService(
      agent as unknown as AgentService,
      chats as unknown as ChatsService,
    );
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
    expect(agent.handleRich).toHaveBeenCalledWith(
      INTERNAL,
      'confirmar',
      {
        name: 'Ana',
      },
      { onProgress: expect.any(Function) },
    );
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

    expect(agent.handleRich).toHaveBeenCalledWith(
      INTERNAL,
      'cancelar',
      {
        name: undefined,
      },
      { onProgress: expect.any(Function) },
    );
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

  it('traduz o chat do Telegram para o chatId interno antes de chamar o agente', async () => {
    agent.handleRich.mockResolvedValue({ text: 'oi', images: [] });

    bot.handlers.get('message')!({ chat: { id: CHAT }, text: 'oi' });
    await flush();

    expect(chats.resolve).toHaveBeenCalledWith('telegram', String(CHAT));
    expect(agent.handleRich).toHaveBeenCalledWith(
      INTERNAL,
      'oi',
      {
        name: undefined,
      },
      { onProgress: expect.any(Function) },
    );
    expect(bot.sendMessage.mock.calls.at(-1)![0]).toBe(CHAT);
  });

  it('mostra a etapa atual numa mensagem editada e a apaga antes da resposta', async () => {
    bot.sendMessage.mockResolvedValueOnce({ message_id: 55 });
    agent.handleRich.mockImplementation(
      async (
        _chat: number,
        _text: string,
        _profile: unknown,
        options: { onProgress: (label: string) => void },
      ) => {
        options.onProgress('Buscando ofertas...');
        options.onProgress('Montando o carrinho...');
        return { text: 'Pronto', images: [] };
      },
    );

    bot.handlers.get('message')!({ chat: { id: CHAT }, text: 'pizza' });
    await flush();

    expect(bot.sendMessage.mock.calls[0]).toEqual([
      CHAT,
      '⏳ Buscando ofertas...',
    ]);
    expect(bot.editMessageText).toHaveBeenCalledWith(
      '⏳ Montando o carrinho...',
      { chat_id: CHAT, message_id: 55 },
    );
    expect(bot.deleteMessage).toHaveBeenCalledWith(CHAT, 55);
    expect(bot.deleteMessage.mock.invocationCallOrder[0]).toBeLessThan(
      bot.sendMessage.mock.invocationCallOrder.at(-1)!,
    );
  });

  it('avisos de login e pagamento só saem para chats do Telegram', async () => {
    const applied = {
      participantName: 'Ana',
      amountCents: 1000,
      restaurantName: null,
      cartPaid: false,
      orderPaid: false,
      pendingParticipants: [],
      ownerChatId: INTERNAL,
    } as unknown as PaymentApplied;

    chats.address.mockResolvedValue({
      channel: 'whatsapp',
      externalId: '5511999999999',
    });
    await service.onUserLoggedIn({ chatId: INTERNAL });
    await service.onPaymentApplied(applied);
    expect(bot.sendMessage).not.toHaveBeenCalled();

    chats.address.mockResolvedValue({
      channel: 'telegram',
      externalId: String(CHAT),
    });
    await service.onUserLoggedIn({ chatId: INTERNAL });
    await service.onPaymentApplied(applied);
    expect(bot.sendMessage.mock.calls.map((c) => c[0])).toEqual([CHAT, CHAT]);
  });
});
