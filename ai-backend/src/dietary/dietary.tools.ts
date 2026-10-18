import { Injectable, Logger } from '@nestjs/common';
import type { Tool } from '@anthropic-ai/sdk/resources/messages.js';
import { GroupOrderError } from '../group-order/group-order.errors.js';
import type {
  LocalToolResult,
  Preparation,
  ToolContext,
} from '../group-order/group-order.tools.js';
import {
  CUSTOM_KIND,
  DIET_CATEGORIES,
  KNOWN_KINDS,
  RESTRICTIONS,
  type DietCategory,
} from './dietary.catalog.js';
import {
  checkItems,
  customKind,
  describeRestriction,
  formatVerdicts,
  LIMIT_NOTICE,
  normalizeText,
  personKeyOf,
  type CheckItem,
  type ItemVerdict,
  type SavedRestriction,
} from './dietary.check.js';
import { DietaryService, type NewRestriction } from './dietary.service.js';
import { appConfig } from '../config/app-config.js';

// Filtro de restrição alimentar, ligado só para quem declarou uma restrição. As ferramentas ficam
// sempre na lista (assim o modelo consegue salvar quando o usuário falar), mas a política de uso
// (policyFor) só entra no prompt quando existe restrição salva, e diet_check_items recusa rodar
// sem restrição. A trava do carrinho (prepareMcpCall) é do código: o LLM não decide sozinho
// adicionar um item cortado.

export const DIET_SAVE = 'diet_save_restriction';
export const DIET_REMOVE = 'diet_remove_restriction';
export const DIET_CHECK = 'diet_check_items';

const MAX_ITEMS = 20;
const MAX_CUSTOM_TERMS = 20;
// Vereditos lembrados por usuário (para a trava do carrinho). Em memória: reiniciar o back só
// obriga o modelo a verificar de novo.
const MAX_REMEMBERED = 300;

export const DIET_LIMIT_APPENDIX = `⚠️ **Restrição alimentar:** ${LIMIT_NOTICE} Em caso de alergia, confirme com o restaurante antes de pedir.`;

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

type Input = Record<string, unknown>;

function optionalStr(
  input: Input,
  key: string,
  max: number,
): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max) {
    throw new GroupOrderError(`Campo "${key}" inválido.`);
  }
  // Uma linha só: o nome da pessoa vai para o prompt.
  return value.replace(/\s+/g, ' ').trim() || undefined;
}

function requiredStr(input: Input, key: string, max: number): string {
  const value = optionalStr(input, key, max);
  if (!value) throw new GroupOrderError(`Campo "${key}" ausente ou inválido.`);
  return value;
}

// Só um nome: o modelo já mandou JSON vazado no campo ("você','restaurant':'X"), o que virava uma
// pessoa sem restrição e deixava passar item cortado para o dono.
const PERSON_NAME = /^[\p{L}\p{M}][\p{L}\p{M}' .-]*$/u;

function personStr(input: Input): string | undefined {
  const name = optionalStr(input, 'person', 60);
  if (name !== undefined && !PERSON_NAME.test(name)) {
    throw new GroupOrderError(
      `Campo "person" inválido: ${JSON.stringify(name)}. Use só o nome da pessoa (ex.: "Ana") ou omita quando for o próprio usuário.`,
    );
  }
  return name;
}

function parsePerson(input: Input): { key: string; name: string | null } {
  const name = personStr(input);
  const key = personKeyOf(name);
  return { key, name: key === '' ? null : (name ?? null) };
}

function parseRestriction(raw: unknown): NewRestriction {
  const r = (raw ?? {}) as Input;
  const kind = requiredStr(r, 'kind', 40);
  const category = optionalStr(r, 'category', 20) as DietCategory | undefined;
  if (category && !DIET_CATEGORIES.includes(category)) {
    throw new GroupOrderError(`category inválida: ${category}.`);
  }
  if (kind === CUSTOM_KIND) {
    const label = requiredStr(r, 'label', 40);
    const terms = Array.isArray(r.terms) ? r.terms : [];
    const clean = terms
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.replace(/\s+/g, ' ').trim())
      .filter((t) => t.length > 0 && t.length <= 40 && normalizeText(t));
    if (clean.length === 0 || clean.length > MAX_CUSTOM_TERMS) {
      throw new GroupOrderError(
        `Restrição "${CUSTOM_KIND}" precisa de 1 a ${MAX_CUSTOM_TERMS} terms (ingredientes a evitar).`,
      );
    }
    if (!category) {
      throw new GroupOrderError(
        `Restrição "${CUSTOM_KIND}" precisa de category (${DIET_CATEGORIES.join(', ')}).`,
      );
    }
    return {
      kind: customKind(label),
      label,
      category,
      customTerms: [...new Set(clean)],
    };
  }
  const def = RESTRICTIONS[kind];
  if (!def) {
    throw new GroupOrderError(
      `kind desconhecido: ${kind}. Use um de ${KNOWN_KINDS.join(', ')} ou "${CUSTOM_KIND}".`,
    );
  }
  return {
    kind,
    label: def.label,
    category: category ?? def.category,
    customTerms: [],
  };
}

