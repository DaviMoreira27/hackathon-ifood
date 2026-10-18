import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';
import { UNTRUSTED_TAG } from './tool-policy.js';

// Fotos de pratos e logos de lojas. O LLM escolhe quais mostrar escrevendo, numa linha própria,
// ![](item:<itemId>) ou ![](merchant:<merchantId>) — ou ![legenda](url) com a URL exata.
// O código troca a referência pela imagem que a ferramenta devolveu (itemImageUrl /
// merchantLogoUrl do Offer Discovery MCP) e monta a legenda com nome e preço tirados do próprio
// resultado, sem depender do que o LLM escreveu. Só valem imagens que apareceram em resultados de
// ferramentas E que estão num domínio confiável: um texto injetado no catálogo não consegue
// fazer o bot mandar uma imagem qualquer (ex.: um QR Code PIX falso).

export interface ReplyImage {
  url: string;
  caption: string;
}

interface CatalogImage {
  url: string;
  // Legenda montada a partir dos dados da ferramenta ('' quando não há dados estruturados).
  caption: string;
}

export interface ImageCatalog {
  byUrl: Map<string, CatalogImage>;
  // 'item:<itemId>' e 'merchant:<merchantId>'.
  byRef: Map<string, CatalogImage>;
}

export const MAX_REPLY_IMAGES = 6;
const MAX_CAPTION = 200;
// Campos genéricos de imagem, para formatos que não conhecemos.
const IMAGE_KEY = /image|img|logo|photo|picture|thumb|banner|cover/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif)(\?|$)/i;
const URL_IN_TEXT = /https:\/\/[^\s"'<>()\\]+/g;
const MARKDOWN_IMAGE =
  /!\[([^\]\n]*)\]\(((?:https?:\/\/|item:|merchant:)[^)\s]+)\)/g;

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
    ...(process.env.TRUSTED_IMAGE_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  ];
  return trusted.some((t) => host === t || host.endsWith(`.${t}`));
}

