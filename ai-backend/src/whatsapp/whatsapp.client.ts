import { Injectable, Logger } from '@nestjs/common';
import { appConfig } from '../config/app-config.js';

export interface WhatsappButton {
  id: string;
  title: string;
}

// Erro devolvido pela Graph API. code é o código da Meta (ex.: 131047 = fora da janela de 24h).
export class WhatsappApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
  }
}

// Cliente fino da Cloud API do WhatsApp (POST /{phone-number-id}/messages).
@Injectable()
export class WhatsappClient {
  private readonly logger = new Logger(WhatsappClient.name);

  async sendText(to: string, body: string): Promise<void> {
    await this.post('sendText', {
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body, preview_url: true },
    });
  }

  async sendImage(to: string, link: string, caption?: string): Promise<void> {
    await this.post('sendImage', {
      recipient_type: 'individual',
      to,
      type: 'image',
      image: { link, ...(caption ? { caption } : {}) },
    });
  }

  // Botões de resposta: até 3, título com até 20 caracteres, corpo com até 1024.
  async sendButtons(
    to: string,
    body: string,
    buttons: WhatsappButton[],
  ): Promise<void> {
    await this.post('sendButtons', {
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body },
        action: {
          buttons: buttons.map((b) => ({
            type: 'reply',
            reply: { id: b.id, title: b.title },
          })),
        },
      },
    });
  }

  // Marca a mensagem como lida e mostra "digitando..." até a resposta (ou 25s).
  async markReadWithTyping(messageId: string): Promise<void> {
    await this.post('markRead', {
      status: 'read',
      message_id: messageId,
      typing_indicator: { type: 'text' },
    });
  }

  private async post(
    label: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const config = appConfig().whatsapp!;
    const url = `https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`;
    await this.withRetry(label, async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
      });
      if (response.ok) return;
      const body = (await response.json().catch(() => ({}))) as {
        error?: { code?: number; message?: string };
      };
      throw new WhatsappApiError(
        response.status,
        body.error?.code,
        `WhatsApp ${response.status}: ${body.error?.message ?? response.statusText}`,
      );
    });
  }

  // Repete em falhas de rede, 429 e 5xx. Erros 4xx de requisição não são repetidos.
  private async withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const delayMs = retryDelayMs(err, attempt);
        if (delayMs === null || attempt >= MAX_ATTEMPTS) throw err;
        this.logger.warn(
          `[whatsapp] ${label} falhou (tentativa ${attempt}/${MAX_ATTEMPTS}): ${String(err)} — nova tentativa em ${delayMs}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
}

const MAX_ATTEMPTS = 4;

function retryDelayMs(err: unknown, attempt: number): number | null {
  const backoff = 500 * 2 ** (attempt - 1); // 500ms, 1s, 2s
  if (!(err instanceof WhatsappApiError)) return backoff;
  if (err.status === 429 || err.status >= 500) return backoff;
  return null;
}
