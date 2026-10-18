import type { AgentService } from '../agent/agent.service.js';
import type { ChatsService } from '../chats/chats.service.js';
import type { DbService } from '../db/db.service.js';
import type { PaymentApplied } from '../payments/payments.service.js';
import { WhatsappApiError, type WhatsappClient } from './whatsapp.client.js';
import {
  CANCEL_ID,
  CONFIRM_ID,
  WhatsappService,
  type WhatsappMessage,
  type WhatsappWebhook,
} from './whatsapp.service.js';

const WA_ID = '5511999999999';
// chats.id do contato acima.
const INTERNAL = 42;

const webhook = (
  messages: Partial<WhatsappMessage>[],
  name = 'Ana Souza',
): WhatsappWebhook => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          value: {
            contacts: [{ wa_id: WA_ID, profile: { name } }],
            messages: messages.map((m, i) => ({
              id: `wamid.${i}`,
              from: WA_ID,
              type: 'text',
              ...m,
            })),
          },
        },
      ],
    },
  ],
});

// processed_events simulado: insert ... onConflictDoNothing().returning() devolve [] na repetição.
function fakeDatabase() {
  const seen = new Set<string>();
  return {
    db: {
      insert: () => ({
        values: (row: { eventId: string }) => ({
          onConflictDoNothing: () => ({
            returning: () => {
              if (seen.has(row.eventId)) return Promise.resolve([]);
              seen.add(row.eventId);
              return Promise.resolve([{ eventId: row.eventId }]);
            },
          }),
        }),
      }),
    },
  };
}

