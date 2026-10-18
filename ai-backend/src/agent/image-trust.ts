import { appConfig } from '../config/app-config.js';

// Só valem imagens HTTPS de domínios confiáveis (iFood + TRUSTED_IMAGE_HOSTS): um texto injetado no
// catálogo não consegue fazer o bot mandar uma imagem qualquer (ex.: um QR Code PIX falso).

export const IMAGE_EXT = /\.(jpe?g|png|webp|gif)(\?|$)/i;

export function isTrustedImageUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  const trusted = [
    'ifood-static.com.br',
    'ifood.com.br',
    ...appConfig().trustedImageHosts,
  ];
  return trusted.some((t) => host === t || host.endsWith(`.${t}`));
}

// Caminho relativo de imagem (ex.: "pratos/abc.jpg") só vira URL se IFOOD_IMAGE_BASE_URL estiver
// definida: não dá para adivinhar o prefixo do CDN.
export function resolve(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  let url: string | null = null;
  if (/^https:\/\//i.test(v)) {
    url = v;
  } else {
    const base = appConfig().imageBaseUrl;
    if (!base || /^[a-z]+:/i.test(v) || !IMAGE_EXT.test(v)) return null;
    try {
      url = new URL(
        v.replace(/^\/+/, ''),
        base.endsWith('/') ? base : `${base}/`,
      ).href;
    } catch {
      return null;
    }
  }
  return isTrustedImageUrl(url) ? url : null;
}
