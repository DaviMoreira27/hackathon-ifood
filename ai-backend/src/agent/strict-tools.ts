import type { Tool } from '@anthropic-ai/sdk/resources/messages.js';

// Com strict: true a API garante que os argumentos respeitam o schema (tipos, campos
// obrigatórios, nada a mais). O modo estrito exige additionalProperties: false em todo objeto e
// não aceita restrições numéricas, de tamanho de string e de array além de minItems 0/1: elas
// saem do schema enviado. As ferramentas locais continuam validando tudo isso no código.
const UNSUPPORTED = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'maxItems',
  'default',
]);

type Schema = Record<string, unknown>;

function strictSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictSchema);
  if (typeof node !== 'object' || node === null) return node;
  const out: Schema = {};
  for (const [key, value] of Object.entries(node as Schema)) {
    if (UNSUPPORTED.has(key)) continue;
    if (key === 'minItems' && typeof value === 'number' && value > 1) {
      out.minItems = 1;
      continue;
    }
    if (key === 'properties' && typeof value === 'object' && value !== null) {
      out.properties = Object.fromEntries(
        Object.entries(value as Schema).map(([k, v]) => [k, strictSchema(v)]),
      );
      continue;
    }
    out[key] = strictSchema(value);
  }
  if (out.type === 'object') {
    out.additionalProperties = false;
    out.properties ??= {};
  }
  return out;
}

export function strictTool(tool: Tool): Tool {
  return {
    ...tool,
    input_schema: strictSchema(tool.input_schema) as Tool['input_schema'],
    strict: true,
  } as Tool;
}
