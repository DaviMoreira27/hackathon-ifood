// Serializa as mensagens de um mesmo chat para não rodar dois loops sobre o mesmo histórico. Chats
// diferentes rodam em paralelo. Em memória: prende o serviço a um processo só.
export class ChatQueue {
  private readonly tails = new Map<number, Promise<unknown>>();
  private readonly depths = new Map<number, number>();

  // Mensagens do mesmo chat esperando na fila: acima disso, o usuário recebe "aguarde" em vez de
  // enfileirar mais chamadas ao LLM (custo) e ao MCP.
  constructor(private readonly maxQueued: number) {}

  depth(chatId: number): number {
    return this.depths.get(chatId) ?? 0;
  }

  // Chats com alguma tarefa na fila (para conferir a limpeza).
  get activeChats(): number {
    return this.tails.size;
  }

  // null quando a fila do chat está cheia: a tarefa não é enfileirada.
  enqueue<T>(chatId: number, task: () => Promise<T>): Promise<T> | null {
    const depth = this.depth(chatId);
    if (depth >= this.maxQueued) return null;
    this.depths.set(chatId, depth + 1);

    const previous = this.tails.get(chatId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.tails.set(chatId, next);
    // O .catch é obrigatório: sem ele a promise derivada do finally rejeita sem handler
    // quando a tarefa falha, e o Node derruba o processo (unhandled rejection).
    next
      .finally(() => {
        const remaining = this.depth(chatId) - 1;
        if (remaining > 0) this.depths.set(chatId, remaining);
        else this.depths.delete(chatId);
        if (this.tails.get(chatId) === next) this.tails.delete(chatId);
      })
      .catch(() => undefined);
    return next;
  }
}
