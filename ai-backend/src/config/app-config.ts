// Configuração do back (fora a de IA, que fica em agent/agent.config.ts). Lida do ambiente uma vez,
// validada no boot (main.ts): valor inválido derruba a inicialização com a lista do que está errado,
// em vez de cair em silêncio num default (foi assim que MCP_CHECKOUT_TOOL_PATTERN=checkout deixou
// o submitOrder fora da trava do checkout). Variável vazia vale o mesmo que ausente.

// Mesmo Postgres que o ./dev.sh sobe (porta 5433). Sem este padrão, a ausência de DATABASE_URL
// faria o driver tentar localhost:5432 com o usuário do sistema.
export const DEFAULT_DATABASE_URL =
  'postgresql://ifood:ifood@localhost:5433/ifood';
export const DEFAULT_WHATSAPP_GRAPH_VERSION = 'v23.0';
export const DEFAULT_CHECKOUT_TOOL_PATTERN = /submit_?order|checkout/i;
export const DEFAULT_DIET_GUARDED_TOOL_PATTERN = /add_?(item_?)?to_?cart/i;
export const DEFAULT_CART_SYNC_TOOLS = [
  'addItemToCart',
  'updateCartItem',
  'removeItemFromCart',
  'setCartDelivery',
  'setVoucher',
  'removeVoucher',
];
// Sem mcp.cart.payment (consulta de meios de pagamento) por enquanto.
const DEFAULT_IFOOD_SCOPES = [
  'mcp.user.basic.read',
  'mcp.user.advanced.read',
  'mcp.user.addresses.read',
  'mcp.user.behavior.read',
  'mcp.user.addresses.write',
  'mcp.discovery',
  'mcp.discovery.search.read',
  'mcp.discovery.browse.read',
  'mcp.discovery.recommendation.read',
  'mcp.discovery.details.read',
  'mcp.cart',
  'mcp.cart.read',
  'mcp.cart.write',
  'mcp.cart.checkout',
  'mcp.orders.read',
].join(' ');

export interface AppConfig {
  port: number;
  databaseUrl: string;
  // Conexões simultâneas com o Postgres. Um turno abre até 5 consultas em paralelo na preparação
  // e o estado do pedido mais 3: com o padrão de 10 do driver, dois chats juntos já fazem fila.
  databasePoolSize: number;
  // Canais de chat: cada um só sobe quando configurado.
  telegramBotToken?: string;
  whatsapp?: {
    accessToken: string;
    phoneNumberId: string;
    verifyToken: string;
    appSecret: string;
    graphVersion: string;
  };
  // Rota POST /telegram/send: sem chave, fica desligada.
  internalApiKey?: string;
  tokenEncryptionKey?: string;
  mcp: {
    serverUrl?: string;
    logRaw: boolean;
    // Escondidas do LLM até o pedido estar pago, e barradas para carrinhos não pagos.
    checkoutToolPattern: RegExp;
    // Adicionam item ao carrinho: passam pelo filtro de restrição alimentar.
    dietGuardedToolPattern: RegExp;
    // Alteram um carrinho: disparam o getCart + sync com o pedido em grupo.
    cartSyncTools: string[];
    // Substitui a heurística de tool-policy.ts quando definida.
    confirmTools: string[] | null;
  };
  trustedLinkHosts: string[];
  trustedImageHosts: string[];
  imageBaseUrl?: string;
  ifood: {
    authBaseUrl: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    scopes: string;
  };
  payments: {
    apiUrl: string;
    apiKey: string;
    linkTemplate: string;
    ttlMinutes: number;
    rabbitmqUrl: string;
  };
}

const read = (env: NodeJS.ProcessEnv, key: string) => {
  const value = env[key]?.trim();
  return value ? value : undefined;
};

