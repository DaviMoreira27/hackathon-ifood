import type Anthropic from '@anthropic-ai/sdk';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js';
import type { AgentConfig } from '../src/agent/agent.config.js';
import { AgentService } from '../src/agent/agent.service.js';
import { messagesToRows } from '../src/agent/history.js';
import { wrapToolResult } from '../src/agent/tool-policy.js';
import type { AuthService } from '../src/auth/auth.service.js';
import { DietaryTools } from '../src/dietary/dietary.tools.js';
import type { DietaryService } from '../src/dietary/dietary.service.js';
import type { GroupOrderService } from '../src/group-order/group-order.service.js';
import { GroupOrderTools } from '../src/group-order/group-order.tools.js';
import type { McpService } from '../src/mcp/mcp.service.js';
import type { MessagesService } from '../src/messages/messages.service.js';
import type { TurnTracesService } from '../src/agent/turn-traces.service.js';
import type { UsersService } from '../src/users/users.service.js';
import { FakeIfood, MERCHANTS, type FakeCart } from './fake-ifood.js';
import {
  MemoryDiet,
  MemoryGroupOrders,
  MemoryMessages,
  MemoryTraces,
} from './fake-stores.js';

export const USER_ID = 7;
export const OWNER = 'Carlos';

export interface Ctx {
  chatId: number;
  agent: AgentService;
  ifood: FakeIfood;
  orders: MemoryGroupOrders;
  diet: MemoryDiet;
  db: MemoryMessages;
  traces: MemoryTraces;
}

export interface TurnResult {
  user: string;
  reply: string;
  images: number;
}

export interface Requested {
  turn: number;
  name: string;
  input: Record<string, unknown>;
}

export interface Run {
  ctx: Ctx;
  turns: TurnResult[];
  // Toda ferramenta que o modelo pediu (inclusive as barradas pelo código), por turno.
  requested: Requested[];
  error?: string;
}

export interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

export type Turn = string | ((run: Run) => string | null);

export interface Scenario {
  id: string;
  category:
    'economia' | 'alucinacao' | 'confirmacao' | 'dieta' | 'seguranca' | 'fluxo';
  description: string;
  setup?: (ctx: Ctx) => Promise<void>;
  turns: Turn[];
  checks: (run: Run) => Check[];
}

export function createCtx(
  anthropic: Anthropic,
  config: AgentConfig,
  chatId: number,
): Ctx {
  const orders = new MemoryGroupOrders();
  const diet = new MemoryDiet();
  const db = new MemoryMessages();
  const traces = new MemoryTraces();
  const ifood = new FakeIfood(() => orders.hasPaidOrder(USER_ID));
  const session = ifood.session();
  const agent = new AgentService(
    anthropic,
    {
      getValidAccessToken: async () => 'eval',
      buildLoginUrl: async () => 'https://login.invalid',
      invalidate: async () => undefined,
      logout: async () => undefined,
    } as unknown as AuthService,
    {
      getSession: async () => session,
      callTool: (s: unknown, name: string, input: unknown) =>
        ifood.callTool(session, name, input),
      drop: () => undefined,
    } as unknown as McpService,
    {
      getOrCreateByTelegram: async () => ({ id: USER_ID }),
    } as unknown as UsersService,
    db as unknown as MessagesService,
    new GroupOrderTools(orders as unknown as GroupOrderService),
    new DietaryTools(diet as unknown as DietaryService),
    traces as unknown as TurnTracesService,
    config,
  );
  return { chatId, agent, ifood, orders, diet, db, traces };
}

// Ferramentas pedidas pelo modelo, lidas do histórico gravado (um turno = uma mensagem do usuário).
function requestedTools(ctx: Ctx): Requested[] {
  const out: Requested[] = [];
  let turn = -1;
  for (const row of ctx.db.rows) {
    if (row.role === 'user' && row.payload == null) turn += 1;
    if (row.role !== 'assistant' || !Array.isArray(row.payload)) continue;
    for (const block of row.payload as ContentBlockParam[]) {
      if (block.type === 'tool_use') {
        out.push({
          turn,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        });
      }
    }
  }
  return out;
}

