import type { Message } from '../messages/messages.service.js';
import { messagesToRows, rowsToMessages } from './history.js';

const row = (
  id: number,
  role: Message['role'],
  content: string,
  payload: unknown = null,
): Message => ({
  id,
  chatId: 1,
  userId: 1,
  role,
  content,
  payload,
  createdAt: new Date(),
});

describe('rowsToMessages', () => {
  it('descarta o início da janela até o primeiro texto do usuário', () => {
    const toolUse = [{ type: 'tool_use', id: 'a', name: 'x', input: {} }];
    const toolResult = [
      { type: 'tool_result', tool_use_id: 'a', content: 'r' },
    ];

    const messages = rowsToMessages([
      row(1, 'assistant', '[ferramentas: x]', toolUse),
      row(2, 'tool', 'x → r', toolResult),
      row(3, 'assistant', 'resposta antiga'),
      row(4, 'user', 'nova pergunta'),
    ]);

    expect(messages).toEqual([{ role: 'user', content: 'nova pergunta' }]);
  });

  it('ignora linhas de ferramenta sem payload (ex.: dados de seed)', () => {
    const messages = rowsToMessages([
      row(1, 'user', 'oi'),
      row(2, 'tool', '{"tool":"getRecommendations"}'),
      row(3, 'assistant', 'olá'),
    ]);

    expect(messages).toEqual([
      { role: 'user', content: 'oi' },
      { role: 'assistant', content: 'olá' },
    ]);
  });
});

describe('rowsToMessages — reparo de tool_use órfão', () => {
  it('converte em texto um tool_use sem tool_result (ex.: parou em max_tokens)', () => {
    const toolUse = [
      { type: 'text', text: 'vou fechar' },
      { type: 'tool_use', id: 'a', name: 'checkout', input: {} },
    ];

    const messages = rowsToMessages([
      row(1, 'user', 'fecha'),
      row(2, 'assistant', 'vou fechar', toolUse),
      row(3, 'user', 'e aí?'),
    ]);

    expect(messages).toEqual([
      { role: 'user', content: 'fecha' },
      { role: 'assistant', content: 'vou fechar' },
      { role: 'user', content: 'e aí?' },
    ]);
  });

  it('descarta tool_result sem o tool_use correspondente', () => {
    const messages = rowsToMessages([
      row(1, 'user', 'oi'),
      row(2, 'assistant', 'olá'),
      row(3, 'tool', 'x → r', [
        { type: 'tool_result', tool_use_id: 'zz', content: 'r' },
      ]),
    ]);

    expect(messages).toEqual([
      { role: 'user', content: 'oi' },
      { role: 'assistant', content: 'olá' },
    ]);
  });
});

describe('messagesToRows', () => {
  it('guarda texto legível em content e os blocos em payload', () => {
    const toolUse = [
      { type: 'tool_use' as const, id: 'a', name: 'search', input: {} },
    ];
    const toolResult = [
      { type: 'tool_result' as const, tool_use_id: 'a', content: 'achei' },
    ];

    const rows = messagesToRows(1, 5, [
      { role: 'assistant', content: toolUse },
      { role: 'user', content: toolResult },
      { role: 'assistant', content: [{ type: 'text', text: 'pronto' }] },
    ]);

    expect(rows).toEqual([
      {
        chatId: 1,
        userId: 5,
        role: 'assistant',
        content: '[ferramentas: search]',
        payload: toolUse,
      },
      {
        chatId: 1,
        userId: 5,
        role: 'tool',
        content: 'search → achei',
        payload: toolResult,
      },
      {
        chatId: 1,
        userId: 5,
        role: 'assistant',
        content: 'pronto',
        payload: null,
      },
    ]);
  });
});
