import { McpService, type McpSession } from './mcp.service.js';

describe('McpService (sessões ociosas)', () => {
  const MIN = 60 * 1000;

  it('fecha só as sessões sem uso há mais de 15 minutos', async () => {
    const service = new McpService();
    const sessions = (
      service as unknown as { sessions: Map<number, McpSession> }
    ).sessions;
    const session = (lastUsedAt: number, close: () => Promise<void>) =>
      ({
        token: 't',
        client: { close },
        tools: [],
        confirmTools: new Set(),
        readOnlyTools: new Set(),
        lastUsedAt,
      }) as unknown as McpSession;
    const closeOld = vi.fn().mockResolvedValue(undefined);
    const closeRecent = vi.fn().mockResolvedValue(undefined);
    const old = session(0, closeOld);
    const recent = session(10 * MIN, closeRecent);
    sessions.set(1, old);
    sessions.set(2, recent);

    expect(service.closeIdle(16 * MIN)).toBe(1);

    expect(sessions.has(1)).toBe(false);
    expect(sessions.has(2)).toBe(true);
    expect(closeOld).toHaveBeenCalled();
    expect(closeRecent).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  });
});
