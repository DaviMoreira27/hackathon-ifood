import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages.js';

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;
const MAX_TOOL_ROUNDS = 10;

const SYSTEM_PROMPT = `Você é o assistente de pedidos em grupo do iFood.
Seu papel é:
1. Coletar o nome e as preferências de cada participante do grupo
2. Sugerir pratos/restaurantes usando getRecommendations para cada pessoa
3. Montar carrinhos (um por restaurante) com os itens escolhidos
4. Ao final, dividir a conta e gerar QR Codes de pagamento (PIX ou token iFood) para cada participante

Seja proativo: após cada confirmação de item, avance para o próximo participante.
Sempre confirme o resumo dos carrinhos antes de fechar o pedido.
Responda sempre em português brasileiro.`;

@Injectable()
export class AiService implements OnModuleInit {
  private readonly logger = new Logger(AiService.name);
  private readonly anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  private mcpClient: Client;
  private mcpTools: Tool[] = [];

  async onModuleInit(): Promise<void> {
    await this.connectMcp();
  }

  private async connectMcp(): Promise<void> {
    const mcpUrl = process.env.MCP_SERVER_URL;
    if (!mcpUrl) {
      this.logger.warn('MCP_SERVER_URL não definida — ferramentas MCP desabilitadas');
      return;
    }

    try {
      this.mcpClient = new Client({ name: 'ai-backend', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
      await this.mcpClient.connect(transport);

      const { tools } = await this.mcpClient.listTools();
      this.mcpTools = tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        input_schema: t.inputSchema as Tool['input_schema'],
      }));

      this.logger.log(`MCP conectado — ${this.mcpTools.length} ferramentas carregadas`);
    } catch (err) {
      this.logger.error('Falha ao conectar MCP:', err);
    }
  }

  private async callMcpTool(name: string, input: unknown): Promise<string> {
    const result = await this.mcpClient.callTool({ name, arguments: input as Record<string, unknown> });
    const content = result.content as Array<{ type: string; text?: string }>;
    return content
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');
  }

  async chat(userText: string): Promise<string> {
    const messages: MessageParam[] = [{ role: 'user', content: userText }];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await this.anthropic.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        tools: this.mcpTools,
        messages,
      });

      messages.push({ role: 'assistant', content: response.content });

      if (response.stop_reason === 'end_turn') {
        return response.content
          .filter((b) => b.type === 'text')
          .map((b) => (b as { type: 'text'; text: string }).text)
          .join('\n');
      }

      if (response.stop_reason === 'tool_use') {
        const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;
          this.logger.debug(`Chamando ferramenta: ${block.name}`);

          let output: string;
          try {
            output = await this.callMcpTool(block.name, block.input);
          } catch (err) {
            output = `Erro ao executar ${block.name}: ${String(err)}`;
          }

          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: output });
        }

        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      break;
    }

    return 'Desculpe, ocorreu um erro interno. Tente novamente.';
  }
}
