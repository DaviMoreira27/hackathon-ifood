import {
  CATEGORY_LABEL,
  CUSTOM_KIND,
  RESTRICTIONS,
  type DietCategory,
  type RestrictionDef,
} from './dietary.catalog.js';

// O veredito sai daqui, do código, e não do LLM: ele só copia nome e descrição do item como o
// iFood devolveu e explica o resultado ao usuário. O filtro é conservador (na dúvida, corta ou
// marca incerto), mas só enxerga o que está escrito no cardápio.

export interface SavedRestriction {
  // '' = o próprio usuário (dono da conversa); senão, o nome normalizado da pessoa.
  personKey: string;
  personName: string | null;
  // Chave de RESTRICTIONS ou "outro:<rótulo>" para restrições livres.
  kind: string;
  label: string;
  category: DietCategory;
  customTerms: string[];
}

export interface CheckItem {
  itemId: string;
  label: string;
  restaurant?: string;
  description?: string;
  // Para quem é o item. Sem pessoa, vale toda restrição salva (lado seguro).
  person?: string;
}

export type Verdict = 'cortado' | 'incerto' | 'passou';

export interface ItemVerdict {
  item: CheckItem;
  verdict: Verdict;
  reasons: string[];
}

// Abaixo disso a "descrição" não diz nada sobre ingredientes.
const MIN_DESCRIPTION_CHARS = 15;
const OWNER_ALIASES = new Set([
  '',
  'eu',
  'voce',
  'dono',
  'mim',
  'me',
  'usuario',
]);
const RANK: Record<Verdict, number> = { passou: 0, incerto: 1, cortado: 2 };

export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, ' ')
    .trim();
}

export function personKeyOf(person: string | null | undefined): string {
  const key = normalizeText(person ?? '');
  return OWNER_ALIASES.has(key) ? '' : key;
}

export const whoOf = (r: SavedRestriction) =>
  r.personKey === '' ? 'você' : (r.personName ?? r.personKey);

export function describeRestriction(r: SavedRestriction): string {
  return `${whoOf(r)}: ${r.label} (${CATEGORY_LABEL[r.category]})`;
}

function definitionOf(r: SavedRestriction): RestrictionDef {
  const known = RESTRICTIONS[r.kind];
  if (known) return { ...known, label: r.label, category: r.category };
  return {
    label: r.label,
    category: r.category,
    terms: r.customTerms,
  };
}

// Texto normalizado com espaço nas pontas: a busca vira includes(" termo ").
const padded = (text: string) => ` ${normalizeText(text)} `;

function findPhrase(text: string, phrases: string[] = []): string | undefined {
  for (const phrase of phrases) {
    const p = normalizeText(phrase);
    if (!p) continue;
    if (
      text.includes(` ${p} `) ||
      text.includes(` ${p}s `) ||
      text.includes(` ${p}es `)
    ) {
      return phrase;
    }
  }
  return undefined;
}

function removePhrases(text: string, phrases: string[] = []): string {
  let out = text;
  for (const phrase of phrases) {
    const p = normalizeText(phrase);
    if (!p) continue;
    while (out.includes(` ${p} `)) out = out.replace(` ${p} `, ' ');
  }
  return out;
}

