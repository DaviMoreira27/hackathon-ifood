import type Anthropic from '@anthropic-ai/sdk';
import type { Mock } from 'vitest';
import type { AuthService } from '../auth/auth.service.js';
import { McpUnauthorizedError, type McpService } from '../mcp/mcp.service.js';
import type {
  Message,
  MessagesService,
  NewMessage,
} from '../messages/messages.service.js';
import type { GroupOrderTools } from '../group-order/group-order.tools.js';
import type { DietaryTools } from '../dietary/dietary.tools.js';
import type { UsersService } from '../users/users.service.js';
import { AgentService } from './agent.service.js';
import { wrapToolResult } from './tool-policy.js';

// MessagesService em memória, com a mesma semântica de ordem/janela do real.
class FakeMessages {
  rows: Message[] = [];
  add = async (row: NewMessage) => {
    this.rows.push({
      id: this.rows.length + 1,
      userId: null,
      payload: null,
      createdAt: new Date(),
      ...row,
    } as Message);
  };
  addMany = async (rows: NewMessage[]) => {
    for (const row of rows) await this.add(row);
  };
  recent = async (chatId: number, limit: number) =>
    this.rows.filter((r) => r.chatId === chatId).slice(-limit);
  clearChat = async (chatId: number) => {
    this.rows = this.rows.filter((r) => r.chatId !== chatId);
  };
}

const textReply = (text: string) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text }],
});
const toolUseReply = (id: string, name: string, input: unknown) => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id, name, input }],
});

