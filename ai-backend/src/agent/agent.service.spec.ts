import type Anthropic from '@anthropic-ai/sdk';
import type { Mock } from 'vitest';
import type { AuthService } from '../auth/auth.service.js';
import { McpUnauthorizedError, type McpService } from '../mcp/mcp.service.js';
import {
  type Message,
  type MessagesService,
  type NewMessage,
  windowStart,
} from '../messages/messages.service.js';
import type { GroupOrderTools } from '../group-order/group-order.tools.js';
import type { DietaryTools } from '../dietary/dietary.tools.js';
import type { UsersService } from '../users/users.service.js';
import { DEFAULT_AGENT_CONFIG } from './agent.config.js';
import { AgentService } from './agent.service.js';
import type { TurnTracesService } from './turn-traces.service.js';
import { messagesToRows } from './history.js';
import { wrapToolResult } from './tool-envelope.js';

// MessagesService em memória, com a mesma semântica de ordem/janela do real.
class FakeMessages {
  rows: Message[] = [];
  facts = new Map<number, { ids: Set<string>; cents: Set<number> }>();
  add = async (row: NewMessage) => {
    const id = this.rows.length + 1;
    this.rows.push({
      id,
      userId: null,
      payload: null,
      createdAt: new Date(),
      ...row,
    } as Message);
    return id;
  };
  addMany = async (rows: NewMessage[]) => {
    for (const row of rows) await this.add(row);
  };
  setPayload = async (id: number, payload: unknown) => {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.payload = payload;
  };
  recent = async (chatId: number, limit: number, step = 1) => {
    const rows = this.rows.filter((r) => r.chatId === chatId);
    return rows.slice(windowStart(rows.length, limit, step));
  };
  seenFacts = async (chatId: number) => {
    const f = this.facts.get(chatId);
    return { ids: [...(f?.ids ?? [])], cents: [...(f?.cents ?? [])] };
  };
  rememberFacts = async (
    chatId: number,
    seen: { ids: string[]; cents: number[] },
  ) => {
    const f = this.facts.get(chatId) ?? { ids: new Set(), cents: new Set() };
    seen.ids.forEach((i) => f.ids.add(i));
    seen.cents.forEach((c) => f.cents.add(c));
    this.facts.set(chatId, f);
  };
  clearChat = async (chatId: number) => {
    this.rows = this.rows.filter((r) => r.chatId !== chatId);
    this.facts.delete(chatId);
  };
}

