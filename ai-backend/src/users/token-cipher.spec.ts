import { randomBytes } from 'node:crypto';
import { TokenCipher, TokenCipherError, parseKey } from './token-cipher.js';

const KEY = randomBytes(32).toString('base64');

describe('parseKey', () => {
  it('aceita 32 bytes em base64 e em hex', () => {
    const bytes = randomBytes(32);
    expect(parseKey(bytes.toString('base64'))).toEqual(bytes);
    expect(parseKey(bytes.toString('hex'))).toEqual(bytes);
    expect(parseKey(`  ${bytes.toString('base64')}\n`)).toEqual(bytes);
  });

  it('recusa chave ausente ou do tamanho errado, explicando como gerar', () => {
    expect(() => parseKey(undefined)).toThrow(/openssl rand -base64 32/);
    expect(() => parseKey('')).toThrow(TokenCipherError);
    expect(() => parseKey(randomBytes(16).toString('base64'))).toThrow(
      /32 bytes \(tem 16\)/,
    );
    expect(() => parseKey('curta')).toThrow(TokenCipherError);
  });
});

describe('TokenCipher', () => {
  let cipher: TokenCipher;

  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
    cipher = new TokenCipher();
  });
  afterAll(() => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
  });

  it('não sobe sem chave válida (nunca grava em texto puro por falta de chave)', () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect(() => new TokenCipher()).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });

  it('cifra e decifra de volta o mesmo texto, inclusive JWT e unicode', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl';
    for (const secret of [jwt, '', 'ação ✓ 日本語', 'x'.repeat(5000)]) {
      const encrypted = cipher.encrypt(secret, 'ctx');
      expect(cipher.decrypt(encrypted, 'ctx')).toBe(secret);
    }
  });

  it('o texto cifrado não revela o segredo e muda a cada vez (IV aleatório)', () => {
    const secret = 'eyJhbGciOiJSUzI1NiJ9.segredo';
    const a = cipher.encrypt(secret, 'ctx');
    const b = cipher.encrypt(secret, 'ctx');

    expect(a).toMatch(/^v1:[\w-]+:[\w-]+:[\w-]*$/);
    expect(a).not.toContain(secret);
    expect(a).not.toBe(b);
    expect(cipher.isEncrypted(a)).toBe(true);
    expect(cipher.isEncrypted(secret)).toBe(false);
  });

  it('não decifra com outro contexto (valor copiado para outra linha)', () => {
    const encrypted = cipher.encrypt('segredo', 'ifood:access:1');
    expect(() => cipher.decrypt(encrypted, 'ifood:access:2')).toThrow(
      TokenCipherError,
    );
    expect(() => cipher.decrypt(encrypted, 'ifood:refresh:1')).toThrow(
      TokenCipherError,
    );
  });

  it('detecta adulteração do texto, da tag e do IV', () => {
    const [v, iv, tag, data] = cipher.encrypt('segredo', 'ctx').split(':');
    const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);

    for (const tampered of [
      [v, iv, tag, flip(data)],
      [v, iv, flip(tag), data],
      [v, flip(iv), tag, data],
    ]) {
      expect(() => cipher.decrypt(tampered.join(':'), 'ctx')).toThrow(
        TokenCipherError,
      );
    }
  });

  it('não decifra com outra chave', () => {
    const encrypted = cipher.encrypt('segredo', 'ctx');
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    expect(() => new TokenCipher().decrypt(encrypted, 'ctx')).toThrow(
      TokenCipherError,
    );
  });

  it('recusa formatos inválidos', () => {
    for (const bad of ['', 'texto-puro', 'v2:a:b:c', 'v1:a:b', 'v1:a:b:c:d']) {
      expect(() => cipher.decrypt(bad, 'ctx')).toThrow(TokenCipherError);
    }
  });
});
