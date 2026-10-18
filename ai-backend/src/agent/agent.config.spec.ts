import { DEFAULT_AGENT_CONFIG, loadAgentConfig } from './agent.config.js';

describe('loadAgentConfig', () => {
  it('sem nada no ambiente, usa os defaults baratos', () => {
    expect(loadAgentConfig({})).toEqual({
      ...DEFAULT_AGENT_CONFIG,
      apiKey: undefined,
    });
    expect(DEFAULT_AGENT_CONFIG).toMatchObject({
      model: 'claude-haiku-5-5',
      effort: 'low',
    });
  });

  it('lê tudo do ambiente', () => {
    expect(
      loadAgentConfig({
        ANTHROPIC_API_KEY: 'sk-test',
        AGENT_MODEL: 'claude-sonnet-5-5',
        AGENT_EFFORT: 'high',
        AGENT_MAX_TOKENS: '16000',
        AGENT_MAX_TOOL_ROUNDS: '12',
        AGENT_HISTORY_ROWS: '40',
        AGENT_HISTORY_TOOL_RESULT_CHARS: ' 4000 ',
        AGENT_HISTORY_TOOL_TURNS: '5',
      }),
    ).toEqual({
      apiKey: 'sk-test',
      model: 'claude-sonnet-5-5',
      effort: 'high',
      maxTokens: 16000,
      maxToolRounds: 12,
      historyRows: 40,
      historyToolResultChars: 4000,
      historyToolTurns: 5,
    });
  });

  it('variável vazia vale o default', () => {
    expect(
      loadAgentConfig({ AGENT_EFFORT: '', AGENT_MODEL: '  ' }),
    ).toMatchObject({
      model: DEFAULT_AGENT_CONFIG.model,
      effort: DEFAULT_AGENT_CONFIG.effort,
    });
  });

  it('valor inválido derruba a inicialização listando todos os problemas', () => {
    expect(() =>
      loadAgentConfig({
        AGENT_EFFORT: 'turbo',
        AGENT_MAX_TOKENS: '64000',
        AGENT_MAX_TOOL_ROUNDS: 'doze',
        AGENT_MODEL: 'claude haiku',
      }),
    ).toThrow(
      /AGENT_MODEL inválido[\s\S]*AGENT_EFFORT[\s\S]*AGENT_MAX_TOKENS deve ser um inteiro de 1024 a 21000[\s\S]*AGENT_MAX_TOOL_ROUNDS/,
    );
  });

  it('a configuração devolvida não pode ser alterada', () => {
    const config = loadAgentConfig({});
    expect(Object.isFrozen(config)).toBe(true);
  });
});
