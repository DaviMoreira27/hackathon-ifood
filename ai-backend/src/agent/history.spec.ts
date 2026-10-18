import type { Message } from '../messages/messages.service.js';
import {
  messagesToRows,
  rowsToMessages,
  shrinkToolResults,
} from './history.js';
import { windowStart } from '../messages/messages.service.js';

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

describe('rowsToMessages — thinking', () => {
  it('não reenvia blocos de raciocínio de turnos anteriores', () => {
    const payload = [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'redacted_thinking', data: 'x' },
      { type: 'tool_use', id: 'a', name: 'searchOffers', input: {} },
    ];

    const messages = rowsToMessages([
      row(1, 'user', 'pizza'),
      row(2, 'assistant', '[ferramentas: searchOffers]', payload),
      row(3, 'tool', 'r', [
        { type: 'tool_result', tool_use_id: 'a', content: 'r' },
      ]),
    ]);

    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'a', name: 'searchOffers', input: {} }],
    });
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

describe('rowsToMessages — turnos antigos sem ferramentas', () => {
  const turn = (base: number, n: number) => [
    row(base, 'user', `pergunta ${n}`),
    row(base + 1, 'assistant', 'vou ver', [
      { type: 'text', text: 'vou ver' },
      { type: 'tool_use', id: `t${n}`, name: 'search', input: {} },
    ]),
    row(base + 2, 'tool', 'r', [
      { type: 'tool_result', tool_use_id: `t${n}`, content: `r${n}` },
    ]),
    row(base + 3, 'assistant', `resposta ${n}`),
  ];

  it('dos turnos antes dos últimos N fica só o texto do assistant', () => {
    const messages = rowsToMessages([...turn(1, 1), ...turn(5, 2)], 1);

    expect(messages.slice(0, 2)).toEqual([
      { role: 'user', content: 'pergunta 1' },
      { role: 'assistant', content: 'vou ver\n\nresposta 1' },
    ]);
    expect(messages).toHaveLength(6);
    expect(JSON.stringify(messages)).not.toContain('r1');
    expect(JSON.stringify(messages)).toContain('r2');
  });

  it('mensagem do usuário com payload volta com os blocos (texto + estado)', () => {
    const blocks = [
      { type: 'text', text: 'oi' },
      { type: 'text', text: '<estado>' },
    ];
    expect(rowsToMessages([row(1, 'user', 'oi', blocks)])).toEqual([
      { role: 'user', content: blocks },
    ]);
  });
});

describe('shrinkToolResults', () => {
  it('encurta só resultados de ferramenta acima do limite', () => {
    const long = 'x'.repeat(50);
    const [, results] = shrinkToolResults(
      [
        { role: 'assistant', content: [{ type: 'text', text: long }] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'a', content: long },
            { type: 'tool_result', tool_use_id: 'b', content: 'curto' },
          ],
        },
      ],
      10,
    );
    const [a, b] = results.content as Array<{ content: string }>;
    expect(a.content).toContain('resultado antigo encurtado');
    expect(b.content).toBe('curto');
  });
});

describe('windowStart', () => {
  it('o começo da janela só anda de step em step', () => {
    expect(windowStart(10, 20, 20)).toBe(0);
    expect(windowStart(39, 20, 20)).toBe(0);
    expect(windowStart(40, 20, 20)).toBe(20);
    expect(windowStart(59, 20, 20)).toBe(20);
    expect(windowStart(25, 20)).toBe(5);
  });
});
