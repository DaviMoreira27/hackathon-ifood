import { GROUP_TOOLS } from '../group-order/index.js';
import { DIET_TOOLS } from '../dietary/index.js';
import { PRICE_TOOLS } from './tools/sources/price.source.js';
import { strictTool } from './strict-tools.js';

// Percorre o schema e devolve todo nó de objeto e toda chave usada.
function walk(node: unknown, objects: any[] = [], keys = new Set<string>()) {
  if (Array.isArray(node)) node.forEach((n) => walk(n, objects, keys));
  else if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (o.type === 'object') objects.push(o);
    for (const [k, v] of Object.entries(o)) {
      if (k !== 'properties') keys.add(k);
      walk(v, objects, keys);
    }
  }
  return { objects, keys };
}

describe('strictTool', () => {
  const tools = [...GROUP_TOOLS, ...PRICE_TOOLS, ...DIET_TOOLS].map(strictTool);

  it('marca strict e fecha todo objeto com additionalProperties: false', () => {
    for (const tool of tools) {
      expect((tool as { strict?: boolean }).strict).toBe(true);
      const { objects } = walk(tool.input_schema);
      expect(objects.length).toBeGreaterThan(0);
      for (const o of objects) expect(o.additionalProperties).toBe(false);
    }
  });

  it('tira as restrições que o modo estrito não aceita', () => {
    for (const tool of tools) {
      const { keys } = walk(tool.input_schema);
      for (const k of ['minimum', 'maxItems', 'maxLength', 'default']) {
        expect(keys.has(k)).toBe(false);
      }
    }
    const compare = tools.find((t) => t.name === 'compare_prices')!;
    const options = (compare.input_schema.properties as any).options;
    expect(options.minItems).toBe(1);
  });

  it('não altera a definição original', () => {
    const original = PRICE_TOOLS[0].input_schema as any;
    expect(original.properties.options.maxItems).toBe(15);
    expect(original.additionalProperties).toBeUndefined();
  });

  it('preserva propriedades com nomes de palavras reservadas do schema', () => {
    const tool = strictTool({
      name: 't',
      input_schema: {
        type: 'object',
        properties: { default: { type: 'string' }, type: { type: 'string' } },
      },
    });
    expect(Object.keys(tool.input_schema.properties as object)).toEqual([
      'default',
      'type',
    ]);
  });
});
