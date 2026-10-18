import type { Tool } from '@anthropic-ai/sdk/resources/messages.js';
import { CUSTOM_KIND, DIET_CATEGORIES, KNOWN_KINDS } from './catalog/index.js';

// Definições das ferramentas diet_* que o LLM vê (só dados: o despacho fica em dietary.tools.ts).

export const DIET_SAVE = 'diet_save_restriction';
export const DIET_REMOVE = 'diet_remove_restriction';
export const DIET_CHECK = 'diet_check_items';

export const MAX_ITEMS = 20;
const person = {
  type: 'string',
  description:
    'Quem tem a restrição/quem vai comer. Omita (ou "eu") quando for o próprio usuário; use o nome para outra pessoa do pedido.',
};

export const DIET_TOOLS: Tool[] = [
  {
    name: DIET_SAVE,
    description:
      'Salva uma restrição alimentar (alergia, intolerância, religião ou dieta) para valer nesta e nas próximas conversas. ' +
      'Chame SOMENTE quando o usuário afirmar explicitamente que ele (ou alguém do pedido) tem a restrição, ' +
      'ex.: "sou celíaco", "tenho alergia a camarão", "a Ana é vegana", "não como porco por religião". ' +
      'Preferência do momento ("hoje não quero carne", "não gosto de cebola") NÃO é restrição: não salve. ' +
      `Para algo fora da lista, use kind "${CUSTOM_KIND}" com label e terms (ingredientes a evitar). ` +
      'Depois, diga ao usuário o que foi salvo e que ele pode pedir para remover.',
    input_schema: {
      type: 'object',
      properties: {
        person,
        restrictions: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: [...KNOWN_KINDS, CUSTOM_KIND] },
              category: {
                type: 'string',
                enum: DIET_CATEGORIES,
                description:
                  'Opcional para os tipos conhecidos (cada um tem um padrão). Obrigatória em "outro".',
              },
              label: {
                type: 'string',
                description: `Nome da restrição (obrigatório em "${CUSTOM_KIND}", ex.: "kiwi").`,
              },
              terms: {
                type: 'array',
                items: { type: 'string' },
                description: `Só em "${CUSTOM_KIND}": ingredientes/palavras a procurar no cardápio.`,
              },
            },
            required: ['kind'],
          },
        },
      },
      required: ['restrictions'],
    },
  },
  {
    name: DIET_REMOVE,
    description:
      'Remove restrições alimentares salvas, quando o usuário pedir ou corrigir (ex.: "não sou mais vegetariano"). ' +
      'Sem kinds, remove todas as restrições da pessoa.',
    input_schema: {
      type: 'object',
      properties: {
        person,
        kinds: {
          type: 'array',
          items: { type: 'string' },
          description: `Tipos a remover (ex.: "lactose") ou o label de uma restrição "${CUSTOM_KIND}".`,
        },
      },
    },
  },
  {
    name: DIET_CHECK,
    description:
      'Confere itens do cardápio contra as restrições alimentares salvas e devolve, para cada item, CORTADO, INCERTO ou PASSOU com o motivo. ' +
      'Só funciona se houver restrição salva. Copie nome e descrição exatamente como o iFood devolveu (getItem/getMerchant), sem resumir. ' +
      'Itens precisam passar por aqui antes de addItemToCart.',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_ITEMS,
          items: {
            type: 'object',
            properties: {
              item_id: {
                type: 'string',
                description:
                  'itemId do cardápio, o mesmo que será usado em addItemToCart.',
              },
              name: { type: 'string' },
              restaurant: { type: 'string' },
              description: {
                type: 'string',
                description:
                  'Descrição completa do item como o iFood informa (vazia se não houver).',
              },
              person: {
                type: 'string',
                description:
                  'Para quem é o item, se souber. Sem pessoa, vale toda restrição salva.',
              },
            },
            required: ['item_id', 'name'],
          },
        },
      },
      required: ['items'],
    },
  },
];
