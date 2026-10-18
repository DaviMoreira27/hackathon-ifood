// Ferramentas com efeito real (dinheiro, endereço de entrega) só rodam com confirmação explícita
// do usuário. A decisão é do código, não do LLM: um texto malicioso vindo do catálogo (nome de
// loja, descrição de prato) pode convencer o modelo, mas não consegue digitar /confirmar no chat.
// Nomes reais do MCP do iFood (camelCase). submitOrder cobra e cria o pedido; createAddress grava
// um endereço permanente. Lista explícita porque a heurística por nome erra: "setCartPayment" só
// escolhe a forma de pagamento (não cobra) e "listAddresses"/"listPaymentMethods" só leem.
const DEFAULT_CONFIRM_TOOLS = new Set(['submitOrder', 'createAddress']);
// Leitura: verbo + (maiúscula | _ | fim), cobrindo camelCase (listAddresses) e snake_case (list_addresses).
const READ_PREFIX =
  /^(get|list|search|browse|find|read|fetch|view|show|check|track)([A-Z_]|$)/;
// Para ferramentas que não conhecemos (o MCP pode ganhar tools novas): nomes que parecem fechar
// pedido ou mexer em endereço. "pay" não casa "payment" (setCartPayment só seleciona a forma).
const SENSITIVE_NAME =
  /submit_?order|checkout|place_?order|purchase|address|pay(?!ment)/i;

export interface ToolAnnotations {
  readOnlyHint?: boolean;
}

// MCP_CONFIRM_TOOLS (nomes separados por vírgula) substitui tudo isto.
export function requiresConfirmation(
  name: string,
  annotations?: ToolAnnotations,
): boolean {
  const configured = process.env.MCP_CONFIRM_TOOLS;
  if (configured) {
    return configured
      .split(',')
      .map((s) => s.trim())
      .includes(name);
  }
  if (DEFAULT_CONFIRM_TOOLS.has(name)) return true;
  if (annotations?.readOnlyHint === true || READ_PREFIX.test(name)) {
    return false;
  }
  return SENSITIVE_NAME.test(name);
}

export const UNTRUSTED_TAG = 'dados_da_ferramenta';
const MAX_TOOL_RESULT_CHARS = 20_000;

// Delimita o resultado como dado externo (o prompt de sistema manda nunca seguir instruções
// daqui) e corta respostas gigantes, que custam tokens e ficam gravadas no histórico.
export function wrapToolResult(name: string, text: string): string {
  let body = text.replaceAll(`</${UNTRUSTED_TAG}`, `<\\/${UNTRUSTED_TAG}`);
  if (body.length > MAX_TOOL_RESULT_CHARS) {
    body = `${body.slice(0, MAX_TOOL_RESULT_CHARS)}\n[… resultado truncado: ${body.length - MAX_TOOL_RESULT_CHARS} caracteres omitidos]`;
  }
  const safeName = name.replace(/[^\w.-]/g, '');
  return `<${UNTRUSTED_TAG} ferramenta="${safeName}">\n${body}\n</${UNTRUSTED_TAG}>`;
}

// Ferramentas só de leitura podem rodar em paralelo quando o LLM pede várias de uma vez (ex.:
// buscar o mesmo prato em três lojas). Escritas continuam em série: duas alterações simultâneas
// no mesmo carrinho do iFood podem se atropelar.
export function isReadOnlyTool(
  name: string,
  annotations?: ToolAnnotations,
): boolean {
  if (requiresConfirmation(name, annotations)) return false;
  return annotations?.readOnlyHint === true || READ_PREFIX.test(name);
}

// Resultados de turnos anteriores são encurtados ao remontar o histórico: buscas grandes já foram
// resumidas pelo LLM na resposta, e reenviá-las inteiras a cada mensagem custa tokens. Mantém o
// envelope de dados não confiáveis intacto.
export function shrinkToolResult(content: string, max: number): string {
  if (content.length <= max) return content;
  const match = content.match(
    new RegExp(
      `^(<${UNTRUSTED_TAG}[^>]*>\\n)([\\s\\S]*)(\\n</${UNTRUSTED_TAG}>)$`,
    ),
  );
  const [open, body, close] = match
    ? [match[1], match[2], match[3]]
    : ['', content, ''];
  return `${open}${body.slice(0, max)}\n[… resultado antigo encurtado: ${body.length - max} caracteres omitidos; chame a ferramenta de novo se precisar dos detalhes]${close}`;
}