function checkOne(
  item: CheckItem,
  r: SavedRestriction,
): { verdict: Verdict; reason: string } {
  const def = definitionOf(r);
  const tag = `${def.label} — ${whoOf(r)}`;
  const raw = padded(`${item.label} ${item.description ?? ''}`);
  const marker = findPhrase(raw, def.markers);
  const text = removePhrases(raw, [
    ...(def.markers ?? []),
    ...(def.exceptions ?? []),
  ]);

  const term = findPhrase(text, def.terms);
  const combo = def.combos
    ?.map((c) => ({ a: findPhrase(text, c.a), b: findPhrase(text, c.b), c }))
    .find((m) => m.a && m.b);
  if (term || combo) {
    const cited = term
      ? `cita "${term}"`
      : `${combo!.c.reason} ("${combo!.a}" + "${combo!.b}")`;
    return marker
      ? {
          verdict: 'incerto',
          reason: `${cited}, mas a loja declara "${marker}" (${tag}); confirme com a loja`,
        }
      : { verdict: 'cortado', reason: `${cited} (${tag})` };
  }

  const hint = marker ? undefined : findPhrase(text, def.hints);
  if (hint) {
    return def.category === 'alergia'
      ? {
          verdict: 'cortado',
          reason: `"${hint}" costuma levar ${def.label} e a loja não declara o contrário (${tag})`,
        }
      : {
          verdict: 'incerto',
          reason: `"${hint}" costuma levar ${def.label}; a descrição não esclarece (${tag})`,
        };
  }

  const note = def.note ? ` ${def.note}` : '';
  if ((item.description ?? '').trim().length < MIN_DESCRIPTION_CHARS) {
    return {
      verdict: 'incerto',
      reason: `o cardápio não descreve os ingredientes (${tag}).${note}`,
    };
  }
  return {
    verdict: 'passou',
    reason: marker
      ? `a loja declara "${marker}" (${tag}).${note}`
      : `a descrição não menciona ${def.label} (${tag}).${note}`,
  };
}

export function restrictionsFor(
  item: CheckItem,
  saved: SavedRestriction[],
): SavedRestriction[] {
  if (item.person === undefined) return saved;
  const key = personKeyOf(item.person);
  return saved.filter((r) => r.personKey === key);
}

export function checkItems(
  saved: SavedRestriction[],
  items: CheckItem[],
): ItemVerdict[] {
  return items.map((item) => {
    const applicable = restrictionsFor(item, saved);
    if (applicable.length === 0) {
      return {
        item,
        verdict: 'passou',
        reasons: [`${item.person} não tem restrição alimentar salva`],
      };
    }
    const results = applicable.map((r) => checkOne(item, r));
    const worst = results.reduce(
      (acc, r) => (RANK[r.verdict] > acc ? RANK[r.verdict] : acc),
      0,
    );
    const verdict = (Object.keys(RANK) as Verdict[]).find(
      (v) => RANK[v] === worst,
    )!;
    return {
      item,
      verdict,
      reasons: results
        .filter((r) => r.verdict === verdict)
        .map((r) => r.reason),
    };
  });
}

const ICON: Record<Verdict, string> = {
  cortado: '❌ CORTADO',
  incerto: '⚠️ INCERTO',
  passou: '✅ PASSOU',
};

export const LIMIT_NOTICE =
  'O filtro lê só o nome e a descrição do cardápio, que quase nunca listam todos os ingredientes nem contaminação cruzada.';

export function formatVerdicts(
  saved: SavedRestriction[],
  verdicts: ItemVerdict[],
): string {
  const hasAllergy = saved.some(
    (r) => r.category === 'alergia' || r.category === 'intolerancia',
  );
  const lines = [
    `Restrições consideradas: ${saved.map(describeRestriction).join('; ')}`,
    ...verdicts.map((v, i) => {
      const where = v.item.restaurant ? ` (${v.item.restaurant})` : '';
      const forWho = v.item.person ? ` [para ${v.item.person}]` : '';
      return `${i + 1}. ${ICON[v.verdict]} — ${v.item.label}${where}${forWho} [item_id ${v.item.itemId}]: ${v.reasons.join('; ')}`;
    }),
    `Limite: ${LIMIT_NOTICE}${hasAllergy ? ' Há alergia/intolerância: nunca diga que um item é seguro; diga que a descrição não menciona o ingrediente e recomende confirmar com o restaurante.' : ''}`,
    'Não sugira itens CORTADOS. Sugira INCERTOS só com o aviso do motivo. Explique ao usuário por que cada item sugerido passou ou foi cortado.',
  ];
  return lines.join('\n');
}

export function customKind(label: string): string {
  return `${CUSTOM_KIND}:${normalizeText(label).replace(/ /g, '_')}`;
}
