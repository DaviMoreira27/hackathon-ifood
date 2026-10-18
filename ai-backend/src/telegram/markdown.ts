// Converte o Markdown que o LLM escreve para o subconjunto de HTML aceito pelo Telegram
// (b, i, s, code, pre, a, blockquote). Títulos viram negrito e listas viram "•".

import { appConfig } from '../config/app-config.js';

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Link com rótulo ([Pague aqui](url)) esconde o destino. Fora destes domínios, a URL aparece
// escrita, para um texto injetado no LLM não conseguir disfarçar um link de phishing.
function isTrustedHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url.replace(/&amp;/g, '&')).hostname.toLowerCase();
  } catch {
    return false;
  }
  const trusted = ['ifood.com.br', ...appConfig().trustedLinkHosts];
  return trusted.some((t) => host === t || host.endsWith(`.${t}`));
}

function formatInline(text: string): string {
  // Protege `código`, links e URLs antes das outras regras (ex.: "_" dentro de uma URL não vira itálico).
  const kept: string[] = [];
  const keep = (html: string) => {
    kept.push(html);
    return `\uE000${kept.length - 1}\uE000`;
  };

  let out = text
    .replace(/`([^`\n]+)`/g, (_, code: string) => keep(`<code>${code}</code>`))
    .replace(
      /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
      (_, label: string, url: string) =>
        isTrustedHost(url)
          ? keep(`<a href="${url.replace(/"/g, '&quot;')}">${label}</a>`)
          : `${label} (${keep(url)})`,
    )
    .replace(/https?:\/\/[^\s<]+/g, (url) => keep(url));

  out = out
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/__(.+?)__/g, '<b>$1</b>')
    .replace(/~~(.+?)~~/g, '<s>$1</s>')
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1<i>$2</i>');

  return out.replace(/\uE000(\d+)\uE000/g, (_, i: string) => kept[Number(i)]);
}

export function markdownToTelegramHtml(markdown: string): string {
  const lines = escapeHtml(markdown).split('\n');
  const out: string[] = [];
  let inCode = false;
  let codeLines: string[] = [];

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      if (inCode) {
        out.push(`<pre>${codeLines.join('\n')}</pre>`);
        codeLines = [];
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }

    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (heading) {
      out.push(`<b>${formatInline(heading[1])}</b>`);
      continue;
    }
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      out.push('──────────');
      continue;
    }
    const quote = line.match(/^&gt;\s?(.*)$/);
    if (quote) {
      out.push(`<blockquote>${formatInline(quote[1])}</blockquote>`);
      continue;
    }
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      out.push(`${bullet[1]}• ${formatInline(bullet[2])}`);
      continue;
    }
    out.push(formatInline(line));
  }

  // Bloco de código sem fechamento: emite o que veio.
  if (inCode) out.push(`<pre>${codeLines.join('\n')}</pre>`);

  return out.join('\n').replace(/<\/blockquote>\n<blockquote>/g, '\n');
}