describe('AgentService', () => {
  // Sessão nova a cada teste (alguns testes mudam as ferramentas).
  let session: {
    token: string;
    client: object;
    tools: Array<{ name: string }>;
    confirmTools: Set<string>;
  };
  const CHAT = 42;
  let create: Mock<(params: unknown) => unknown>;
  // Cópia das mensagens no momento de cada chamada (o agent continua mutando o array depois).
  let sent: Array<Array<{ role: string; content: any }>>;
  let auth: Record<string, ReturnType<typeof vi.fn>>;
  let mcp: Record<string, ReturnType<typeof vi.fn>>;
  let users: Record<string, ReturnType<typeof vi.fn>>;
  let groupTools: Record<string, ReturnType<typeof vi.fn>>;
  let dietTools: Record<string, ReturnType<typeof vi.fn>>;
  let db: FakeMessages;
  let agent: AgentService;

  beforeEach(() => {
    session = {
      token: 't',
      client: {},
      tools: [{ name: 'search_offers' }, { name: 'checkout_cart' }],
      confirmTools: new Set<string>(),
    };
    sent = [];
    create = vi.fn<(params: unknown) => unknown>();
    const anthropic = {
      messages: {
        create: (params: { messages: unknown }) => {
          sent.push(structuredClone(params.messages) as (typeof sent)[number]);
          return create(params);
        },
      },
    };
    auth = {
      getValidAccessToken: vi.fn().mockResolvedValue('t'),
      buildLoginUrl: vi.fn().mockReturnValue('https://login'),
      invalidate: vi.fn(),
      logout: vi.fn(),
    };
    mcp = {
      getSession: vi.fn().mockResolvedValue(session),
      callTool: vi.fn(),
      drop: vi.fn(),
    };
    users = { getOrCreateByTelegram: vi.fn().mockResolvedValue({ id: 7 }) };
    groupTools = {
      has: vi.fn((name: string) => name.startsWith('group_')),
      mergeTools: vi.fn((mcpTools: unknown[]) => [
        ...mcpTools,
        { name: 'group_x' },
      ]),
      checkoutAllowed: vi.fn().mockResolvedValue(false),
      checkMcpCall: vi.fn().mockResolvedValue(null),
      execute: vi.fn(),
      prepare: vi.fn().mockResolvedValue({ kind: 'run' }),
    };
    dietTools = {
      has: vi.fn((name: string) => name.startsWith('diet_')),
      list: vi.fn().mockResolvedValue([]),
      execute: vi.fn(),
      prepareMcpCall: vi.fn().mockResolvedValue({ kind: 'run' }),
    };
    db = new FakeMessages();
    agent = new AgentService(
      anthropic as unknown as Anthropic,
      auth as unknown as AuthService,
      mcp as unknown as McpService,
      users as unknown as UsersService,
      db as unknown as MessagesService,
      groupTools as unknown as GroupOrderTools,
      dietTools as unknown as DietaryTools,
    );
  });

  it('cria o usuário com o nome do perfil do Telegram', async () => {
    create.mockResolvedValue(textReply('ok'));

    await agent.handle(CHAT, 'oi', { name: 'Davi' });

    expect(users.getOrCreateByTelegram).toHaveBeenCalledWith(CHAT, 'Davi');
  });

  it('sem token, devolve o link, grava só um marcador e não chama LLM nem MCP', async () => {
    auth.getValidAccessToken.mockResolvedValue(null);

    const reply = await agent.handle(CHAT, 'oi');

    expect(reply).toContain('https://login');
    expect(create).not.toHaveBeenCalled();
    expect(mcp.getSession).not.toHaveBeenCalled();
    expect(db.rows.map((r) => [r.role, r.content])).toEqual([
      ['user', 'oi'],
      ['assistant', '[link de login do iFood enviado]'],
    ]);
  });

  it('roda o loop LLM → MCP → LLM e grava o turno inteiro', async () => {
    create
      .mockResolvedValueOnce(
        toolUseReply('tu1', 'search_offers', { q: 'pizza' }),
      )
      .mockResolvedValueOnce(textReply('Achei 2 opções'));
    mcp.callTool.mockResolvedValue({ text: '[{"loja":"A"}]', isError: false });

    const reply = await agent.handle(CHAT, 'quero uma pizza');

    expect(reply).toBe('Achei 2 opções');
    expect(mcp.callTool).toHaveBeenCalledWith(session, 'search_offers', {
      q: 'pizza',
    });
    // resultado de ferramenta é dado externo: chega ao LLM embrulhado
    const wrapped = wrapToolResult('search_offers', '[{"loja":"A"}]');
    expect(sent[1].at(-1)!.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tu1',
      content: wrapped,
    });
    expect(db.rows.map((r) => [r.role, r.content, r.userId])).toEqual([
      ['user', 'quero uma pizza', 7],
      ['assistant', '[ferramentas: search_offers]', 7],
      ['tool', `search_offers → ${wrapped}`, 7],
      ['assistant', 'Achei 2 opções', 7],
    ]);
  });

  it('o histórico (inclusive tool_use/tool_result) sobrevive entre mensagens', async () => {
    create
      .mockResolvedValueOnce(
        toolUseReply('tu1', 'search_offers', { q: 'pizza' }),
      )
      .mockResolvedValueOnce(textReply('Achei a loja A'))
      .mockResolvedValueOnce(textReply('Adicionei'));
    mcp.callTool.mockResolvedValue({ text: '{"id":"item-9"}', isError: false });

    await agent.handle(CHAT, 'quero uma pizza');
    await agent.handle(CHAT, 'adiciona a primeira');

    const third = sent[2];
    expect(third.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);
    expect(third[1].content[0]).toMatchObject({ type: 'tool_use', id: 'tu1' });
    expect(third[2].content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tu1',
      content: wrapToolResult('search_offers', '{"id":"item-9"}'),
    });
    // A última mensagem vai como bloco com cache_control (prompt caching).
    expect(third[4].content).toEqual([
      {
        type: 'text',
        text: 'adiciona a primeira',
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });

  it('não mistura o histórico de chats diferentes', async () => {
    create.mockResolvedValue(textReply('ok'));

    await agent.handle(1, 'do chat 1');
    await agent.handle(2, 'do chat 2');

    expect(sent[1]).toHaveLength(1);
    expect(sent[1][0].content[0].text).toBe('do chat 2');
  });

  it('em 401 do MCP, invalida o token e pede login de novo', async () => {
    mcp.getSession.mockRejectedValue(new McpUnauthorizedError('401'));

    const reply = await agent.handle(CHAT, 'oi');

    expect(auth.invalidate).toHaveBeenCalledWith(CHAT);
    expect(reply).toContain('https://login');
  });

  it('/logout revoga o token e apaga a conversa do chat', async () => {
    create.mockResolvedValue(textReply('ok'));
    await agent.handle(CHAT, 'oi');
    await agent.handle(99, 'outro chat');

    const reply = await agent.handle(CHAT, '/logout');

    expect(reply).toContain('saiu');
    expect(auth.logout).toHaveBeenCalledWith(CHAT);
    expect(mcp.drop).toHaveBeenCalledWith(CHAT);
    expect(db.rows.every((r) => r.chatId !== CHAT)).toBe(true);
    expect(db.rows.some((r) => r.chatId === 99)).toBe(true);
  });
  describe('ferramentas do pedido em grupo', () => {
    it('envia ao LLM as ferramentas do iFood mais as locais, e informa se o checkout está liberado', async () => {
      session.tools = [{ name: 'search' }] as never;
      groupTools.checkoutAllowed.mockResolvedValue(true);
      create.mockResolvedValue(textReply('ok'));

      await agent.handle(CHAT, 'oi');

      expect(groupTools.checkoutAllowed).toHaveBeenCalledWith(7);
      expect(groupTools.mergeTools).toHaveBeenCalledWith(session.tools, true);
      // + compare_prices e diet_* (locais); a última ferramenta carrega o breakpoint do prompt caching.
      const tools = (create.mock.calls[0][0] as { tools: any[] }).tools;
      expect(tools.map((t) => t.name)).toEqual([
        'search',
        'group_x',
        'compare_prices',
        'diet_save_restriction',
        'diet_remove_restriction',
        'diet_check_items',
      ]);
      expect(tools.at(-1).cache_control).toEqual({ type: 'ephemeral' });
    });

    it('executa a ferramenta local (não o MCP) com o contexto do usuário', async () => {
      create
        .mockResolvedValueOnce(toolUseReply('tu1', 'group_get_order', {}))
        .mockResolvedValueOnce(textReply('Resumo'));
      groupTools.execute.mockResolvedValue({
        text: '{"order":null}',
        isError: false,
      });

      await agent.handle(CHAT, 'como está o pedido?');

      expect(groupTools.execute).toHaveBeenCalledWith(
        'group_get_order',
        {},
        { chatId: CHAT, userId: 7 },
      );
      expect(mcp.callTool).not.toHaveBeenCalled();
      expect(sent[1].at(-1)!.content[0]).toMatchObject({
        tool_use_id: 'tu1',
        content: wrapToolResult('group_get_order', '{"order":null}'),
        is_error: false,
      });
    });

    it('erro de ferramenta local volta ao LLM como is_error', async () => {
      create
        .mockResolvedValueOnce(toolUseReply('tu1', 'group_assign_payer', {}))
        .mockResolvedValueOnce(textReply('Não deu'));
      groupTools.execute.mockResolvedValue({
        text: 'Ana já paga o carrinho X',
        isError: true,
      });

      await agent.handle(CHAT, 'ana paga');

      expect(sent[1].at(-1)!.content[0]).toMatchObject({
        content: wrapToolResult(
          'group_assign_payer',
          'Ana já paga o carrinho X',
        ),
        is_error: true,
      });
    });

    it('anexa à resposta, sem passar pelo LLM, o texto pedido pela ferramenta (links)', async () => {
      create
        .mockResolvedValueOnce(toolUseReply('tu1', 'group_confirm_order', {}))
        .mockResolvedValueOnce(textReply('Pedido confirmado!'));
      groupTools.execute.mockResolvedValue({
        text: '{"confirmed":true}',
        isError: false,
        appendix:
          '**Links**\n• Ana: [abrir pagamento](http://localhost:5173/pay/abc_DEF-1)',
      });

      const reply = await agent.handle(CHAT, 'confirmo');

      expect(reply).toBe(
        'Pedido confirmado!\n\n**Links**\n• Ana: [abrir pagamento](http://localhost:5173/pay/abc_DEF-1)',
      );
      // o link não entra no histórico do LLM
      expect(db.rows.some((r) => r.content.includes('localhost:5173'))).toBe(
        false,
      );
    });

    it('se o LLM responder vazio depois de gerar links, entrega só os links (sem "erro interno")', async () => {
      create
        .mockResolvedValueOnce(toolUseReply('tu1', 'group_confirm_order', {}))
        .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [] });
      groupTools.execute.mockResolvedValue({
        text: '{}',
        isError: false,
        appendix: 'LINKS',
      });

      expect(await agent.handle(CHAT, 'confirmo')).toBe('LINKS');
    });

    it('se estourar o limite de rodadas, os links já gerados não se perdem', async () => {
      create.mockResolvedValue(toolUseReply('tu', 'group_confirm_order', {}));
      groupTools.execute.mockResolvedValue({
        text: '{}',
        isError: false,
        appendix: 'LINKS',
      });

      const reply = await agent.handle(CHAT, 'confirmo');

      expect(reply).toContain('erro interno');
      expect(reply).toContain('LINKS');
    });

    it('chamada ao MCP barrada pela trava (checkout antes de pagar) não chega ao MCP', async () => {
      create
        .mockResolvedValueOnce(
          toolUseReply('tu1', 'checkout_cart', { cartId: 'c1' }),
        )
        .mockResolvedValueOnce(textReply('Ainda não'));
      groupTools.checkMcpCall.mockResolvedValue(
        'Checkout bloqueado: o pedido ainda não foi totalmente pago.',
      );

      await agent.handle(CHAT, 'finaliza');

      expect(groupTools.checkMcpCall).toHaveBeenCalledWith(
        { chatId: CHAT, userId: 7 },
        'checkout_cart',
        { cartId: 'c1' },
      );
      expect(mcp.callTool).not.toHaveBeenCalled();
      expect(sent[1].at(-1)!.content[0]).toMatchObject({
        content: expect.stringContaining('Checkout bloqueado'),
        is_error: true,
      });
    });

    describe('confirmação de group_confirm_order (gate /confirmar)', () => {
      const SUMMARY =
        'Vou gerar uma cobrança para cada pessoa:\n• Ana — R$ 33,75 (Pizzaria)';

      const askToConfirm = async () => {
        create
          .mockResolvedValueOnce(toolUseReply('tu1', 'group_confirm_order', {}))
          .mockResolvedValueOnce(textReply('Vou gerar as cobranças.'));
        groupTools.prepare.mockResolvedValue({
          kind: 'confirm',
          summary: SUMMARY,
        });
        return agent.handle(CHAT, 'pode confirmar');
      };

      it('não executa na hora: o código mostra quanto cada um paga e pede /confirmar', async () => {
        const reply = await askToConfirm();

        expect(groupTools.execute).not.toHaveBeenCalled();
        expect(reply).toContain('Vou gerar as cobranças.');
        expect(reply).toContain('Confirmação necessária');
        expect(reply).toContain('• Ana — R$ 33,75 (Pizzaria)');
        expect(reply).toContain('Responda **confirmar**');
        expect(reply).not.toContain('group_confirm_order');
        expect(reply).not.toContain('{}'); // nada do JSON vazio dos argumentos
        expect(sent[1].at(-1)!.content[0]).toMatchObject({
          is_error: true,
          content: expect.stringContaining('BLOQUEADO'),
        });
      });

      it('/confirmar executa a ação sem o LLM decidir de novo e anexa os links', async () => {
        await askToConfirm();
        create.mockResolvedValueOnce(textReply('Links gerados!'));
        groupTools.execute.mockResolvedValue({
          text: '{"confirmed":true}',
          isError: false,
          appendix: 'LINKS',
        });

        const reply = await agent.handle(CHAT, '/confirmar');

        expect(groupTools.execute).toHaveBeenCalledWith(
          'group_confirm_order',
          {},
          { chatId: CHAT, userId: 7 },
        );
        expect(reply).toBe('Links gerados!\n\nLINKS');
      });

      it('qualquer outra mensagem cancela a confirmação pendente', async () => {
        await askToConfirm();
        create.mockResolvedValueOnce(textReply('Ok, esperando.'));
        await agent.handle(CHAT, 'espera, deixa eu ver');

        const reply = await agent.handle(CHAT, '/confirmar');

        expect(reply).toContain('Não há nenhuma ação aguardando confirmação');
        expect(groupTools.execute).not.toHaveBeenCalled();
      });

      it('pedido que não pode ser confirmado volta ao LLM como erro, sem pedir /confirmar', async () => {
        create
          .mockResolvedValueOnce(toolUseReply('tu1', 'group_confirm_order', {}))
          .mockResolvedValueOnce(textReply('Falta definir quem paga o refri.'));
        groupTools.prepare.mockResolvedValue({
          kind: 'reject',
          error: 'Itens sem pagador: Refri.',
        });

        const reply = await agent.handle(CHAT, 'confirma');

        expect(reply).toBe('Falta definir quem paga o refri.');
        expect(groupTools.execute).not.toHaveBeenCalled();
        expect(sent[1].at(-1)!.content[0]).toMatchObject({
          is_error: true,
          content: wrapToolResult(
            'group_confirm_order',
            'Itens sem pagador: Refri.',
          ),
        });
      });
    });

    it('se o turno falhar depois de gerar os links, eles ainda chegam ao usuário', async () => {
      create
        .mockResolvedValueOnce(toolUseReply('tu1', 'group_confirm_order', {}))
        .mockRejectedValueOnce(new Error('API fora do ar'));
      groupTools.execute.mockResolvedValue({
        text: '{}',
        isError: false,
        appendix: 'LINKS',
      });

      const reply = await agent.handle(CHAT, 'confirmo');

      expect(reply).toContain('erro interno');
      expect(reply).toContain('LINKS');
    });
  });
  describe('restrição alimentar', () => {
    const saved = [
      {
        personKey: '',
        personName: null,
        kind: 'lactose',
        label: 'lactose',
        category: 'intolerancia',
        customTerms: [],
      },
    ];

    it('sem restrição salva, o system tem só o prompt fixo', async () => {
      create.mockResolvedValue(textReply('ok'));

      await agent.handle(CHAT, 'quero uma pizza');

      const { system } = create.mock.calls[0][0] as { system: unknown[] };
      expect(system).toHaveLength(1);
    });

    it('com restrição salva, a política entra num bloco fora do cache', async () => {
      dietTools.list.mockResolvedValue(saved);
      create.mockResolvedValue(textReply('ok'));

      await agent.handle(CHAT, 'quero uma pizza');

      const { system } = create.mock.calls[0][0] as {
        system: Array<{ text: string; cache_control?: unknown }>;
      };
      expect(system).toHaveLength(2);
      expect(system[1].text).toContain('você: lactose (intolerância)');
      expect(system[1].cache_control).toBeUndefined();
    });

    it('relê a política depois de salvar e anexa o aviso de limite uma vez só', async () => {
      dietTools.execute.mockImplementation(async () => {
        dietTools.list.mockResolvedValue(saved);
        return { text: 'Salvo.', isError: false, appendix: 'AVISO' };
      });
      create
        .mockResolvedValueOnce({
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'd1',
              name: 'diet_save_restriction',
              input: {},
            },
            { type: 'tool_use', id: 'd2', name: 'diet_check_items', input: {} },
          ],
        })
        .mockResolvedValueOnce(textReply('anotado'));

      const reply = await agent.handle(CHAT, 'tenho intolerância a lactose');

      const second = create.mock.calls[1][0] as {
        system: Array<{ text: string }>;
      };
      expect(second.system[1].text).toContain('lactose');
      expect(reply).toBe('anotado\n\nAVISO');
      expect(mcp.callTool).not.toHaveBeenCalled();
    });

    it('item cortado pelo filtro só vai ao carrinho depois do /confirmar', async () => {
      session.tools.push({ name: 'addItemToCart' });
      dietTools.prepareMcpCall.mockResolvedValue({
        kind: 'confirm',
        summary: 'Pizza foi cortado: cita "mussarela"',
      });
      mcp.callTool.mockResolvedValue({ text: 'adicionado', isError: false });
      create
        .mockResolvedValueOnce(
          toolUseReply('a1', 'addItemToCart', { itemId: 'p1' }),
        )
        .mockResolvedValueOnce(textReply('preciso da sua confirmação'))
        .mockResolvedValueOnce(textReply('adicionei'));

      const first = await agent.handle(CHAT, 'adiciona a pizza');
      expect(mcp.callTool).not.toHaveBeenCalled();
      expect(first).toContain('cita "mussarela"');
      expect(first).toContain('Responda **confirmar**');

      await agent.handle(CHAT, '/confirmar');
      expect(mcp.callTool).toHaveBeenCalledWith(session, 'addItemToCart', {
        itemId: 'p1',
      });
    });

    it('item recusado pelo filtro não chega ao MCP', async () => {
      session.tools.push({ name: 'addItemToCart' });
      dietTools.prepareMcpCall.mockResolvedValue({
        kind: 'reject',
        error: 'confira com diet_check_items',
      });
      create
        .mockResolvedValueOnce(
          toolUseReply('a1', 'addItemToCart', { itemId: 'p1' }),
        )
        .mockResolvedValueOnce(textReply('vou conferir'));

      await agent.handle(CHAT, 'adiciona');

      expect(mcp.callTool).not.toHaveBeenCalled();
      const result = sent[1].at(-1)!.content[0];
      expect(result).toMatchObject({
        is_error: true,
        content: 'confira com diet_check_items',
      });
    });
  });
});