function parseItems(input: Input): CheckItem[] {
  const items = input.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new GroupOrderError('Informe ao menos um item.');
  }
  if (items.length > MAX_ITEMS) {
    throw new GroupOrderError(`No máximo ${MAX_ITEMS} itens por vez.`);
  }
  return items.map((raw) => {
    const i = (raw ?? {}) as Input;
    return {
      itemId: requiredStr(i, 'item_id', 200),
      label: requiredStr(i, 'name', 200),
      restaurant: optionalStr(i, 'restaurant', 200),
      description:
        typeof i.description === 'string'
          ? i.description.slice(0, 3000)
          : undefined,
      person: personStr(i),
    };
  });
}

// Valores-folha do input de uma ferramenta do MCP: o formato de cada ferramenta não é conhecido,
// então o id do item é procurado entre todos os valores.
function leafValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (typeof value === 'number') out.push(String(value));
  else if (Array.isArray(value)) value.forEach((v) => leafValues(v, out));
  else if (value && typeof value === 'object') {
    Object.values(value).forEach((v) => leafValues(v, out));
  }
  return out;
}

const ok = (text: string, extra: Partial<LocalToolResult> = {}) => ({
  text,
  isError: false,
  ...extra,
});

// Bloco extra de system, só para quem tem restrição salva.
export function policyFor(saved: SavedRestriction[]): string | null {
  if (saved.length === 0) return null;
  return `## Restrições alimentares (ativas para esta conta)
Restrições salvas pelo usuário em conversas anteriores ou nesta:
${saved.map((r) => `- ${describeRestriction(r)}`).join('\n')}

- Antes de sugerir ou adicionar qualquer item, abra-o (getItem) e chame ${DIET_CHECK} com item_id, nome e a descrição exatamente como o iFood devolveu. Em pedido em grupo, informe person em cada item quando souber para quem é.
- Não sugira itens CORTADOS. Itens INCERTOS só com o motivo. Para cada item sugerido, diga em poucas palavras por que passou; para os que cortou, diga o motivo.
- Nunca afirme que um item é "seguro" ou "sem X": diga que "a descrição não menciona X". Em alergia, recomende confirmar com o restaurante.
- O sistema recusa addItemToCart de item não verificado e pede /confirmar ao usuário para item cortado. Não tente contornar.
- Se o usuário corrigir ou retirar uma restrição, use ${DIET_SAVE} / ${DIET_REMOVE}.`;
}

@Injectable()
export class DietaryTools {
  private readonly logger = new Logger(DietaryTools.name);
  private readonly verdicts = new Map<number, Map<string, ItemVerdict>>();

  constructor(private readonly diet: DietaryService) {}

  has(name: string): boolean {
    return name === DIET_SAVE || name === DIET_REMOVE || name === DIET_CHECK;
  }

