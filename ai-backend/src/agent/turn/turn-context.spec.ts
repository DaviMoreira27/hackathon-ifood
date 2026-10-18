import type { OrderView } from '../../group-order/group-order.service.js';
import { TurnContext } from './turn-context.js';

const view = (id: number) =>
  ({ order: { id, status: 'collecting' } }) as unknown as OrderView;

describe('TurnContext', () => {
  it('lê o estado do pedido uma vez até alguém marcar que ele mudou', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(view(1))
      .mockResolvedValueOnce(view(2));
    const ctx = new TurnContext({ chatId: 1, userId: 2 }, load);

    expect(await ctx.orderView()).toEqual(view(1));
    expect(await ctx.orderView()).toEqual(view(1));
    expect(load).toHaveBeenCalledTimes(1);

    ctx.markOrderChanged();
    expect(await ctx.orderView()).toEqual(view(2));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('carrinho alterado também invalida o estado do pedido', async () => {
    const load = vi.fn().mockResolvedValue(view(1));
    const ctx = new TurnContext({ chatId: 1, userId: 2 }, load);

    await ctx.orderView();
    ctx.markCartChanged();
    await ctx.orderView();

    expect(load).toHaveBeenCalledTimes(2);
  });

  it('falha na leitura não fica memorizada', async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('banco fora'))
      .mockResolvedValueOnce(view(1));
    const ctx = new TurnContext({ chatId: 1, userId: 2 }, load);

    await expect(ctx.orderView()).rejects.toThrow('banco fora');
    expect(await ctx.orderView()).toEqual(view(1));
  });

  it('o corpus de fatos cresce com o estado e com o que for adicionado', () => {
    const ctx = new TurnContext({ chatId: 1, userId: 2 }, vi.fn());
    ctx.begin({} as never, [{ role: 'user', content: 'quero a c1' }]);
    ctx.setStateBlock('Estado: total R$ 47,90');
    ctx.facts.add('{"itemId":"i9","unitPrice":12.5}');

    expect(ctx.facts.text).toContain('quero a c1');
    expect(ctx.facts.text).toContain('i9');
    expect(ctx.facts.knownCents().has(4790)).toBe(true);
    expect(ctx.facts.knownCents().has(1250)).toBe(true);
  });
});