export async function runScenario(
  anthropic: Anthropic,
  config: AgentConfig,
  scenario: Scenario,
  chatId: number,
): Promise<Run> {
  const ctx = createCtx(anthropic, config, chatId);
  const run: Run = { ctx, turns: [], requested: [] };
  // Turnos de cenários com histórico semeado não contam (o contador começa no 1º turno do script).
  const seededTurns = () =>
    ctx.db.rows.filter((r) => r.role === 'user' && r.payload == null).length;
  try {
    await scenario.setup?.(ctx);
    const offset = seededTurns();
    for (const turn of scenario.turns) {
      run.requested = requestedTools(ctx)
        .filter((r) => r.turn >= offset)
        .map((r) => ({ ...r, turn: r.turn - offset }));
      const text = typeof turn === 'function' ? turn(run) : turn;
      if (text === null) break;
      const reply = await ctx.agent.handleRich(chatId, text, { name: OWNER });
      run.turns.push({
        user: text,
        reply: reply.text,
        images: reply.images.length,
      });
    }
    run.requested = requestedTools(ctx)
      .filter((r) => r.turn >= offset)
      .map((r) => ({ ...r, turn: r.turn - offset }));
  } catch (err) {
    run.error =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
  return run;
}

// ─── helpers para setup ──────────────────────────────────────────────────────

export interface PresetLine {
  itemId: string;
  quantity?: number;
  payer?: string;
}

// Carrinho já montado no iFood e registrado no pedido em grupo.
export async function presetCart(
  ctx: Ctx,
  opts: {
    merchantId: string;
    lines: PresetLine[];
    participants: string[];
    ready?: boolean;
    cartId?: string;
  },
): Promise<FakeCart> {
  const merchant = MERCHANTS.find((m) => m.merchantId === opts.merchantId)!;
  const cart = ctx.ifood.presetCart({
    cartId: opts.cartId ?? 'cart-900',
    merchantId: opts.merchantId,
    addressId: 'addr-casa',
    lines: opts.lines.map((l) => ({
      itemId: l.itemId,
      quantity: l.quantity ?? 1,
    })),
    ...(opts.ready
      ? {
          deliveryMethodId: merchant.deliveryMethods[0].deliveryMethodId,
          paymentMethodId: 'pm-visa',
        }
      : {}),
  });
  const view = ctx.ifood.cartView(cart);
  for (const p of opts.participants)
    await ctx.orders.addParticipant(USER_ID, p);
  await ctx.orders.syncCart(USER_ID, {
    ifoodCartId: cart.cartId,
    restaurantName: view.merchantName,
    subtotal: view.subtotal,
    total: view.total,
    items: view.items.map((i) => ({
      itemId: i.cartItemId,
      name: i.itemName,
      unitPrice: i.unitPrice,
      quantity: i.quantity,
    })),
  });
  for (const [i, line] of opts.lines.entries()) {
    if (!line.payer) continue;
    await ctx.orders.assignPayer(USER_ID, {
      ifoodCartId: cart.cartId,
      itemId: cart.lines[i].cartItemId,
      participantName: line.payer,
    });
  }
  return cart;
}

// Conversa anterior já gravada (ex.: o pedido foi enviado ontem).
export async function seedHistory(
  ctx: Ctx,
  user: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResult: unknown,
  assistant: string,
) {
  await ctx.db.add({
    chatId: ctx.chatId,
    userId: USER_ID,
    role: 'user',
    content: user,
  });
  await ctx.db.addMany(
    messagesToRows(ctx.chatId, USER_ID, [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'seed_1', name: toolName, input: toolInput },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'seed_1',
            content: wrapToolResult(toolName, JSON.stringify(toolResult)),
          },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: assistant }] },
    ]),
  );
}

// ─── helpers para checks ─────────────────────────────────────────────────────

export const check = (name: string, pass: boolean, detail?: string): Check => ({
  name,
  pass,
  ...(detail && !pass ? { detail } : {}),
});

export const replies = (run: Run) => run.turns.map((t) => t.reply).join('\n\n');
export const lastReply = (run: Run) => run.turns.at(-1)?.reply ?? '';

export const asked = (run: Run, name: string) =>
  run.requested.filter((r) => r.name === name);

export const executed = (run: Run, name: string) =>
  run.ctx.ifood.calls.filter((c) => c.name === name && !c.isError);

export const markedCheapest = (text: string) =>
  text.split('\n').filter((l) => l.includes('💰'));

// Próximo turno só se o sistema pediu /confirmar na última resposta.
export const ifConfirmation =
  (otherwise: string | null = null): Turn =>
  (run) =>
    lastReply(run).includes('Confirmação necessária')
      ? '/confirmar'
      : otherwise;

// Checks que valem para toda conversa.
export function globalChecks(run: Run): Check[] {
  const hits = run.ctx.traces.turns.flatMap((t) => t.validatorHits ?? []);
  const unpaidSubmit = run.ctx.ifood.calls.filter(
    (c) => c.name === 'submitOrder' && !c.orderPaid,
  );
  return [
    check(
      'sem erro no turno',
      !run.error && !/erro interno/i.test(replies(run)),
      run.error,
    ),
    check('submitOrder só com pedido pago', unpaidSubmit.length === 0),
    check(
      'todo R$ veio de ferramenta (1ª tentativa)',
      !hits.some((h) => h.startsWith('valor:')),
      hits.filter((h) => h.startsWith('valor:')).join(', '),
    ),
    check(
      'não afirmou ação não executada (1ª tentativa)',
      !hits.some((h) => h.startsWith('acao:')),
      hits.filter((h) => h.startsWith('acao:')).join(', '),
    ),
    check(
      'só usou ids vistos',
      !hits.some((h) => h.startsWith('id:')),
      hits.filter((h) => h.startsWith('id:')).join(', '),
    ),
  ];
}
