import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { appConfig } from '../config/app-config.js';

export class TokenCipherError extends Error {}

const VERSION = 'v1';
const IV_BYTES = 12; // tamanho recomendado para GCM
const KEY_HELP =
  'Gere uma chave com:  openssl rand -base64 32  e coloque em TOKEN_ENCRYPTION_KEY no ai-backend/.env';

// Aceita 32 bytes em base64 ou em hex (64 caracteres).
export function parseKey(raw: string | undefined): Buffer {
  const value = raw?.trim();
  if (!value) {
    throw new TokenCipherError(
      `TOKEN_ENCRYPTION_KEY não está definida. ${KEY_HELP}`,
    );
  }
  const key = /^[0-9a-fA-F]{64}$/.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64');
  if (key.length !== 32) {
    throw new TokenCipherError(
      `TOKEN_ENCRYPTION_KEY deve ter exatamente 32 bytes (tem ${key.length}). ${KEY_HELP}`,
    );
  }
  return key;
}

// Cifra segredos (tokens do iFood, verifier do PKCE) antes de irem para o banco: AES-256-GCM,
// IV aleatório por valor, formato "v1:<iv>:<tag>:<texto cifrado>" (base64url).
// O "contexto" entra como dado autenticado (AAD): um valor copiado para outra linha/coluna do
// banco não decifra, e qualquer alteração no texto cifrado é detectada.
@Injectable()
export class TokenCipher {
  private readonly key: Buffer;

  // Falha já na criação (ou seja, no boot do app) se a chave estiver ausente ou inválida:
  // nunca grava segredo em texto puro "por falta de chave".
  constructor() {
    this.key = parseKey(appConfig().tokenEncryptionKey);
  }

  isEncrypted(value: string): boolean {
    return value.startsWith(`${VERSION}:`);
  }

  encrypt(plain: string, context: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const encrypted = Buffer.concat([
      cipher.update(plain, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return `${VERSION}:${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
  }

  decrypt(payload: string, context: string): string {
    const [version, iv, tag, encrypted, ...extra] = payload.split(':');
    if (
      version !== VERSION ||
      !iv ||
      !tag ||
      encrypted === undefined ||
      extra.length > 0
    ) {
      throw new TokenCipherError('formato de segredo cifrado inválido');
    }
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(iv, 'base64url'),
      );
      decipher.setAAD(Buffer.from(context, 'utf8'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(encrypted, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // Chave errada, contexto errado ou dado adulterado: não vaza o motivo.
      throw new TokenCipherError(
        'não foi possível decifrar o segredo (chave diferente ou dado alterado)',
      );
    }
  }
}
