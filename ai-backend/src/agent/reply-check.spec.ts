import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';
import {
  factCorpus,
  knownCents,
  stripAmounts,
  unbackedClaims,
  unknownAmounts,
  unseenIds,
} from './reply-check.js';

describe('reply-check', () => {
  const messages: MessageParam[] = [
    { role: 'user', content: 'quero pizza até 50 reais' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'search', input: {} }],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content:
            '{"itemId":"it-77","unitPrice":42.9,"fee":1234.5,"cents":3990}',
        },
      ],
    },
    // O texto do assistente não conta como fonte.
    { role: 'assistant', content: 'Custa R$ 99,90' },
  ];
  const corpus = factCorpus(messages, ['Prévia: Ana paga R$ 12,34']);
  const known = knownCents(corpus);

  it('aceita valores que vieram de ferramentas, do sistema ou do usuário', () => {
    const reply =
      'Pizza por R$ 42,90 (entrega R$ 1.234,50), R$ 39,90, R$ 12,34, até R$ 50 e entrega grátis R$ 0,00';
    expect(unknownAmounts(reply, known)).toEqual([]);
  });

  it('aponta valores sem origem, sem repetir', () => {
    const out = unknownAmounts('Fica R$ 99,90. Isso, R$ 99,90 e R$ 7', known);
    expect(out).toEqual([
      { text: 'R$ 99,90', cents: 9990 },
      { text: 'R$ 7', cents: 700 },
    ]);
    expect(stripAmounts('Fica R$ 99,90.', out)).toBe(
      'Fica (valor a confirmar).',
    );
  });

  it('ids de escrita precisam ter aparecido na conversa', () => {
    expect(unseenIds({ cartId: 'it-77', quantity: 2 }, corpus)).toEqual([]);
    expect(
      unseenIds({ cartId: 'c-inventado', item: { itemId: 'it-77' } }, corpus),
    ).toEqual([{ key: 'cartId', value: 'c-inventado' }]);
    expect(unseenIds({ items: [{ cart_item_id: 'x9' }] }, corpus)).toEqual([
      { key: 'cart_item_id', value: 'x9' },
    ]);
  });

  it('ação afirmada precisa de ferramenta bem-sucedida no turno', () => {
    expect(unbackedClaims('Adicionei a pizza!', [])).toEqual([
      'adicionar item',
    ]);
    expect(unbackedClaims('Adicionei a pizza!', ['addItemToCart'])).toEqual([]);
    expect(unbackedClaims('Incluí a coca no carrinho', [])).toEqual([
      'adicionar item',
    ]);
    expect(unbackedClaims('Apliquei o cupom de 10%', ['getCart'])).toEqual([
      'aplicar cupom',
    ]);
    expect(unbackedClaims('Gerei os links de pagamento', [])).toEqual([
      'gerar os links de pagamento',
    ]);
  });

  it('frase negada não conta como ação feita (casos vistos no eval)', () => {
    for (const text of [
      'Não adicionei a Coca-Cola ao carrinho.',
      'Quer que eu monte o carrinho? Ainda não coloquei nada no carrinho.',
      'Não criei carrinho nem adicionei itens, e nenhum pagamento foi enviado.',
      'Fiz a comparação e o pedido mínimo é R$ 20,00.',
    ]) {
      expect(unbackedClaims(text, [])).toEqual([]);
    }
    expect(
      unbackedClaims('Não achei a coca, mas adicionei o guaraná.', []),
    ).toEqual(['adicionar item']);
  });

  it('não confunde sugestão ou futuro com ação feita', () => {
    expect(
      unbackedClaims(
        'Posso adicionar a pizza? Removi da lista os pratos com lactose. Vou aplicar o cupom.',
        [],
      ),
    ).toEqual([]);
  });
});
