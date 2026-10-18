import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';
import type { TraceTool } from '../../db/schema.js';
import type { OrderView } from '../../group-order/group-order.service.js';
import type { ToolContext } from '../../group-order/group-order.tools.js';
import type { McpSession } from '../../mcp/mcp.service.js';
import { FactCorpus, factTexts } from '../reply-check.js';

export const CONFIRM_TTL_MS = 5 * 60 * 1000;

// Ação sensível que o LLM pediu e que só roda, com estes argumentos exatos, depois do /confirmar.
export interface PendingAction {
  name: string;
  input: Record<string, unknown>;
  expiresAt: number;
  // O que o usuário vê no pedido de confirmação (montado pelo código). Sem isso, mostra os argumentos.
  summary?: string;
}

// Estado de um turno (uma mensagem do usuário até a resposta). Cada parte do agente mexe só pelo
// método que lhe cabe: ninguém zera o trace nem troca a ação pendente por fora.
export class TurnContext {
  readonly chatId: number;
  readonly userId: number;
  // Nome do perfil no app de mensagens: o modelo usa como participante quando o dono pede para si.
  readonly ownerName?: string;
  // O que as ferramentas locais recebem (sem o resto do estado do turno).
  readonly tool: ToolContext;
  // Tudo o que veio de ferramentas, do usuário ou do sistema: fonte dos ids e valores aceitos.
  readonly facts = new FactCorpus();

  private mcpSession?: McpSession;
  // Conversa viva (histórico + turno) e o estado do pedido injetado: base dos validadores.
  private conversation: MessageParam[] = [];
  private state = '';
  private pending?: PendingAction;
  // Textos que as ferramentas locais mandam anexar à resposta (links de pagamento): saem do
  // código, não passam pelo LLM, que poderia estragá-los.
  private readonly extra: string[] = [];
  private dietChanged = false;
  private cartChanged = false;
  // Ferramentas que deram certo neste turno (checagem de "disse que fez").
  private readonly ok: string[] = [];
  private readonly tools: TraceTool[] = [];
  private readonly hits: string[] = [];
  // Lido uma vez por turno; group_* e o sync do carrinho invalidam.
  private view?: Promise<OrderView>;

  constructor(
    user: { chatId: number; userId: number; ownerName?: string },
    private readonly loadOrderView: (ctx: ToolContext) => Promise<OrderView>,
  ) {
    this.chatId = user.chatId;
    this.userId = user.userId;
    this.ownerName = user.ownerName;
    this.tool = { chatId: user.chatId, userId: user.userId };
  }

  // Chamado quando a sessão do MCP e o histórico já estão em mãos.
  begin(session: McpSession, messages: MessageParam[]): void {
    this.mcpSession = session;
    this.conversation = messages;
    this.facts.add(...factTexts(messages));
  }

  get session(): McpSession {
    if (!this.mcpSession) throw new Error('turno sem sessão do MCP');
    return this.mcpSession;
  }

  get messages(): MessageParam[] {
    return this.conversation;
  }

  get stateBlock(): string {
    return this.state;
  }

  setStateBlock(block: string): void {
    this.state = block;
    this.facts.add(block);
  }

  orderView(): Promise<OrderView> {
    if (!this.view) {
      const loading = this.loadOrderView(this.tool);
      this.view = loading;
      // Falha não fica memorizada: a próxima leitura tenta de novo.
      loading.catch(() => {
        if (this.view === loading) this.view = undefined;
      });
    }
    return this.view;
  }

  // O pedido mudou no banco: a próxima orderView() relê.
  markOrderChanged(): void {
    this.view = undefined;
  }

  get pendingAction(): PendingAction | undefined {
    return this.pending;
  }

  // Uma ação sensível por turno: a segunda é recusada.
  requestConfirmation(
    action: Omit<PendingAction, 'expiresAt'>,
  ): 'pending' | 'already-pending' {
    if (this.pending) return 'already-pending';
    this.pending = { ...action, expiresAt: Date.now() + CONFIRM_TTL_MS };
    return 'pending';
  }

  get appendices(): readonly string[] {
    return this.extra;
  }

  addAppendix(text: string): void {
    if (!this.extra.includes(text)) this.extra.push(text);
  }

  // Uma ferramenta diet_* rodou: o bloco de restrições do system precisa ser relido.
  markDietChanged(): void {
    this.dietChanged = true;
  }

  takeDietChanged(): boolean {
    const changed = this.dietChanged;
    this.dietChanged = false;
    return changed;
  }

  // O carrinho mudou neste turno: a resposta leva o resumo do pedido montado pelo código.
  markCartChanged(): void {
    this.cartChanged = true;
    this.markOrderChanged();
  }

  get cartWasChanged(): boolean {
    return this.cartChanged;
  }

  recordTool(name: string, ok: boolean, ms: number): void {
    this.tools.push({ name, ok, ms });
    if (ok) this.ok.push(name);
  }

  get succeeded(): readonly string[] {
    return this.ok;
  }

  get trace(): TraceTool[] {
    return [...this.tools];
  }

  recordValidatorHit(...hits: string[]): void {
    this.hits.push(...hits);
  }

  get validatorHits(): string[] {
    return [...this.hits];
  }
}
