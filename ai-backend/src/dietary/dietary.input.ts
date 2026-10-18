import { GroupOrderError } from '../group-order/index.js';
import {
  CUSTOM_KIND,
  DIET_CATEGORIES,
  KNOWN_KINDS,
  RESTRICTIONS,
  type DietCategory,
} from './catalog/index.js';
import {
  customKind,
  normalizeText,
  personKeyOf,
  type CheckItem,
} from './dietary.check.js';
import type { NewRestriction } from './dietary.service.js';
import { MAX_ITEMS } from './dietary.tool-defs.js';

// Leitura dos argumentos que o LLM manda às ferramentas diet_*: campo inválido vira
// GroupOrderError, que volta ao modelo como erro da ferramenta.

export type Input = Record<string, unknown>;

const MAX_CUSTOM_TERMS = 20;

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

export function parsePerson(input: Input): {
  key: string;
  name: string | null;
} {
  const name = personStr(input);
  const key = personKeyOf(name);
  return { key, name: key === '' ? null : (name ?? null) };
}

export function parseRestriction(raw: unknown): NewRestriction {
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

export function parseItems(input: Input): CheckItem[] {
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
export function leafValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (typeof value === 'number') out.push(String(value));
  else if (Array.isArray(value)) value.forEach((v) => leafValues(v, out));
  else if (value && typeof value === 'object') {
    Object.values(value).forEach((v) => leafValues(v, out));
  }
  return out;
}
