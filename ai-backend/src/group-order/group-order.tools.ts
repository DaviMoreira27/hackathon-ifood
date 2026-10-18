import { Injectable, Logger } from '@nestjs/common';
import type { Tool } from '@anthropic-ai/sdk/resources/messages.js';
import { GroupOrderError } from './group-order.errors.js';
import { GroupOrderService } from './group-order.service.js';

export interface ToolContext {
  chatId: number;
  userId: number;
}

export interface LocalToolResult {
  text: string;
  isError: boolean;
  // Texto que o agent anexa, sem alterar, ao fim da resposta ao usuário (ex.: links de
  // pagamento). Evita que o LLM reescreva e estrague um link.
  appendix?: string;
}

type Input = Record<string, unknown>;

// Antes de executar uma ferramenta local o agent pergunta o que fazer:
//   run     → executa direto
//   confirm → ação sensível: só roda depois do /confirmar do usuário; `summary` é o que ele vê
//   reject  → inválida agora; devolve o motivo ao LLM sem incomodar o usuário
export type Preparation =
  | { kind: 'run' }
  | { kind: 'confirm'; summary: string }
  | { kind: 'reject'; error: string };

const schema = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({
  type: 'object' as const,
  properties,
  required,
});

export const GROUP_TOOLS: Tool[] = [
  {
    name: 'group_get_order',
    description:
      'Mostra o estado atual do pedido em grupo: participantes, carrinhos, itens e quem paga cada um, ' +
      'a prévia de quanto cada pessoa paga (já com a divisão das taxas), o status dos pagamentos e ' +
      'problemas a resolver. Use sempre que não tiver certeza do estado, antes de montar o resumo ' +
      'para o usuário e depois de avisos de pagamento. Os valores em R$ já vêm calculados: não refaça contas.',
    input_schema: schema({}),
  },
  {
    name: 'group_add_participant',
    description:
      'Cadastra uma pessoa que vai pagar parte do pedido. Chame uma vez por pessoa antes de definir ' +
      'pagadores. Cadastrar o mesmo nome de novo não duplica.',
    input_schema: schema(
      { name: { type: 'string', description: 'Nome da pessoa.' } },
      ['name'],
    ),
  },
  {
    name: 'group_sync_cart',
    description:
      'Registra no pedido em grupo um carrinho que existe no iFood. Chame DEPOIS de createCart, ' +
      'addItemToCart, updateCartItem ou removeItemFromCart, com o carrinho lido por getCart: a lista inteira de itens ' +
      '(os que faltarem na lista são removidos do registro) e subtotal e total exatamente como o iFood ' +
      'informa. unit_price é o preço unitário FINAL do item (com opcionais), de modo que a soma de ' +
      'unit_price x quantity de todos os itens seja igual ao subtotal. O pagador já definido de um item ' +
      'é mantido. Com items vazio, o carrinho é removido do registro.',
    input_schema: schema(
      {
        ifood_cart_id: {
          type: 'string',
          description:
            'cartId do carrinho no iFood (retornado por createCart).',
        },
        restaurant_name: {
          type: 'string',
          description: 'Nome do restaurante.',
        },
        subtotal: {
          type: 'number',
          description:
            'Subtotal dos itens em reais (ex.: 42.9), como o getCart informa.',
        },
        total: {
          type: 'number',
          description:
            'Total do carrinho em reais, com taxas e descontos (ex.: 47.9).',
        },
        items: {
          type: 'array',
          description: 'Todos os itens do carrinho.',
          items: {
            type: 'object',
            properties: {
              item_id: {
                type: 'string',
                description:
                  'cartItemId da linha no carrinho do iFood (retornado por addItemToCart e por getCart). NÃO é o itemId do cardápio.',
              },
              name: { type: 'string' },
              unit_price: {
                type: 'number',
                description: 'Preço unitário final em reais.',
              },
              quantity: { type: 'integer', minimum: 1 },
            },
            required: ['item_id', 'name', 'unit_price', 'quantity'],
          },
        },
      },
      ['ifood_cart_id', 'restaurant_name', 'subtotal', 'total', 'items'],
    ),
  },
  {
    name: 'group_assign_payer',
    description:
      'Define quem paga um item. Regras que o sistema impõe: cada item tem 1 pagador e cada pessoa ' +
      'paga em no máximo 1 carrinho (se a pessoa já paga outro carrinho, a chamada é recusada). ' +
      'Chamar de novo troca o pagador do item.',
    input_schema: schema(
      {
        ifood_cart_id: { type: 'string' },
        item_id: { type: 'string' },
        participant_name: {
          type: 'string',
          description: 'Nome de um participante já cadastrado.',
        },
      },
      ['ifood_cart_id', 'item_id', 'participant_name'],
    ),
  },
  {
    name: 'group_confirm_order',
    description:
      'Confirma o pedido DEPOIS de o usuário aprovar o resumo: valida tudo, calcula quanto cada ' +
      'pessoa paga e gera um link de pagamento por pessoa. Os links são anexados automaticamente à ' +
      'sua resposta, então NÃO os escreva. Pode ser chamada de novo para reenviar os links.',
    input_schema: schema({}),
  },
  {
    name: 'group_reopen_order',
    description:
      'Volta o pedido confirmado para edição, anulando os links de pagamento. Só funciona se ninguém ' +
      'pagou ainda. Depois de editar, confirme de novo com group_confirm_order (gera links novos).',
    input_schema: schema({}),
  },
  {
    name: 'group_cancel_order',
    description:
      'Cancela o pedido em grupo (anula os links pendentes). Só funciona se ninguém pagou ainda. ' +
      'O próximo uso começa um pedido novo.',
    input_schema: schema({}),
  },
  {
    name: 'group_mark_finalized',
    description:
      'Marca o pedido totalmente pago como finalizado. Chame somente depois de submitOrder ter dado certo ' +
      'dos carrinhos no iFood com sucesso.',
    input_schema: schema({
      order_id: {
        type: 'integer',
        description:
          'Obrigatório só se houver mais de um pedido pago aguardando finalização.',
      },
    }),
  },
];