// Histórico de uma conversa anterior em que uma ferramenta devolveu `result` (ids "vistos").
async function seedToolResult(
  db: FakeMessages,
  chatId: number,
  result: string,
) {
  await db.addMany([
    { chatId, userId: 7, role: 'user', content: 'oi' },
    ...messagesToRows(chatId, 7, [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'seed1', name: 'getItem', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'seed1',
            content: wrapToolResult('getItem', result),
          },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ]),
  ]);
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
  let traces: Record<string, ReturnType<typeof vi.fn>>;
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
    users = { getOrCreateByChat: vi.fn().mockResolvedValue({ id: 7 }) };
    groupTools = {
      has: vi.fn((name: string) => name.startsWith('group_')),
      mergeTools: vi.fn((mcpTools: unknown[]) => [
        ...mcpTools,
        { name: 'group_x' },
      ]),
      checkMcpCall: vi.fn().mockResolvedValue(null),
      execute: vi.fn(),
      prepare: vi.fn().mockResolvedValue({ kind: 'run' }),
      orderView: vi
        .fn()
        .mockResolvedValue({ order: null, awaiting_finalization: [] }),
      syncIfoodCart: vi.fn(),
    };
    traces = { record: vi.fn() };
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
      traces as unknown as TurnTracesService,
      DEFAULT_AGENT_CONFIG,
    );
  });

  it('cria o usuário com o nome do perfil do chat', async () => {
    create.mockResolvedValue(textReply('ok'));

    await agent.handle(CHAT, 'oi', { name: 'Davi' });

    expect(users.getOrCreateByChat).toHaveBeenCalledWith(CHAT, 'Davi');
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
      .mockResolvedValueOnce(textReply('Qual tamanho?'));
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
    // A última mensagem leva o estado do pedido (só na chamada) e o cache_control no último bloco.
    expect(third[4].content).toEqual([
      { type: 'text', text: 'adiciona a primeira' },
      {
        type: 'text',
        text: expect.stringContaining('Nenhum pedido em grupo em andamento'),
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
    it('envia ao LLM as ferramentas do iFood mais as locais', async () => {
      session.tools = [{ name: 'search' }] as never;
      create.mockResolvedValue(textReply('ok'));

      await agent.handle(CHAT, 'oi');

      expect(groupTools.mergeTools).toHaveBeenCalledWith(session.tools);
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
      await seedToolResult(db, CHAT, '{"cartId":"c1"}');

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
        expect(reply).toContain('responda **confirmar**');
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

        create.mockResolvedValueOnce(textReply('Confirmar o quê?'));
        const reply = await agent.handle(CHAT, '/confirmar');

        expect(reply).toBe('Confirmar o quê?');
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
      await seedToolResult(db, CHAT, '{"itemId":"p1"}');

      const first = await agent.handle(CHAT, 'adiciona a pizza');
      expect(mcp.callTool).not.toHaveBeenCalled();
      expect(first).toContain('cita "mussarela"');
      expect(first).toContain('responda **confirmar**');

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
      await seedToolResult(db, CHAT, '{"itemId":"p1"}');

      await agent.handle(CHAT, 'adiciona');

      expect(mcp.callTool).not.toHaveBeenCalled();
      const result = sent[1].at(-1)!.content[0];
      expect(result).toMatchObject({
        is_error: true,
        content: 'confira com diet_check_items',
      });
    });
  });

  describe('robustez', () => {
    it('usa modelo e effort da configuração e manda as ferramentas locais com strict', async () => {
      create.mockResolvedValue(textReply('ok'));

      await agent.handle(CHAT, 'oi');

      const params = create.mock.calls[0][0] as {
        output_config: unknown;
        tools: Array<{ name: string; strict?: boolean }>;
      };
      expect(params).toMatchObject({
        model: DEFAULT_AGENT_CONFIG.model,
        max_tokens: DEFAULT_AGENT_CONFIG.maxTokens,
      });
      expect(params.output_config).toEqual({
        effort: DEFAULT_AGENT_CONFIG.effort,
      });
      const byName = new Map(params.tools.map((t) => [t.name, t]));
      expect(byName.get('group_x')?.strict).toBe(true);
      expect(byName.get('compare_prices')?.strict).toBe(true);
      expect(byName.get('diet_check_items')?.strict).toBe(true);
      expect(byName.get('search_offers')?.strict).toBeUndefined();
    });

    it('lote misto: leituras seguidas em paralelo, escritas em série, resultados na ordem', async () => {
      (session as { readOnlyTools?: Set<string> }).readOnlyTools = new Set([
        'getItem',
      ]);
      session.tools.push({ name: 'getItem' }, { name: 'addItemToCart' });
      await seedToolResult(db, CHAT, '{"cartId":"c1","itemId":"i1"}');
      const use = (id: string, name: string) => ({
        type: 'tool_use',
        id,
        name,
        input: name === 'addItemToCart' ? { cartId: 'c1', itemId: 'i1' } : {},
      });
      create
        .mockResolvedValueOnce({
          stop_reason: 'tool_use',
          content: [
            use('r1', 'getItem'),
            use('r2', 'getItem'),
            use('w1', 'addItemToCart'),
            use('r3', 'getItem'),
          ],
        })
        .mockResolvedValueOnce(textReply('pronto'));
      const log: string[] = [];
      let inFlight = 0;
      let maxInFlight = 0;
      mcp.callTool.mockImplementation(
        async (_s: unknown, name: string, input: unknown) => {
          if (name === 'getCart') return { text: '{}', isError: false };
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          log.push(`start:${name}`);
          await new Promise((r) => setTimeout(r, 5));
          log.push(`end:${name}`);
          inFlight--;
          return { text: JSON.stringify({ name, input }), isError: false };
        },
      );

      await agent.handle(CHAT, 'vai');

      expect(maxInFlight).toBe(2);
      expect(log.slice(0, 2)).toEqual(['start:getItem', 'start:getItem']);
      expect(log.indexOf('start:addItemToCart')).toBeGreaterThan(
        log.lastIndexOf('end:getItem', 3),
      );
      expect(log.at(-2)).toBe('start:getItem');
      const ids = sent[1]
        .at(-1)!
        .content.map((b: { tool_use_id: string }) => b.tool_use_id);
      expect(ids).toEqual(['r1', 'r2', 'w1', 'r3']);
    });

    it('recusa do modelo vira mensagem própria, sem executar nada', async () => {
      create.mockResolvedValue({
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber' },
        content: [
          { type: 'tool_use', id: 'x', name: 'checkout_cart', input: {} },
        ],
      });

      const reply = await agent.handle(CHAT, 'oi');

      expect(reply).toContain('Não posso ajudar com esse pedido');
      expect(mcp.callTool).not.toHaveBeenCalled();
      expect(db.rows.at(-1)).toMatchObject({
        role: 'assistant',
        payload: null,
      });
      expect(traces.record).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'refusal' }),
      );
    });

    describe('sync automático do carrinho', () => {
      const CART = JSON.stringify({
        cartId: 'c1',
        merchantName: 'Pizzaria',
        items: [
          {
            cartItemId: 'ci1',
            itemName: 'Pizza G',
            unitPrice: 40,
            quantity: 1,
          },
        ],
        subtotal: 40,
        total: 47.9,
      });

      beforeEach(async () => {
        session.tools.push({ name: 'addItemToCart' }, {
          name: 'getCart',
          input_schema: {
            type: 'object',
            properties: { cartId: { type: 'string' } },
          },
        } as { name: string });
        await seedToolResult(db, CHAT, '{"cartId":"c1","itemId":"i1"}');
        create
          .mockResolvedValueOnce(
            toolUseReply('a1', 'addItemToCart', { cartId: 'c1', itemId: 'i1' }),
          )
          .mockResolvedValueOnce(textReply('Adicionei a pizza.'));
      });

      it('lê o carrinho e registra no pedido os números do iFood, não os do LLM', async () => {
        mcp.callTool.mockImplementation(async (_s: unknown, name: string) =>
          name === 'getCart'
            ? { text: CART, isError: false }
            : { text: '{"ok":true}', isError: false },
        );
        groupTools.syncIfoodCart.mockResolvedValue({ ifood_cart_id: 'c1' });
        groupTools.orderView
          .mockResolvedValueOnce({ order: null, awaiting_finalization: [] })
          .mockResolvedValueOnce({
            order: { id: 1, status: 'collecting' },
            carts: [
              {
                ifood_cart_id: 'c1',
                restaurant: 'Pizzaria',
                status: 'pending',
                subtotal: 'R$ 40,00',
                total: 'R$ 47,90',
                items: [
                  {
                    item_id: 'ci1',
                    name: 'Pizza G',
                    unit_price: 'R$ 40,00',
                    quantity: 1,
                    payer: null,
                  },
                ],
                payers: [],
              },
            ],
            awaiting_finalization: [],
          });

        const reply = await agent.handle(CHAT, 'adiciona a pizza');

        expect(mcp.callTool).toHaveBeenCalledWith(session, 'getCart', {
          cartId: 'c1',
        });
        expect(groupTools.syncIfoodCart).toHaveBeenCalledWith(
          { chatId: CHAT, userId: 7 },
          {
            ifoodCartId: 'c1',
            restaurantName: 'Pizzaria',
            subtotal: 40,
            total: 47.9,
            items: [
              { itemId: 'ci1', name: 'Pizza G', unitPrice: 40, quantity: 1 },
            ],
          },
        );
        const result = sent[1].at(-1)!.content[0];
        expect(result.content).toContain('sincronizado automaticamente');
        expect(result.content).toContain('total R$ 47,90');
        expect(reply).toBe(
          'Adicionei a pizza.\n\n🧾 **Seu pedido**\n**Pizzaria** — total R$ 47,90\n• 1x Pizza G — R$ 40,00',
        );
      });

      it('várias escritas no mesmo carrinho num lote leem o carrinho uma vez só', async () => {
        create.mockReset();
        create
          .mockResolvedValueOnce({
            stop_reason: 'tool_use',
            content: [
              {
                type: 'tool_use',
                id: 'a1',
                name: 'addItemToCart',
                input: { cartId: 'c1', itemId: 'i1' },
              },
              {
                type: 'tool_use',
                id: 'a2',
                name: 'addItemToCart',
                input: { cartId: 'c1', itemId: 'i1' },
              },
            ],
          })
          .mockResolvedValueOnce(textReply('Adicionei as pizzas.'));
        mcp.callTool.mockImplementation(async (_s: unknown, name: string) =>
          name === 'getCart'
            ? { text: CART, isError: false }
            : { text: '{"ok":true}', isError: false },
        );
        groupTools.syncIfoodCart.mockResolvedValue({ ifood_cart_id: 'c1' });

        await agent.handle(CHAT, 'adiciona duas pizzas');

        const getCarts = mcp.callTool.mock.calls.filter(
          (c) => c[1] === 'getCart',
        );
        expect(getCarts).toHaveLength(1);
        expect(groupTools.syncIfoodCart).toHaveBeenCalledTimes(1);
        const [first, second] = sent[1].at(-1)!.content;
        expect(first.tool_use_id).toBe('a1');
        expect(first.content).toContain('ao final deste lote');
        expect(second.tool_use_id).toBe('a2');
        expect(second.content).toContain('sincronizado automaticamente');
      });

      it('se não reconhece o getCart, manda o LLM usar group_sync_cart', async () => {
        mcp.callTool.mockImplementation(async (_s: unknown, name: string) =>
          name === 'getCart'
            ? { text: '{"formato":"desconhecido"}', isError: false }
            : { text: '{"ok":true}', isError: false },
        );

        const reply = await agent.handle(CHAT, 'adiciona a pizza');

        expect(groupTools.syncIfoodCart).not.toHaveBeenCalled();
        const result = sent[1].at(-1)!.content[0];
        expect(result.is_error).toBe(false);
        expect(result.content).toContain('group_sync_cart');
        expect(reply).toBe('Adicionei a pizza.');
      });
    });

    describe('validador da resposta final', () => {
      beforeEach(() => {
        mcp.callTool.mockResolvedValue({
          text: '{"itemName":"Pizza","unitPrice":42.9}',
          isError: false,
        });
      });

      it('valor sem origem volta ao modelo uma vez para correção', async () => {
        create
          .mockResolvedValueOnce(
            toolUseReply('t1', 'search_offers', { q: 'p' }),
          )
          .mockResolvedValueOnce(textReply('Pizza R$ 42,90, entrega R$ 5,00'))
          .mockResolvedValueOnce(textReply('Pizza R$ 42,90'));

        const reply = await agent.handle(CHAT, 'pizza');

        expect(reply).toBe('Pizza R$ 42,90');
        const correction = sent[2].at(-1)!.content[0].text as string;
        expect(correction).toContain('R$ 5,00');
        expect(correction).not.toContain('R$ 42,90');
        expect(correction).toContain('não mencione esta verificação');
        // Rascunho rejeitado e nota de correção não vão para o histórico.
        const saved = JSON.stringify(db.rows);
        expect(saved).not.toContain('verificação automática');
        expect(saved).not.toContain('entrega R$ 5,00');
        expect(db.rows.at(-1)).toMatchObject({
          role: 'assistant',
          content: 'Pizza R$ 42,90',
        });
        expect(traces.record).toHaveBeenCalledWith(
          expect.objectContaining({ validatorHits: ['valor:R$ 5,00'] }),
        );
      });

      it('se o valor persistir, ele sai da resposta', async () => {
        create
          .mockResolvedValueOnce(
            toolUseReply('t1', 'search_offers', { q: 'p' }),
          )
          .mockResolvedValue(textReply('Pizza R$ 42,90, entrega R$ 5,00'));

        const reply = await agent.handle(CHAT, 'pizza');

        expect(create).toHaveBeenCalledTimes(3);
        expect(reply).toBe('Pizza R$ 42,90, entrega (valor a confirmar)');
      });

      it('"adicionei" sem addItemToCart no turno volta ao modelo', async () => {
        create
          .mockResolvedValueOnce(textReply('Adicionei a pizza!'))
          .mockResolvedValueOnce(textReply('Quer que eu adicione a pizza?'));

        const reply = await agent.handle(CHAT, 'pizza');

        expect(reply).toBe('Quer que eu adicione a pizza?');
        expect(sent[1].at(-1)!.content[0].text).toContain('adicionar item');
      });
    });

    it('resposta sem texto é pedida de novo uma vez, em vez de virar erro interno', async () => {
      create
        .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [] })
        .mockResolvedValueOnce(textReply('Aqui está.'));

      const reply = await agent.handle(CHAT, 'pizza');

      expect(reply).toBe('Aqui está.');
      expect(sent[1].at(-1)!.content[0].text).toContain('sem texto');
      expect(traces.record).toHaveBeenCalledWith(
        expect.objectContaining({ validatorHits: ['vazia:end_turn'] }),
      );
    });

    it('o nome do perfil do chat vai no estado do pedido', async () => {
      create.mockResolvedValue(textReply('ok'));

      await agent.handle(CHAT, 'oi', { name: 'Davi' });

      expect(sent[0].at(-1)!.content.at(-1).text).toContain(
        'Dono da conversa: Davi',
      );
    });

    it('escrita com id que nunca apareceu é recusada antes do MCP', async () => {
      create
        .mockResolvedValueOnce(
          toolUseReply('t1', 'checkout_cart', { cartId: 'inventado' }),
        )
        .mockResolvedValueOnce(textReply('vou consultar'));

      await agent.handle(CHAT, 'finaliza');

      expect(mcp.callTool).not.toHaveBeenCalled();
      expect(groupTools.checkMcpCall).not.toHaveBeenCalled();
      expect(sent[1].at(-1)!.content[0]).toMatchObject({
        is_error: true,
        content: expect.stringContaining('cartId=inventado'),
      });
    });

    it('id visto num turno que já saiu do contexto continua valendo (registro do chat)', async () => {
      session.tools.push({ name: 'getItem' }, { name: 'checkout_cart' });
      mcp.callTool.mockResolvedValue({
        text: '{"cartId":"velho9"}',
        isError: false,
      });
      create
        .mockResolvedValueOnce(toolUseReply('g1', 'getItem', {}))
        .mockResolvedValueOnce(textReply('achei'))
        .mockResolvedValueOnce(textReply('ok 2'))
        .mockResolvedValueOnce(textReply('ok 3'))
        .mockResolvedValueOnce(textReply('ok 4'))
        .mockResolvedValueOnce(
          toolUseReply('w1', 'checkout_cart', { cartId: 'velho9' }),
        )
        .mockResolvedValueOnce(textReply('feito'));

      for (const text of ['busca', 'dois', 'três', 'quatro', 'fecha']) {
        await agent.handle(CHAT, text);
      }

      const lastContext = JSON.stringify(sent[5]);
      expect(lastContext).not.toContain('tool_result');
      expect(mcp.callTool).toHaveBeenLastCalledWith(session, 'checkout_cart', {
        cartId: 'velho9',
      });
    });

    it('o estado do pedido fica gravado junto da mensagem do usuário', async () => {
      create.mockResolvedValue(textReply('oi'));

      await agent.handle(CHAT, 'primeira');
      await agent.handle(CHAT, 'segunda');

      const first = db.rows.find((r) => r.content === 'primeira')!;
      expect(JSON.stringify(first.payload)).toContain('estado_do_pedido');
      // O segundo turno reenvia a primeira mensagem exatamente como foi no primeiro (fora o
      // breakpoint do cache, que fica sempre na última mensagem).
      const withoutCache = (m: unknown) =>
        JSON.parse(
          JSON.stringify(m).replace(/,"cache_control":\{[^}]*\}/g, ''),
        );
      expect(withoutCache(sent[1][0])).toEqual(withoutCache(sent[0][0]));
    });

    it('grava o trace do turno com ferramentas, rodadas e tokens', async () => {
      mcp.callTool.mockResolvedValue({ text: '[]', isError: false });
      create
        .mockResolvedValueOnce({
          ...toolUseReply('t1', 'search_offers', { q: 'p' }),
          usage: { input_tokens: 100, output_tokens: 10 },
        })
        .mockResolvedValueOnce({
          ...textReply('nada'),
          usage: {
            input_tokens: 120,
            output_tokens: 5,
            cache_read_input_tokens: 90,
          },
        });

      await agent.handle(CHAT, 'pizza');

      expect(traces.record).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: CHAT,
          userId: 7,
          outcome: 'reply',
          rounds: 2,
          inputTokens: 220,
          outputTokens: 15,
          cacheReadTokens: 90,
          tools: [{ name: 'search_offers', ok: true, ms: expect.any(Number) }],
          validatorHits: [],
          error: null,
        }),
      );
    });
  });
});