  list(userId: number): Promise<SavedRestriction[]> {
    return this.diet.list(userId);
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
        case DIET_SAVE: {
          const who = parsePerson(input);
          const raw = input.restrictions;
          if (!Array.isArray(raw) || raw.length === 0 || raw.length > 10) {
            throw new GroupOrderError('Informe de 1 a 10 restrições.');
          }
          const entries = raw.map(parseRestriction);
          await this.diet.save(ctx.userId, who, entries);
          this.verdicts.delete(ctx.userId);
          this.logger.log(
            `[diet] usuário ${ctx.userId} salvou ${entries.map((e) => e.kind).join(', ')}`,
          );
          const saved = await this.diet.list(ctx.userId);
          return ok(
            `Salvo. Restrições ativas agora: ${saved.map(describeRestriction).join('; ')}. A partir de agora confira os itens com ${DIET_CHECK} antes de sugerir ou adicionar.`,
          );
        }

        case DIET_REMOVE: {
          const who = parsePerson(input);
          const kinds = Array.isArray(input.kinds)
            ? input.kinds
                .filter((k): k is string => typeof k === 'string')
                .map((k) => (RESTRICTIONS[k] ? k : customKind(k)))
            : undefined;
          const removed = await this.diet.remove(ctx.userId, who.key, kinds);
          this.verdicts.delete(ctx.userId);
          const saved = await this.diet.list(ctx.userId);
          return ok(
            `${removed} restrição(ões) removida(s). ${saved.length ? `Ainda ativas: ${saved.map(describeRestriction).join('; ')}.` : 'Nenhuma restrição alimentar ativa.'}`,
          );
        }

        case DIET_CHECK: {
          const saved = await this.diet.list(ctx.userId);
          if (saved.length === 0) {
            throw new GroupOrderError(
              `Nenhuma restrição alimentar salva: não há o que conferir. Só use ${DIET_SAVE} se o usuário declarar uma restrição.`,
            );
          }
          const verdicts = checkItems(saved, parseItems(input));
          this.remember(ctx.userId, verdicts);
          const strict = saved.some(
            (r) => r.category === 'alergia' || r.category === 'intolerancia',
          );
          return ok(
            formatVerdicts(saved, verdicts),
            strict ? { appendix: DIET_LIMIT_APPENDIX } : {},
          );
        }

        default:
          return { text: `Ferramenta desconhecida: ${name}`, isError: true };
      }
    } catch (err) {
      if (err instanceof GroupOrderError) {
        return { text: err.message, isError: true };
      }
      this.logger.error(
        `[diet] erro inesperado em ${name}: ${String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      return {
        text: 'Erro interno ao executar a ferramenta. Tente novamente.',
        isError: true,
      };
    }
  }

  isGuardedTool(name: string): boolean {
    return appConfig().mcp.dietGuardedToolPattern.test(name);
  }

  // Trava do carrinho para quem tem restrição: item nunca verificado é recusado; item cortado só
  // entra com /confirmar do usuário (mostrando o motivo do corte).
  async prepareMcpCall(
    ctx: ToolContext,
    name: string,
    input: unknown,
  ): Promise<Preparation> {
    if (!this.isGuardedTool(name)) return { kind: 'run' };
    if ((await this.diet.list(ctx.userId)).length === 0) return { kind: 'run' };
    const known = this.verdicts.get(ctx.userId);
    const hits = leafValues(input)
      .map((v) => known?.get(v))
      .filter((v): v is ItemVerdict => v !== undefined);
    if (hits.length === 0) {
      return {
        kind: 'reject',
        error: `Restrição alimentar ativa: confira este item com ${DIET_CHECK} (o mesmo item_id usado aqui, nome e descrição do getItem) antes de adicioná-lo ao carrinho.`,
      };
    }
    const cut = hits.find((v) => v.verdict === 'cortado');
    if (!cut) return { kind: 'run' };
    return {
      kind: 'confirm',
      summary: [
        `🚫 **${cut.item.label}** foi cortado pelo filtro de restrição alimentar:`,
        ...cut.reasons.map((r) => `• ${r}`),
        'Só confirme se quiser adicionar mesmo assim (ex.: é para outra pessoa).',
      ].join('\n'),
    };
  }

  private remember(userId: number, verdicts: ItemVerdict[]): void {
    const map = this.verdicts.get(userId) ?? new Map<string, ItemVerdict>();
    for (const v of verdicts) {
      map.delete(v.item.itemId);
      map.set(v.item.itemId, v);
    }
    // Map mantém a ordem de inserção: os mais antigos saem primeiro.
    while (map.size > MAX_REMEMBERED) {
      map.delete(map.keys().next().value as string);
    }
    this.verdicts.set(userId, map);
  }
}