const list = (raw: string | undefined) =>
  (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function loadAppConfig(
  env: NodeJS.ProcessEnv = process.env,
): Readonly<AppConfig> {
  const errors: string[] = [];

  const int = (key: string, fallback: number, min: number, max: number) => {
    const raw = read(env, key);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      errors.push(
        `${key} deve ser um inteiro de ${min} a ${max} (veio ${JSON.stringify(raw)})`,
      );
      return fallback;
    }
    return value;
  };

  const regex = (key: string, fallback: RegExp) => {
    const raw = read(env, key);
    if (raw === undefined) return fallback;
    try {
      return new RegExp(raw, 'i');
    } catch {
      errors.push(`${key} não é um regex válido: ${JSON.stringify(raw)}`);
      return fallback;
    }
  };

  const url = (key: string, fallback?: string) => {
    const raw = read(env, key) ?? fallback;
    if (raw === undefined) return undefined;
    try {
      new URL(raw);
    } catch {
      errors.push(`${key} não é uma URL válida: ${JSON.stringify(raw)}`);
    }
    return raw;
  };

  const linkTemplate =
    read(env, 'PAYMENT_LINK_TEMPLATE') ?? 'http://localhost:5173/pay/{token}';
  if (!linkTemplate.includes('{token}')) {
    errors.push('PAYMENT_LINK_TEMPLATE precisa conter {token}');
  }
  const confirmTools = list(read(env, 'MCP_CONFIRM_TOOLS'));
  const cartSyncTools = list(read(env, 'MCP_CART_SYNC_TOOLS'));
  const hosts = (key: string) =>
    list(read(env, key)).map((h) => h.toLowerCase());

  // WhatsApp é opcional, mas pela metade não funciona: definida uma, as quatro são obrigatórias.
  const whatsappKeys = [
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_VERIFY_TOKEN',
    'WHATSAPP_APP_SECRET',
  ] as const;
  const [waToken, waPhoneId, waVerify, waSecret] = whatsappKeys.map((key) =>
    read(env, key),
  );
  const waMissing = whatsappKeys.filter((key) => read(env, key) === undefined);
  if (waMissing.length && waMissing.length < whatsappKeys.length) {
    errors.push(
      `WhatsApp configurado pela metade: faltam ${waMissing.join(', ')}`,
    );
  }
  const whatsapp =
    waToken && waPhoneId && waVerify && waSecret
      ? {
          accessToken: waToken,
          phoneNumberId: waPhoneId,
          verifyToken: waVerify,
          appSecret: waSecret,
          graphVersion:
            read(env, 'WHATSAPP_GRAPH_VERSION') ??
            DEFAULT_WHATSAPP_GRAPH_VERSION,
        }
      : undefined;

  const config: AppConfig = {
    port: int('PORT', 3000, 1, 65535),
    databaseUrl: read(env, 'DATABASE_URL') ?? DEFAULT_DATABASE_URL,
    databasePoolSize: int('DATABASE_POOL_SIZE', 20, 1, 200),
    telegramBotToken: read(env, 'TELEGRAM_BOT_TOKEN'),
    whatsapp,
    internalApiKey: read(env, 'INTERNAL_API_KEY'),
    tokenEncryptionKey: read(env, 'TOKEN_ENCRYPTION_KEY'),
    mcp: {
      serverUrl: url('MCP_SERVER_URL'),
      logRaw: read(env, 'MCP_LOG_RAW') === '1',
      checkoutToolPattern: regex(
        'MCP_CHECKOUT_TOOL_PATTERN',
        DEFAULT_CHECKOUT_TOOL_PATTERN,
      ),
      dietGuardedToolPattern: regex(
        'DIET_GUARDED_TOOL_PATTERN',
        DEFAULT_DIET_GUARDED_TOOL_PATTERN,
      ),
      cartSyncTools: cartSyncTools.length
        ? cartSyncTools
        : DEFAULT_CART_SYNC_TOOLS,
      confirmTools: confirmTools.length ? confirmTools : null,
    },
    trustedLinkHosts: hosts('TRUSTED_LINK_HOSTS'),
    trustedImageHosts: hosts('TRUSTED_IMAGE_HOSTS'),
    imageBaseUrl: url('IFOOD_IMAGE_BASE_URL'),
    ifood: {
      authBaseUrl: url('IFOOD_AUTH_BASE_URL', 'https://id.ifood.com.br')!,
      clientId: read(env, 'IFOOD_CLIENT_ID') ?? '',
      clientSecret: read(env, 'IFOOD_CLIENT_SECRET') ?? '',
      redirectUri: url('IFOOD_REDIRECT_URI', 'http://localhost:3000/redirect')!,
      scopes: read(env, 'IFOOD_SCOPES') ?? DEFAULT_IFOOD_SCOPES,
    },
    payments: {
      apiUrl: url('PAYMENTS_API_URL', 'http://localhost:3001')!,
      apiKey: read(env, 'PAYMENTS_API_KEY') ?? 'dev-mock-key',
      linkTemplate,
      ttlMinutes: int('PAYMENT_TTL_MINUTES', 24 * 60, 1, 60 * 24 * 30),
      rabbitmqUrl:
        read(env, 'RABBITMQ_URL') ?? 'amqp://ifood:ifood@localhost:5672',
    },
  };

  if (errors.length) {
    throw new Error(`Configuração inválida no .env:\n- ${errors.join('\n- ')}`);
  }
  return Object.freeze(config);
}

let current: Readonly<AppConfig> | undefined;

export function appConfig(): Readonly<AppConfig> {
  current ??= loadAppConfig();
  return current;
}

// Só para testes que mudam process.env: a próxima leitura relê o ambiente.
export function resetAppConfig(): void {
  current = undefined;
}
