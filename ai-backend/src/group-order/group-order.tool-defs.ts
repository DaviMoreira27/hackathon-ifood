import type { Tool } from '@anthropic-ai/sdk/resources/messages.js';

// Definições das ferramentas group_* que o LLM vê (só dados: o despacho fica em
// group-order.tools.ts).

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
      'problemas a resolver. Um resumo do estado já chega em cada mensagem (estado_do_pedido); use esta ' +
      'ferramenta para os detalhes completos antes de montar o resumo de confirmação e depois de avisos de ' +
      'pagamento. Os valores em R$ já vêm calculados: não refaça contas.',
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
      'RESERVA: o sistema já sincroniza o carrinho sozinho depois de cada alteração. Use somente quando o ' +
      'resultado de uma alteração disser que a sincronização automática falhou. Registra no pedido em grupo ' +
      'um carrinho que existe no iFood, com o carrinho lido por getCart: a lista inteira de itens ' +
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
      'Marca o pedido totalmente pago como finalizado. Chame somente depois de o submitOrder ter dado certo ' +
      'para todos os carrinhos do pedido no iFood.',
    input_schema: schema({
      order_id: {
        type: 'integer',
        description:
          'Obrigatório só se houver mais de um pedido pago aguardando finalização.',
      },
    }),
  },
];

export const GROUP_TOOL_NAMES: ReadonlySet<string> = new Set(
  GROUP_TOOLS.map((t) => t.name),
);
