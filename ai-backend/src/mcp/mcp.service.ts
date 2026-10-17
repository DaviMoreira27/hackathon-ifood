import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@anthropic-ai/sdk/resources/messages.js';

export class McpUnauthorizedError extends Error {}

const truncate = (s: string, max = 300) =>
  s.length > max ? `${s.slice(0, max)}… (+${s.length - max} chars)` : s;

export interface McpSession {
  token: string;
  client: Client;
  tools: Tool[];
}

export interface McpToolResult {
  text: string;
  isError: boolean;
}

@Injectable()
export class McpService implements OnModuleDestroy {
  private readonly logger = new Logger(McpService.name);
  private readonly sessions = new Map<number, McpSession>();

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled(
      [...this.sessions.values()].map((s) => s.client.close()),
    );
  }

  async getSession(chatId: number, accessToken: string): Promise<McpSession> {
    const cached = this.sessions.get(chatId);
    if (cached?.token === accessToken) {
      this.logger.log(`[mcp] reutilizando sessão do chat ${chatId}`);
      return cached;
    }
    if (cached) {
      this.sessions.delete(chatId);
      await cached.client.close().catch(() => undefined);
    }

    const mcpUrl = process.env.MCP_SERVER_URL;
    if (!mcpUrl) throw new Error('MCP_SERVER_URL não definida');

    const client = new Client({ name: 'ai-backend', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    });

    this.logger.log(`[mcp] conectando em ${mcpUrl} para o chat ${chatId}...`);
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const session: McpSession = {
        token: accessToken,
        client,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description ?? '',
          input_schema: t.inputSchema as Tool['input_schema'],
        })),
      };
      this.sessions.set(chatId, session);
      this.logger.log(
        `[mcp] conectado para o chat ${chatId} — ${session.tools.length} ferramentas: ${session.tools.map((t) => t.name).join(', ')}`,
      );
      return session;
    } catch (err) {
      this.logger.error(
        `[mcp] falha ao conectar para o chat ${chatId}: ${String(err)}`,
      );
      await client.close().catch(() => undefined);
      throw this.mapError(err);
    }
  }

  async callTool(
    session: McpSession,
    name: string,
    input: unknown,
  ): Promise<McpToolResult> {
    const startedAt = Date.now();
    this.logger.log(`[mcp] → ${name} ${truncate(JSON.stringify(input))}`);
    try {
      const result = await session.client.callTool({
        name,
        arguments: input as Record<string, unknown>,
      });
      const content = result.content as Array<{ type: string; text?: string }>;
      const text = content
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('\n');
      const isError = result.isError === true;
      this.logger.log(
        `[mcp] ← ${name} ${isError ? 'ERRO' : 'ok'} (${Date.now() - startedAt}ms) ${truncate(text)}`,
      );
      return { text, isError };
    } catch (err) {
      this.logger.error(`[mcp] ✗ ${name} falhou: ${String(err)}`);
      throw this.mapError(err);
    }
  }

  drop(chatId: number): void {
    const cached = this.sessions.get(chatId);
    this.sessions.delete(chatId);
    void cached?.client.close().catch(() => undefined);
  }

  private mapError(err: unknown): unknown {
    if (err instanceof StreamableHTTPError && err.code === 401) {
      return new McpUnauthorizedError(err.message);
    }
    return err;
  }
}
