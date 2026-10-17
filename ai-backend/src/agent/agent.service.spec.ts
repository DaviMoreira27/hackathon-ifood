import type Anthropic from '@anthropic-ai/sdk';
import type { AuthService } from '../auth/auth.service.js';
import { McpUnauthorizedError, type McpService } from '../mcp/mcp.service.js';
import type {
  Message,
  MessagesService,
  NewMessage,
} from '../messages/messages.service.js';
import type { UsersService } from '../users/users.service.js';
import { AgentService } from './agent.service.js';

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
  const session = { token: 't', client: {}, tools: [] };
  const CHAT = 42;
  let create: ReturnType<typeof vi.fn>;
  // Cópia das mensagens no momento de cada chamada (o agent continua mutando o array depois).
  let sent: Array<Array<{ role: string; content: any }>>;
  let auth: Record<string, ReturnType<typeof vi.fn>>;
  let mcp: Record<string, ReturnType<typeof vi.fn>>;
  let users: Record<string, ReturnType<typeof vi.fn>>;
  let db: FakeMessages;
  let agent: AgentService;

  beforeEach(() => {
    sent = [];
    create = vi.fn();
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
    db = new FakeMessages();
    agent = new AgentService(
      anthropic as unknown as Anthropic,
      auth as unknown as AuthService,
      mcp as unknown as McpService,
      users as unknown as UsersService,
      db as unknown as MessagesService,
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
    expect(sent[1].at(-1)!.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tu1',
      content: '[{"loja":"A"}]',
    });
    expect(db.rows.map((r) => [r.role, r.content, r.userId])).toEqual([
      ['user', 'quero uma pizza', 7],
      ['assistant', '[ferramentas: search_offers]', 7],
      ['tool', 'search_offers → [{"loja":"A"}]', 7],
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
      content: '{"id":"item-9"}',
    });
    expect(third[4].content).toBe('adiciona a primeira');
  });

  it('não mistura o histórico de chats diferentes', async () => {
    create.mockResolvedValue(textReply('ok'));

    await agent.handle(1, 'do chat 1');
    await agent.handle(2, 'do chat 2');

    expect(sent[1].map((m) => m.content)).toEqual(['do chat 2']);
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
});
