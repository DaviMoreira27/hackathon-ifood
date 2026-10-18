import { describeError } from './describe-error.js';

describe('describeError', () => {
  it('expande AggregateError de conexão recusada em todos os endereços', () => {
    const refused = (address: string) =>
      Object.assign(new Error(''), {
        code: 'ECONNREFUSED',
        address,
        port: 5672,
      });
    const err = new AggregateError([refused('::1'), refused('127.0.0.1')]);

    expect(describeError(err)).toBe(
      'ECONNREFUSED ::1:5672; ECONNREFUSED 127.0.0.1:5672',
    );
  });

  it('mostra código e mensagem de erros comuns', () => {
    expect(
      describeError(
        Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      ),
    ).toBe('read ECONNRESET');
    expect(describeError(new Error('falhou'))).toBe('falhou');
    expect(describeError(new TypeError(''))).toBe('TypeError');
  });

  it('aceita o que não é Error', () => {
    expect(describeError('texto')).toBe('texto');
    expect(describeError(undefined)).toBe('undefined');
  });
});
