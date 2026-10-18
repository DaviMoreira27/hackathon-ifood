import { deriveToken, hashToken } from './token.js';

describe('token', () => {
  it('é determinístico para a mesma referência e segredo', () => {
    expect(deriveToken('s', '42')).toBe(deriveToken('s', '42'));
  });

  it('muda com a referência e com o segredo', () => {
    expect(deriveToken('s', '42')).not.toBe(deriveToken('s', '43'));
    expect(deriveToken('s', '42')).not.toBe(deriveToken('outro', '42'));
  });

  it('é seguro para URL e tem 256 bits', () => {
    const token = deriveToken('s', '42');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('o hash não revela o token e é estável', () => {
    const token = deriveToken('s', '42');
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toContain(token);
  });
});
