import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';
import { isObj, text as clean } from '../common/json.js';
import { unwrapToolText } from './tool-envelope.js';
import { itemCaption, merchantCaption } from './image-captions.js';
import { IMAGE_EXT, resolve } from './image-trust.js';

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
const URL_IN_TEXT = /https:\/\/[^\s"'<>()\\]+/g;
const MARKDOWN_IMAGE =
  /!\[([^\]\n]*)\]\(((?:https?:\/\/|item:|merchant:)[^)\s]+)\)/g;

const text = (v: unknown, max = 60): string => clean(v, max);

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

function collect(content: string, catalog: ImageCatalog): void {
  const body = unwrapToolText(content);
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
