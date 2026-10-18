import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@anthropic-ai/sdk/resources/messages.js';
import { isReadOnlyTool, requiresConfirmation } from '../agent/tool-policy.js';
import { appConfig } from '../config/app-config.js';

export class McpUnauthorizedError extends Error {}

// A descrição das ferramentas vai direto para o prompt: limita o tamanho para um servidor MCP
// comprometido não conseguir injetar um "manual" inteiro de instruções.
const MAX_TOOL_DESCRIPTION = 1024;

// Sessão sem uso por esse tempo é fechada (cada uma segura uma conexão com o servidor MCP).
const SESSION_IDLE_MS = 15 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
// A lista de ferramentas é a mesma para todos os usuários: lida uma vez e reaproveitada.
const TOOLS_TTL_MS = 10 * 60 * 1000;

type ToolCatalog = Pick<McpSession, 'tools' | 'confirmTools' | 'readOnlyTools'>;

const truncate = (s: string, max = 300) =>
  s.length > max ? `${s.slice(0, max)}… (+${s.length - max} chars)` : s;

export interface McpSession {
  token: string;
  // Último uso (getSession ou callTool), para fechar sessões ociosas.
  lastUsedAt?: number;
  client: Client;
  tools: Tool[];
  // Ferramentas que só rodam depois de /confirmar (ver tool-policy).
  confirmTools: Set<string>;
  // Só leitura: podem rodar em paralelo quando o LLM pede várias no mesmo turno.
  readOnlyTools: Set<string>;
}

export interface McpToolResult {
  text: string;
  isError: boolean;
}

@Injectable()
export class McpService implements OnModuleDestroy {
  private readonly logger = new Logger(McpService.name);
  private readonly sessions = new Map<number, McpSession>();
  private catalog?: { value: ToolCatalog; expiresAt: number };
  private readonly sweeper = setInterval(
    () => this.closeIdle(),
    SWEEP_INTERVAL_MS,
  ).unref();

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.sweeper);
    await Promise.allSettled(
      [...this.sessions.values()].map((s) => s.client.close()),
    );
  }

  // Fecha as sessões sem uso há mais de SESSION_IDLE_MS; a próxima mensagem do chat reconecta.
  closeIdle(now = Date.now()): number {
    let closed = 0;
    for (const [chatId, session] of this.sessions) {
      if (now - (session.lastUsedAt ?? now) < SESSION_IDLE_MS) continue;
      this.sessions.delete(chatId);
      void session.client.close().catch(() => undefined);
      closed++;
    }
    if (closed)
      this.logger.log(`[mcp] ${closed} sessão(ões) ociosa(s) fechada(s)`);
    return closed;
  }

  async getSession(chatId: number, accessToken: string): Promise<McpSession> {
    const cached = this.sessions.get(chatId);
    if (cached?.token === accessToken) {
      this.logger.log(`[mcp] reutilizando sessão do chat ${chatId}`);
      cached.lastUsedAt = Date.now();
      return cached;
    }
    if (cached) {
      this.sessions.delete(chatId);
      await cached.client.close().catch(() => undefined);
    }

    const mcpUrl = appConfig().mcp.serverUrl;
    if (!mcpUrl) throw new Error('MCP_SERVER_URL não definida');

    const client = new Client({ name: 'ai-backend', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    });

    this.logger.log(`[mcp] conectando em ${mcpUrl} para o chat ${chatId}...`);
    try {
      await client.connect(transport);
      const session: McpSession = {
        token: accessToken,
        client,
        lastUsedAt: Date.now(),
        ...(await this.toolCatalog(client)),
      };
      this.sessions.set(chatId, session);
      this.logger.log(
        `[mcp] conectado para o chat ${chatId} — ${session.tools.length} ferramentas: ${session.tools.map((t) => t.name).join(', ')} (exigem confirmação: ${[...session.confirmTools].join(', ') || 'nenhuma'})`,
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
    session.lastUsedAt = startedAt;
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
      // MCP_LOG_RAW=1 registra a saída inteira: serve para descobrir os campos reais (preço,
      // taxa, imagem) de cada ferramenta. Contém dados pessoais: não deixe ligado em produção.
      if (appConfig().mcp.logRaw) {
        this.logger.debug(
          `[mcp] saída crua de ${name}: ${JSON.stringify(result)}`,
        );
      }
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

  private async toolCatalog(client: Client): Promise<ToolCatalog> {
    if (this.catalog && this.catalog.expiresAt > Date.now()) {
      return this.catalog.value;
    }
    const { tools } = await client.listTools();
    const value: ToolCatalog = {
      tools: tools.map((t) => ({
        name: t.name,
        description: (t.description ?? '').slice(0, MAX_TOOL_DESCRIPTION),
        input_schema: t.inputSchema as Tool['input_schema'],
      })),
      confirmTools: new Set(
        tools
          .filter((t) => requiresConfirmation(t.name, t.annotations))
          .map((t) => t.name),
      ),
      readOnlyTools: new Set(
        tools
          .filter((t) => isReadOnlyTool(t.name, t.annotations))
          .map((t) => t.name),
      ),
    };
    this.catalog = { value, expiresAt: Date.now() + TOOLS_TTL_MS };
    return value;
  }

  private mapError(err: unknown): unknown {
    if (err instanceof StreamableHTTPError && err.code === 401) {
      return new McpUnauthorizedError(err.message);
    }
    return err;
  }
}