const TOOL_NAMES = new Set(GROUP_TOOLS.map((t) => t.name));

function str(input: Input, key: string, max = 300): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new GroupOrderError(`Campo "${key}" ausente ou inválido.`);
  }
  return value.trim();
}

function num(input: Input, key: string): number {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new GroupOrderError(
      `Campo "${key}" ausente ou inválido (precisa ser um número em reais).`,
    );
  }
  return value;
}

function parseSyncCart(input: Input) {
  const rawItems = input.items;
  if (!Array.isArray(rawItems) || rawItems.length > 100) {
    throw new GroupOrderError(
      'Campo "items" precisa ser uma lista com até 100 itens.',
    );
  }
  return {
    ifoodCartId: str(input, 'ifood_cart_id', 200),
    restaurantName: str(input, 'restaurant_name', 120),
    subtotal: num(input, 'subtotal'),
    total: num(input, 'total'),
    items: rawItems.map((raw, index) => {
      const item = (raw && typeof raw === 'object' ? raw : {}) as Input;
      const quantity = item.quantity;
      if (
        typeof quantity !== 'number' ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 99
      ) {
        throw new GroupOrderError(
          `items[${index}].quantity deve ser um inteiro de 1 a 99.`,
        );
      }
      return {
        itemId: str(item, 'item_id', 200),
        name: str(item, 'name', 200),
        unitPrice: num(item, 'unit_price'),
        quantity,
      };
    }),
  };
}

const ok = (
  value: unknown,
  extra: Partial<LocalToolResult> = {},
): LocalToolResult => ({
  text: JSON.stringify(value),
  isError: false,
  ...extra,
});

@Injectable()
export class GroupOrderTools {
  private readonly logger = new Logger(GroupOrderTools.name);

  constructor(private readonly orders: GroupOrderService) {}

  readonly definitions: Tool[] = GROUP_TOOLS;

  has(name: string): boolean {
    return TOOL_NAMES.has(name);
  }

  // Ferramentas do iFood + as locais. As locais vencem em caso de nome repetido, e as de
  // checkout ficam escondidas do modelo enquanto não houver pedido totalmente pago.
  mergeTools(mcpTools: Tool[], checkoutAllowed: boolean): Tool[] {
    const visible = mcpTools.filter((tool) => {
      if (TOOL_NAMES.has(tool.name)) {
        this.logger.warn(
          `Ferramenta do MCP "${tool.name}" ignorada: nome reservado pelo pedido em grupo`,
        );
        return false;
      }
      return checkoutAllowed || !this.isCheckoutTool(tool.name);
    });
    return [...visible, ...this.definitions];
  }

  // group_confirm_order gera cobranças para outras pessoas: exige o /confirmar do usuário, e o
  // código (não o LLM) mostra quanto cada um vai pagar. Reenviar links de um pedido já confirmado
  // não cobra nada de novo, então roda direto.
  async prepare(ctx: ToolContext, name: string): Promise<Preparation> {
    if (name !== 'group_confirm_order') return { kind: 'run' };
    try {
      const view = await this.orders.getOrderView(ctx.userId);
      if (!view.order)
        return { kind: 'reject', error: 'Não há pedido em andamento.' };
      if (view.order.status === 'paying') return { kind: 'run' };
      if (view.problems?.length)
        return { kind: 'reject', error: view.problems.join(' ') };
      const preview = view.amounts_preview ?? [];
      if (preview.length === 0) {
        return {
          kind: 'reject',
          error: 'O pedido não tem carrinhos com pagadores definidos.',
        };
      }
      return {
        kind: 'confirm',
        summary: [
          'Vou gerar uma cobrança para cada pessoa:',
          ...preview.map((p) => `• ${p.participant} — ${p.total} (${p.cart})`),
        ].join('\n'),
      };
    } catch (err) {
      this.logger.error(`[group] erro ao preparar ${name}: ${String(err)}`);
      return {
        kind: 'reject',
        error: 'Erro interno ao preparar a confirmação. Tente novamente.',
      };
    }
  }

