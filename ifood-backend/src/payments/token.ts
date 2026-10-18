import { createHash, createHmac } from 'node:crypto';

// O token de pagamento é derivado (HMAC) da referência: imprevisível sem o segredo, mas
// reproduzível. Assim criar a mesma cobrança duas vezes (retry do ai-backend) devolve o mesmo
// link, sem precisar guardar o token em texto puro.
export function deriveToken(secret: string, reference: string): string {
  return createHmac('sha256', secret)
    .update(`charge:${reference}`)
    .digest('base64url');
}

// No banco fica só o hash: quem lê a tabela não consegue montar links de pagamento.
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
