import {
  describeRestriction,
  LIMIT_NOTICE,
  type SavedRestriction,
} from './dietary.check.js';
import { DIET_CHECK, DIET_REMOVE, DIET_SAVE } from './dietary.tool-defs.js';

// O que entra no prompt e na resposta por causa das restrições alimentares.

export const DIET_LIMIT_APPENDIX = `⚠️ **Restrição alimentar:** ${LIMIT_NOTICE} Em caso de alergia, confirme com o restaurante antes de pedir.`;

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
