// Ferramentas com efeito real (dinheiro, endereço de entrega) só rodam com confirmação explícita
// do usuário. A decisão é do código, não do LLM: um texto malicioso vindo do catálogo (nome de
// loja, descrição de prato) pode convencer o modelo, mas não consegue digitar /confirmar no chat.
// Nomes reais do MCP do iFood (camelCase). submitOrder cobra e cria o pedido; createAddress grava
// um endereço permanente. Lista explícita porque a heurística por nome erra: "setCartPayment" só
// escolhe a forma de pagamento (não cobra) e "listAddresses"/"listPaymentMethods" só leem.

import { appConfig } from '../config/app-config.js';
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
  configured: string[] | null = appConfig().mcp.confirmTools,
): boolean {
  if (configured) return configured.includes(name);
  if (DEFAULT_CONFIRM_TOOLS.has(name)) return true;
  if (annotations?.readOnlyHint === true || READ_PREFIX.test(name)) {
    return false;
  }
  return SENSITIVE_NAME.test(name);
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
