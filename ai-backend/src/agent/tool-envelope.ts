// Envelope dos resultados de ferramentas: o texto vindo de fora vai delimitado como dado não
// confiável (o prompt de sistema manda nunca seguir instruções daqui).

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

export const unwrapToolText = (content: string) =>
  content
    .replace(new RegExp(`^<${UNTRUSTED_TAG}[^>]*>\\n`), '')
    .replace(new RegExp(`\\n</${UNTRUSTED_TAG}>$`), '');

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
