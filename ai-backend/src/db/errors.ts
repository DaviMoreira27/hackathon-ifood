// O drizzle embrulha erros do driver (DrizzleQueryError.cause), então o código do Postgres pode
// estar no próprio erro ou no cause.
export function pgErrorCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === 'string' ? code : undefined;
}

export const UNIQUE_VIOLATION = '23505';
