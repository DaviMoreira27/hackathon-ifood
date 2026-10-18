// Quebra em linhas inteiras para não cortar formatação no meio.
export function splitByLines(text: string, max: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= max) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    current = line;
    while (current.length > max) {
      chunks.push(current.slice(0, max));
      current = current.slice(max);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