describe('WhatsappService', () => {
  let agent: { handleRich: ReturnType<typeof vi.fn> };
  let chats: {
    resolve: ReturnType<typeof vi.fn>;
    address: ReturnType<typeof vi.fn>;
  };
  let client: Record<
    'sendText' | 'sendImage' | 'sendButtons' | 'markReadWithTyping',
    ReturnType<typeof vi.fn>
  >;
  let service: WhatsappService;

  beforeEach(() => {
    agent = {
      handleRich: vi.fn().mockResolvedValue({ text: 'oi!', images: [] }),
    };
    chats = {
      resolve: vi.fn().mockResolvedValue(INTERNAL),
      address: vi.fn(),
    };
    client = {
      sendText: vi.fn().mockResolvedValue(undefined),
      sendImage: vi.fn().mockResolvedValue(undefined),
      sendButtons: vi.fn().mockResolvedValue(undefined),
      markReadWithTyping: vi.fn().mockResolvedValue(undefined),
    };
    service = new WhatsappService(
      agent as unknown as AgentService,
      chats as unknown as ChatsService,
      fakeDatabase() as unknown as DbService,
      client as unknown as WhatsappClient,
    );
  });

  it('texto vai ao agente com o chatId interno e o nome do perfil, e a resposta volta', async () => {
    await service.handleWebhook(
      webhook([{ type: 'text', text: { body: 'quero uma pizza' } }]),
    );

    expect(chats.resolve).toHaveBeenCalledWith('whatsapp', WA_ID);
    expect(client.markReadWithTyping).toHaveBeenCalledWith('wamid.0');
    expect(agent.handleRich).toHaveBeenCalledWith(INTERNAL, 'quero uma pizza', {
      name: 'Ana Souza',
    });
    expect(client.sendText).toHaveBeenCalledWith(WA_ID, 'oi!');
    expect(client.sendButtons).not.toHaveBeenCalled();
  });

  it('toque nos botões vira "confirmar" / "cancelar"', async () => {
    await service.handleWebhook(
      webhook([
        {
          type: 'interactive',
          interactive: {
            type: 'button_reply',
            button_reply: { id: CONFIRM_ID, title: 'Confirmar' },
          },
        },
        {
          type: 'interactive',
          interactive: {
            type: 'button_reply',
            button_reply: { id: CANCEL_ID, title: 'Cancelar' },
          },
        },
      ]),
    );

    expect(agent.handleRich.mock.calls.map((c) => c[1])).toEqual([
      'confirmar',
      'cancelar',
    ]);
  });

  it('outros tipos e status de entrega são ignorados', async () => {
    await service.handleWebhook(webhook([{ type: 'image' }]));
    await service.handleWebhook({
      entry: [{ changes: [{ value: { messages: undefined } }] }],
    });

    expect(agent.handleRich).not.toHaveBeenCalled();
    expect(client.sendText).not.toHaveBeenCalled();
  });

  it('webhook reentregue (mesmo wamid) é processado uma vez só', async () => {
    const payload = webhook([{ type: 'text', text: { body: 'oi' } }]);

    await service.handleWebhook(payload);
    await service.handleWebhook(payload);

    expect(agent.handleRich).toHaveBeenCalledTimes(1);
  });

  it('confirmação pendente: a última parte vira o corpo dos botões', async () => {
    agent.handleRich.mockResolvedValue({
      text: '**Total:** R$ 40\nResponda confirmar.',
      images: [],
      awaitingConfirmation: true,
    });

    await service.handleWebhook(webhook([{ text: { body: 'fecha' } }]));

    expect(client.sendText).not.toHaveBeenCalled();
    expect(client.sendButtons).toHaveBeenCalledWith(
      WA_ID,
      '*Total:* R$ 40\nResponda confirmar.',
      [
        { id: CONFIRM_ID, title: 'Confirmar' },
        { id: CANCEL_ID, title: 'Cancelar' },
      ],
    );
  });

  it('confirmação com texto longo: vai como texto e os botões seguem com corpo curto', async () => {
    const long = Array.from(
      { length: 60 },
      (_, i) => `linha ${i} ${'x'.repeat(20)}`,
    ).join('\n');
    agent.handleRich.mockResolvedValue({
      text: long,
      images: [],
      awaitingConfirmation: true,
    });

    await service.handleWebhook(webhook([{ text: { body: 'fecha' } }]));

    expect(client.sendText).toHaveBeenCalledWith(WA_ID, long);
    expect(client.sendButtons).toHaveBeenCalledWith(
      WA_ID,
      'Confirma?',
      expect.any(Array),
    );
  });

  it('envia as fotos uma a uma antes do texto; foto recusada não derruba a resposta', async () => {
    agent.handleRich.mockResolvedValue({
      text: 'opções',
      images: [
        { url: 'https://static.ifood-static.com.br/a.jpg', caption: 'A' },
        { url: 'https://static.ifood-static.com.br/b.jpg', caption: '' },
      ],
    });
    client.sendImage.mockRejectedValueOnce(new Error('url ruim'));

    await service.handleWebhook(webhook([{ text: { body: 'fotos' } }]));

    expect(client.sendImage.mock.calls).toEqual([
      [WA_ID, 'https://static.ifood-static.com.br/a.jpg', 'A'],
      [WA_ID, 'https://static.ifood-static.com.br/b.jpg', undefined],
    ]);
    expect(client.sendText).toHaveBeenCalledWith(WA_ID, 'opções');
  });

  it('erro no agente vira mensagem de erro para o usuário', async () => {
    agent.handleRich.mockRejectedValue(new Error('boom'));

    await service.handleWebhook(webhook([{ text: { body: 'oi' } }]));

    expect(client.sendText).toHaveBeenCalledWith(
      WA_ID,
      'Desculpe, ocorreu um erro interno. Tente novamente.',
    );
  });

  describe('avisos (eventos)', () => {
    const applied = {
      participantName: 'Bia',
      amountCents: 1000,
      restaurantName: null,
      cartPaid: false,
      orderPaid: false,
      pendingParticipants: [],
      ownerChatId: INTERNAL,
    } as unknown as PaymentApplied;

    it('só saem para chats do WhatsApp', async () => {
      chats.address.mockResolvedValue({
        channel: 'telegram',
        externalId: '99',
      });
      await service.onUserLoggedIn({ chatId: INTERNAL });
      await service.onPaymentApplied(applied);
      expect(client.sendText).not.toHaveBeenCalled();

      chats.address.mockResolvedValue({
        channel: 'whatsapp',
        externalId: WA_ID,
      });
      await service.onUserLoggedIn({ chatId: INTERNAL });
      await service.onPaymentApplied(applied);
      expect(client.sendText.mock.calls.map((c) => c[0])).toEqual([
        WA_ID,
        WA_ID,
      ]);
      expect(client.sendText.mock.calls[1][1]).toContain('*Bia* pagou');
    });

    it('fora da janela de 24h a recusa da Meta só é logada', async () => {
      chats.address.mockResolvedValue({
        channel: 'whatsapp',
        externalId: WA_ID,
      });
      client.sendText.mockRejectedValue(
        new WhatsappApiError(400, 131047, 'Re-engagement message'),
      );

      await expect(service.onPaymentApplied(applied)).resolves.toBeUndefined();
    });
  });
});
