// Texto legível para logs. Erros de conexão do Node vêm como AggregateError (um erro por endereço
// tentado, ex.: ::1 e 127.0.0.1) com a mensagem vazia, e String(err) mostraria só "AggregateError".
export function describeError(err: unknown): string {
  if (err instanceof AggregateError && err.errors.length > 0) {
    return err.errors.map(describeError).join('; ');
  }
  if (err instanceof Error) {
    const { code, address, port } = err as Error & {
      code?: string;
      address?: string;
      port?: number;
    };
    const codeText = code && !err.message.includes(code) ? code : '';
    const where = address ? `${address}${port ? `:${port}` : ''}` : '';
    const head = [codeText, where].filter(Boolean).join(' ');
    const detail = err.message || (head ? '' : err.name);
    return head && detail ? `${head}: ${detail}` : head || detail;
  }
  return String(err);
}
