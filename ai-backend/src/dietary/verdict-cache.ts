import type { ItemVerdict } from './dietary.check.js';

// Vereditos lembrados por usuário (para a trava do carrinho). Em memória: reiniciar o back só
// obriga o modelo a verificar de novo.
const MAX_REMEMBERED = 300;

// Últimos vereditos do diet_check_items por usuário, por item_id (a trava do carrinho consulta
// aqui). Map mantém a ordem de inserção: os mais antigos saem primeiro.
export class VerdictCache {
  private readonly byUser = new Map<number, Map<string, ItemVerdict>>();

  get(userId: number, itemId: string): ItemVerdict | undefined {
    return this.byUser.get(userId)?.get(itemId);
  }

  remember(userId: number, verdicts: ItemVerdict[]): void {
    const map = this.byUser.get(userId) ?? new Map<string, ItemVerdict>();
    for (const v of verdicts) {
      map.delete(v.item.itemId);
      map.set(v.item.itemId, v);
    }
    while (map.size > MAX_REMEMBERED) {
      map.delete(map.keys().next().value as string);
    }
    this.byUser.set(userId, map);
  }

  clear(userId: number): void {
    this.byUser.delete(userId);
  }
}
