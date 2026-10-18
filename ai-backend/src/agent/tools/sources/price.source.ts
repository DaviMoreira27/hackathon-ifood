import type { Tool } from '@anthropic-ai/sdk/resources/messages.js';
import { GroupOrderError } from '../../../group-order/index.js';
import { comparePrices, MAX_OPTIONS } from '../../compare-prices.js';
import { priceFacts } from '../../price-facts.js';
import { wrapToolResult } from '../../tool-envelope.js';
import type { TurnContext } from '../../turn/turn-context.js';
import type {
  ToolCall,
  ToolHandler,
  ToolOutcome,
  ToolSource,
} from '../tool-handler.js';

export const COMPARE_PRICES = 'compare_prices';

export const PRICE_TOOLS: Tool[] = [
  {
    name: COMPARE_PRICES,
    description:
      'Compara opções de pratos/lojas pelo custo real (item + taxa de entrega) e devolve o ranking do mais barato ao mais caro, com o preço do item, a taxa, o total, a economia em relação à opção mais cara, o valor por pessoa e alertas de pedido mínimo/orçamento. Informe só o item_id de cada opção: o sistema lê preço (promocional, se houver), taxa de entrega e pedido mínimo nos resultados de searchOffers, getItem e getMerchant desta conversa. Se faltar algum dado, a ferramenta diz qual consulta fazer. Chame antes de recomendar quando houver 2 ou mais opções e use os valores que ela devolve.',
    input_schema: {
      type: 'object',
      properties: {
        options: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_OPTIONS,
          items: {
            type: 'object',
            properties: {
              item_id: {
                type: 'string',
                description: 'itemId do cardápio, como veio do iFood.',
              },
              quantity: { type: 'integer', minimum: 1, default: 1 },
              delivery_type: {
                type: 'string',
                enum: ['ECONOMIC', 'EXPRESS'],
                description:
                  'Método de entrega a considerar. Sem isso, vale o mais barato da loja.',
              },
            },
            required: ['item_id'],
          },
        },
        people: {
          type: 'integer',
          minimum: 1,
          description: 'Quantas pessoas dividem cada opção (padrão 1).',
        },
        budget_per_person: {
          type: 'number',
          description: 'Orçamento por pessoa em reais, se o usuário informou.',
        },
      },
      required: ['options'],
    },
  },
];

export function isPriceTool(name: string): boolean {
  return name === COMPARE_PRICES;
}

// compare_prices: conta feita pelo código com os preços que as ferramentas devolveram na conversa.
export class PriceSource implements ToolSource {
  handler(name: string): ToolHandler | null {
    if (name !== COMPARE_PRICES) return null;
    return {
      name,
      origin: 'price',
      cartWrite: false,
      execute: async (
        call: ToolCall,
        ctx: TurnContext,
      ): Promise<ToolOutcome> => {
        try {
          return {
            text: wrapToolResult(
              call.name,
              comparePrices(call.rawInput, priceFacts(ctx.messages)),
            ),
            isError: false,
          };
        } catch (err) {
          return {
            text:
              err instanceof GroupOrderError
                ? err.message
                : `Erro interno ao executar ${call.name}.`,
            isError: true,
          };
        }
      },
    };
  }
}
