import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';
import { cachedMessages, cachedTools } from './prompt-cache.js';

describe('prompt cache', () => {
  it('marca só a última ferramenta e a última mensagem, sem mutar os originais', () => {
    const tools = [
      { name: 'a', input_schema: { type: 'object' as const } },
      { name: 'b', input_schema: { type: 'object' as const } },
    ];
    const messages: MessageParam[] = [
      { role: 'user', content: 'oi' },
      { role: 'assistant', content: [{ type: 'text', text: 'olá' }] },
      { role: 'user', content: 'pizza' },
    ];
    const snapshot = structuredClone(messages);

    const t = cachedTools(tools);
    const m = cachedMessages(messages);

    expect(t[0]).not.toHaveProperty('cache_control');
    expect(t[1]).toMatchObject({
      name: 'b',
      cache_control: { type: 'ephemeral' },
    });
    expect(m[2].content).toEqual([
      { type: 'text', text: 'pizza', cache_control: { type: 'ephemeral' } },
    ]);
    expect(m[1]).toBe(messages[1]);
    expect(messages).toEqual(snapshot);
    expect(tools[1]).not.toHaveProperty('cache_control');
  });
});