// Caminho relativo de imagem (ex.: "pratos/abc.jpg") só vira URL se IFOOD_IMAGE_BASE_URL estiver
// definida: não dá para adivinhar o prefixo do CDN.
function resolve(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  let url: string | null = null;
  if (/^https:\/\//i.test(v)) {
    url = v;
  } else {
    const base = process.env.IFOOD_IMAGE_BASE_URL;
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

// ─── Legendas a partir dos campos do Offer Discovery MCP ─────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const text = (v: unknown, max = 60): string =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';

const brl = (value: number) =>
  `R$ ${value
    .toFixed(2)
    .replace('.', ',')
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;

// Preço final do item: promotionalUnitPrice quando existe (e é menor), senão unitPrice.
function priceLabel(o: Obj): string {
  const unit = num(o.unitPrice);
  const promo = num(o.promotionalUnitPrice);
  if (promo !== null && unit !== null && promo < unit) {
    return `${brl(promo)} (de ${brl(unit)})`;
  }
  const price = promo ?? unit;
  return price === null ? '' : brl(price);
}

// Taxa de entrega: promotionalFee quando existe, senão fee. Em getMerchant (deliveryMethods[]),
// vale o método mais barato.
function deliveryLabel(o: Obj): string {
  const methods = Array.isArray(o.deliveryMethods)
    ? o.deliveryMethods.filter(isObj)
    : isObj(o.deliveryMethod)
      ? [o.deliveryMethod]
      : [];
  const fees = methods
    .map((m) => num(m.promotionalFee) ?? num(m.fee))
    .filter((f): f is number => f !== null);
  if (fees.length === 0) return '';
  const fee = Math.min(...fees);
  return fee === 0 ? 'entrega grátis' : `entrega ${brl(fee)}`;
}

function merchantCaption(o: Obj): string {
  const rating = num(o.reviewRating);
  return [
    text(o.merchantName),
    rating === null ? '' : `⭐ ${rating.toFixed(1).replace('.', ',')}`,
    deliveryLabel(o),
  ]
    .filter(Boolean)
    .join(' · ');
}

// featuredItems de getMerchant não repetem o nome da loja: vem do objeto pai (inheritedMerchant).
function itemCaption(o: Obj, inheritedMerchant: string): string {
  const merchant =
    text(o.merchantName) ||
    (isObj(o.merchant) ? text(o.merchant.merchantName) : '') ||
    inheritedMerchant;
  const name = text(o.itemName, 80);
  const price = priceLabel(o);
  return [name && price ? `${name} — ${price}` : name || price, merchant]
    .filter(Boolean)
    .join(' · ');
}

function add(
  catalog: ImageCatalog,
  url: string | null,
  caption: string,
  ref?: string,
): void {
  if (!url) return;
  const entry = { url, caption: caption.slice(0, MAX_CAPTION) };
  // Dados estruturados ganham do fallback genérico; o primeiro registro estruturado fica.
  const current = catalog.byUrl.get(url);
  if (!current || (!current.caption && entry.caption))
    catalog.byUrl.set(url, entry);
  if (ref && !catalog.byRef.has(ref)) catalog.byRef.set(ref, entry);
}

function walk(
  value: unknown,
  key: string,
  catalog: ImageCatalog,
  depth = 0,
  inheritedMerchant = '',
): void {
  if (depth > 12) return;
  if (typeof value === 'string') {
    if (IMAGE_KEY.test(key)) add(catalog, resolve(value), '');
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value)
      walk(item, key, catalog, depth + 1, inheritedMerchant);
    return;
  }
  if (!isObj(value)) return;

  const itemImage = resolve(value.itemImageUrl);
  if (itemImage) {
    const itemId = text(value.itemId, 64);
    add(
      catalog,
      itemImage,
      itemCaption(value, inheritedMerchant),
      itemId ? `item:${itemId}` : undefined,
    );
  }
  const logo = resolve(value.merchantLogoUrl);
  if (logo && (value.merchantName || value.merchantId)) {
    const merchantId = text(value.merchantId, 64);
    // Num resultado de ITEM, o objeto tem itemId e merchantLogoUrl só no merchant aninhado;
    // aqui é o próprio objeto da loja.
    if (!value.itemId) {
      add(
        catalog,
        logo,
        merchantCaption(value),
        merchantId ? `merchant:${merchantId}` : undefined,
      );
    }
  }
  const merchantName = text(value.merchantName) || inheritedMerchant;
  for (const [k, v] of Object.entries(value))
    walk(v, k, catalog, depth + 1, merchantName);
}

const unwrap = (content: string) =>
  content
    .replace(new RegExp(`^<${UNTRUSTED_TAG}[^>]*>\\n`), '')
    .replace(new RegExp(`\\n</${UNTRUSTED_TAG}>$`), '');

function collect(content: string, catalog: ImageCatalog): void {
  const body = unwrap(content);
  try {
    walk(JSON.parse(body), '', catalog);
  } catch {
    // Não é JSON: fica só a busca por URLs no texto.
  }
  for (const url of body.match(URL_IN_TEXT) ?? []) {
    if (IMAGE_EXT.test(url)) add(catalog, resolve(url), '');
  }
}

const emptyCatalog = (): ImageCatalog => ({
  byUrl: new Map(),
  byRef: new Map(),
});

// Imagens de um único resultado de ferramenta.
export function extractImages(content: string): ImageCatalog {
  const catalog = emptyCatalog();
  collect(content, catalog);
  return catalog;
}

// Todas as imagens que as ferramentas devolveram na conversa (histórico + turno atual).
export function imageCatalog(messages: MessageParam[]): ImageCatalog {
  const catalog = emptyCatalog();
  for (const message of messages) {
    if (message.role !== 'user' || typeof message.content === 'string')
      continue;
    for (const block of message.content) {
      if (block.type === 'tool_result' && typeof block.content === 'string') {
        collect(block.content, catalog);
      }
    }
  }
  return catalog;
}

// Tira as imagens do texto (o Telegram as recebe como fotos) e devolve só as permitidas.
export function takeImages(
  reply: string,
  catalog: ImageCatalog,
): { text: string; images: ReplyImage[] } {
  const images: ReplyImage[] = [];
  const seen = new Set<string>();
  const cleaned = reply.replace(
    MARKDOWN_IMAGE,
    (_, caption: string, target: string) => {
      const entry = /^https?:/i.test(target)
        ? catalog.byUrl.get(target)
        : catalog.byRef.get(target);
      if (entry && !seen.has(entry.url) && images.length < MAX_REPLY_IMAGES) {
        seen.add(entry.url);
        images.push({
          url: entry.url,
          caption:
            entry.caption ||
            caption.replace(/\s+/g, ' ').trim().slice(0, MAX_CAPTION),
        });
      }
      return '';
    },
  );
  return {
    text: cleaned
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    images,
  };
}
