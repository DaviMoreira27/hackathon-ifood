import type Anthropic from '@anthropic-ai/sdk';
import type { AuthService } from '../auth/auth.service.js';
import { McpUnauthorizedError, type McpService } from '../mcp/mcp.service.js';
import { AgentService } from './agent.service.js';

describe('AgentService', () => {
  const session = { token: 't', client: {}, tools: [] };
  let create: ReturnType<typeof vi.fn>;
  // Cópia das mensagens no momento de cada chamada (o agent continua mutando o array depois).
  let sent: Array<Array<{ content: any }>>;
  let auth: Record<string, ReturnType<typeof vi.fn>>;
  let mcp: Record<string, ReturnType<typeof vi.fn>>;
  let agent: AgentService;

  beforeEach(() => {
    sent = [];
    create = vi.fn();
    const messages = {
      create: (params: { messages: unknown }) => {
        sent.push(structuredClone(params.messages) as Array<{ content: any }>);
        return create(params);
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
    agent = new AgentService(
      { messages } as unknown as Anthropic,
      auth as unknown as AuthService,
      mcp as unknown as McpService,
    );
  });

  it('sem token, devolve o link de login sem chamar LLM nem MCP', async () => {
    auth.getValidAccessToken.mockResolvedValue(null);

    const reply = await agent.handle('42', 'oi');

    expect(reply).toContain('https://login');
    expect(create).not.toHaveBeenCalled();
    expect(mcp.getSession).not.toHaveBeenCalled();
  });

  it('roda o loop LLM → MCP → LLM até receber texto', async () => {
    create
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'tu1',
            name: 'search_offers',
            input: { q: 'pizza' },
          },
        ],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Achei 2 opções' }],
      });
    mcp.callTool.mockResolvedValue({ text: '[{"loja":"A"}]', isError: false });

    const reply = await agent.handle('42', 'quero uma pizza');

    expect(reply).toBe('Achei 2 opções');
    expect(mcp.callTool).toHaveBeenCalledWith(session, 'search_offers', {
      q: 'pizza',
    });
    const secondCall = sent[1];
    expect(secondCall.at(-1).content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tu1',
      content: '[{"loja":"A"}]',
    });
  });

  it('mantém o histórico entre mensagens do mesmo usuário', async () => {
    create.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'ok' }],
    });

    await agent.handle('42', 'primeira');
    await agent.handle('42', 'segunda');

    expect(sent[1].map((m) => m.content)).toEqual([
      'primeira',
      [{ type: 'text', text: 'ok' }],
      'segunda',
    ]);
  });

  it('em 401 do MCP, invalida o token e pede login de novo', async () => {
    mcp.getSession.mockRejectedValue(new McpUnauthorizedError('401'));

    const reply = await agent.handle('42', 'oi');

    expect(auth.invalidate).toHaveBeenCalledWith('42');
    expect(reply).toContain('https://login');
  });
});
