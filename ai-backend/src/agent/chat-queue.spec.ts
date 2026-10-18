import { ChatQueue } from './chat-queue.js';

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('ChatQueue', () => {
  it('roda as tarefas do mesmo chat em série, na ordem', async () => {
    const queue = new ChatQueue(3);
    const order: string[] = [];
    const first = deferred<void>();
    const a = queue.enqueue(1, async () => {
      order.push('a:start');
      await first.promise;
      order.push('a:end');
    });
    const b = queue.enqueue(1, async () => {
      order.push('b');
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['a:start']);
    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'a:end', 'b']);
  });

  it('chats diferentes não esperam um pelo outro', async () => {
    const queue = new ChatQueue(3);
    const blocked = deferred<void>();
    void queue.enqueue(1, () => blocked.promise);
    await expect(queue.enqueue(2, async () => 'ok')).resolves.toBe('ok');
    blocked.resolve();
  });

  it('recusa acima do limite por chat', async () => {
    const queue = new ChatQueue(2);
    const blocked = deferred<void>();
    const a = queue.enqueue(1, () => blocked.promise);
    const b = queue.enqueue(1, async () => undefined);
    expect(queue.enqueue(1, async () => undefined)).toBeNull();
    expect(queue.depth(1)).toBe(2);
    blocked.resolve();
    await Promise.all([a, b]);
    expect(queue.enqueue(1, async () => undefined)).not.toBeNull();
  });

  it('uma tarefa que falha não trava as próximas', async () => {
    const queue = new ChatQueue(3);
    const failed = queue.enqueue(1, async () => {
      throw new Error('boom');
    });
    const next = queue.enqueue(1, async () => 'depois');
    await expect(failed).rejects.toThrow('boom');
    await expect(next).resolves.toBe('depois');
  });

  it('limpa o estado do chat quando a fila esvazia', async () => {
    const queue = new ChatQueue(3);
    await queue.enqueue(1, async () => undefined);
    await queue
      .enqueue(1, async () => {
        throw new Error('x');
      })
      ?.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(queue.depth(1)).toBe(0);
    expect(queue.activeChats).toBe(0);
  });
});
