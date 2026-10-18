// Configuração de IA do agente. Tudo vem do ambiente (.env); os defaults são de propósito baratos
// (modelo menor, effort baixo, limites curtos) para testes e scripts que não definem nada. Produção
// define os valores reais no .env. Valor inválido derruba a inicialização: configuração de IA
// errada não pode cair em silêncio num default.

export const AGENT_CONFIG = Symbol('AGENT_CONFIG');

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export interface AgentConfig {
  apiKey?: string;
  model: string;
  effort: Effort;
  // O raciocínio (adaptive thinking) conta neste limite.
  maxTokens: number;
  maxToolRounds: number;
  // Quantas linhas da tabela messages entram no contexto do LLM.
  historyRows: number;
  // Resultados de ferramentas de mensagens anteriores entram encurtados no contexto.
  historyToolResultChars: number;
}

export const DEFAULT_AGENT_CONFIG: Readonly<AgentConfig> = Object.freeze({
  model: 'claude-haiku-5-5',
  effort: 'low',
  maxTokens: 4096,
  maxToolRounds: 6,
  historyRows: 20,
  historyToolResultChars: 2000,
});

// Acima de ~21 mil tokens o SDK recusa requisições sem streaming (o tempo esperado passa de 10 min).
const MAX_NON_STREAMING_TOKENS = 21000;

const INT_LIMITS: Record<
  'maxTokens' | 'maxToolRounds' | 'historyRows' | 'historyToolResultChars',
  { env: string; min: number; max: number }
> = {
  maxTokens: {
    env: 'AGENT_MAX_TOKENS',
    min: 1024,
    max: MAX_NON_STREAMING_TOKENS,
  },
  maxToolRounds: { env: 'AGENT_MAX_TOOL_ROUNDS', min: 1, max: 30 },
  historyRows: { env: 'AGENT_HISTORY_ROWS', min: 2, max: 200 },
  historyToolResultChars: {
    env: 'AGENT_HISTORY_TOOL_RESULT_CHARS',
    min: 500,
    max: 20000,
  },
};

const read = (env: NodeJS.ProcessEnv, key: string) => {
  const value = env[key]?.trim();
  return value ? value : undefined;
};

export function loadAgentConfig(
  env: NodeJS.ProcessEnv = process.env,
): Readonly<AgentConfig> {
  const errors: string[] = [];
  const config: AgentConfig = {
    ...DEFAULT_AGENT_CONFIG,
    apiKey: read(env, 'ANTHROPIC_API_KEY'),
  };

  const model = read(env, 'AGENT_MODEL');
  if (model !== undefined) {
    if (/^[a-z0-9][a-z0-9.\-:@]*$/i.test(model)) config.model = model;
    else errors.push(`AGENT_MODEL inválido: ${JSON.stringify(model)}`);
  }

  const effort = read(env, 'AGENT_EFFORT');
  if (effort !== undefined) {
    if ((EFFORTS as readonly string[]).includes(effort)) {
      config.effort = effort as Effort;
    } else {
      errors.push(
        `AGENT_EFFORT deve ser um de ${EFFORTS.join(', ')} (veio ${JSON.stringify(effort)})`,
      );
    }
  }

  for (const [field, { env: key, min, max }] of Object.entries(INT_LIMITS)) {
    const raw = read(env, key);
    if (raw === undefined) continue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      errors.push(
        `${key} deve ser um inteiro de ${min} a ${max} (veio ${JSON.stringify(raw)})`,
      );
      continue;
    }
    config[field as keyof typeof INT_LIMITS] = value;
  }

  if (errors.length) {
    throw new Error(
      `Configuração de IA inválida no .env:\n- ${errors.join('\n- ')}`,
    );
  }
  return Object.freeze(config);
}
