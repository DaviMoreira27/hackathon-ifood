import type { TurnContext } from '../turn/turn-context.js';

export type ToolOrigin = 'mcp' | 'group' | 'diet' | 'price';

// Um tool_use pedido pelo LLM. `input` é o argumento normalizado para objeto (o que os gates e a
// confirmação veem); `rawInput` é o que veio, para as ferramentas que validam sozinhas.
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  rawInput: unknown;
}

export interface ToolOutcome {
  text: string;
  isError: boolean;
  // Saída da ferramenta antes do envelope de dados não confiáveis (o hook de sync lê daqui).
  raw?: string;
}

// Uma ferramenta que o agente sabe executar. Cada família (iFood, pedido em grupo, dieta, preços)
// implementa a mesma interface; o executor não sabe de onde ela vem.
export interface ToolHandler {
  readonly name: string;
  readonly origin: ToolOrigin;
  // Escrita num carrinho do iFood: depois dela, o carrinho é relido e sincronizado.
  readonly cartWrite: boolean;
  // Nunca lança, exceto McpUnauthorizedError (o turno inteiro precisa de login de novo).
  execute(call: ToolCall, ctx: TurnContext): Promise<ToolOutcome>;
}

export interface ToolSource {
  // null = a ferramenta não é desta fonte.
  handler(name: string, ctx: TurnContext): ToolHandler | null;
}
