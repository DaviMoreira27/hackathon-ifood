// Converte o Markdown que o LLM escreve para a formatação do WhatsApp (*negrito*, _itálico_,
// ~tachado~, ```código```). Títulos viram negrito e links com rótulo mostram a URL, já que o
// WhatsApp não tem link com rótulo.

const BOLD = '\uE001';

function formatInline(text: string): string {
  // Protege `código` e URLs antes das outras regras (ex.: "_" dentro de uma URL não vira itálico).
  const kept: string[] = [];
  const keep = (raw: string) => {
    kept.push(raw);
    return `\uE000${kept.length - 1}\uE000`;
  };

  let out = text
    .replace(/`[^`\n]+`/g, (code) => keep(code))
    .replace(
      /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
      (_, label: string, url: string) => `${label}: ${keep(url)}`,
    )
    .replace(/https?:\/\/\S+/g, (url) => keep(url));

  // O negrito do WhatsApp usa um asterisco só: marca antes, para o itálico com * não pegá-lo.
  out = out
    .replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${BOLD}`)
    .replace(/__(.+?)__/g, `${BOLD}$1${BOLD}`)
    .replace(/~~(.+?)~~/g, '~$1~')
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1_$2_')
    .replaceAll(BOLD, '*');

  return out.replace(/\uE000(\d+)\uE000/g, (_, i: string) => kept[Number(i)]);
}

export function markdownToWhatsapp(markdown: string): string {
  const out: string[] = [];
  let inCode = false;

  for (const line of markdown.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inCode = !inCode;
      out.push('```');
      continue;
    }
    if (inCode) {
      out.push(line);
      continue;
    }

    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (heading) {
      out.push(`*${formatInline(heading[1].replace(/\*\*|__/g, ''))}*`);
      continue;
    }
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      out.push('──────────');
      continue;
    }
    // "* item" viraria negrito no WhatsApp: toda lista sai com "-".
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      out.push(`${bullet[1]}- ${formatInline(bullet[2])}`);
      continue;
    }
    out.push(formatInline(line));
  }

  // Bloco de código sem fechamento: fecha para o resto da mensagem não sair em monoespaçado.
  if (inCode) out.push('```');

  return out.join('\n');
}