  checkoutAllowed(userId: number): Promise<boolean> {
    return this.orders.hasPaidOrder(userId);
  }

  isCheckoutTool(name: string): boolean {
    let pattern: RegExp;
    try {
      pattern = new RegExp(
        process.env.MCP_CHECKOUT_TOOL_PATTERN ?? 'submit_?order|checkout',
        'i',
      );
    } catch {
      pattern = /submit_?order|checkout/i;
    }
    return pattern.test(name);
  }

  // Barreira no momento da chamada (o modelo pode alucinar uma ferramenta escondida ou apontar
  // para o carrinho errado). Devolve o motivo do bloqueio, ou null se pode seguir.
  async checkMcpCall(
    ctx: ToolContext,
    name: string,
    input: unknown,
  ): Promise<string | null> {
    if (!this.isCheckoutTool(name)) return null;
    if (!(await this.orders.hasPaidOrder(ctx.userId))) {
      return 'Checkout bloqueado: o pedido ainda não foi totalmente pago. Aguarde todos os pagamentos.';
    }
    // Se a chamada cita um carrinho ainda não pago, bloqueia (não dá para saber o formato do
    // argumento de cada ferramenta, então procuramos os ids conhecidos no JSON inteiro).
    const serialized = JSON.stringify(input ?? {});
    const unpaid = (await this.orders.openIfoodCartIds(ctx.userId)).find((id) =>
      serialized.includes(id),
    );
    if (unpaid) {
      return `Checkout bloqueado: o carrinho ${unpaid} ainda não foi pago. Finalize só os carrinhos listados em awaiting_finalization.`;
    }
    return null;
  }

  async execute(
    name: string,
    rawInput: unknown,
    ctx: ToolContext,
  ): Promise<LocalToolResult> {
    const input = (
      rawInput && typeof rawInput === 'object' ? rawInput : {}
    ) as Input;
    try {
      switch (name) {
        case 'group_get_order':
          return ok(await this.orders.getOrderView(ctx.userId));

        case 'group_add_participant':
          return ok(
            await this.orders.addParticipant(
              ctx.userId,
              str(input, 'name', 60),
            ),
          );

        case 'group_sync_cart':
          return ok(
            await this.orders.syncCart(ctx.userId, parseSyncCart(input)),
          );

        case 'group_assign_payer':
          return ok(
            await this.orders.assignPayer(ctx.userId, {
              ifoodCartId: str(input, 'ifood_cart_id', 200),
              itemId: str(input, 'item_id', 200),
              participantName: str(input, 'participant_name', 60),
            }),
          );

        case 'group_confirm_order': {
          const result = await this.orders.confirmOrder(ctx.userId);
          const lines = result.links.map(
            (l) =>
              `• ${l.participant} — ${l.amount} (${l.restaurant}): [abrir pagamento](${l.url})`,
          );
          const note = [
            result.links.length
              ? 'Os links de pagamento serão anexados automaticamente à sua resposta: NÃO os escreva nem os repita. Diga o valor de cada pessoa e que cada uma deve abrir o seu link.'
              : null,
            result.failed.length
              ? `Não consegui gerar o link de: ${result.failed.join(', ')}. O pedido está confirmado; chame group_confirm_order de novo para tentar outra vez.`
              : null,
          ]
            .filter(Boolean)
            .join(' ');
          return ok(
            {
              confirmed: true,
              already_confirmed: result.alreadyConfirmed,
              payments: result.payments,
              links_attached: result.links.length,
              failed_links: result.failed,
              note,
            },
            lines.length
              ? {
                  appendix: `**Links de pagamento** (cada pessoa abre o seu):\n${lines.join('\n')}`,
                }
              : {},
          );
        }

        case 'group_reopen_order':
          return ok(await this.orders.reopenOrder(ctx.userId));

        case 'group_cancel_order':
          return ok(await this.orders.cancelOrder(ctx.userId));

        case 'group_mark_finalized': {
          const raw = input.order_id;
          if (
            raw !== undefined &&
            raw !== null &&
            (typeof raw !== 'number' || !Number.isInteger(raw))
          ) {
            throw new GroupOrderError('Campo "order_id" deve ser um inteiro.');
          }
          return ok(
            await this.orders.markFinalized(
              ctx.userId,
              (raw as number | undefined) ?? undefined,
            ),
          );
        }

        default:
          return { text: `Ferramenta desconhecida: ${name}`, isError: true };
      }
    } catch (err) {
      if (err instanceof GroupOrderError)
        return { text: err.message, isError: true };
      this.logger.error(
        `[group] erro inesperado em ${name}: ${String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      return {
        text: 'Erro interno ao executar a ferramenta. Tente novamente.',
        isError: true,
      };
    }
  }
}
