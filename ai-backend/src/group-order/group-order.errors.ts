// Erro de regra de negócio: a mensagem é mostrada ao LLM como resultado da ferramenta
// (is_error), para ele explicar ao usuário. Qualquer outro erro é tratado como falha interna.
export class GroupOrderError extends Error {}
