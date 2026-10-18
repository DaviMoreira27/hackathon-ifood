import { Injectable, Logger } from '@nestjs/common';

export interface CreateChargeRequest {
  reference: string;
  amountCents: number;
  description: string;
  expiresInMinutes: number;
}

export interface Charge {
  id: string;
  token: string;
  expiresAt: string;
}

export type CancelResult = 'cancelled' | 'paid' | 'not_found';

const TIMEOUT_MS = 5000;
const ATTEMPTS = 2;

// Cliente HTTP do provedor de pagamento (hoje, o mock do iFood). Criar e cancelar são
// idempotentes no provedor, então repetir em falha de rede/5xx é seguro.
@Injectable()
export class PaymentProviderClient {
  private readonly logger = new Logger(PaymentProviderClient.name);

  private get baseUrl(): string {
    return (process.env.PAYMENTS_API_URL ?? 'http://localhost:3001').replace(
      /\/+$/,
      '',
    );
  }

  private get apiKey(): string {
    return process.env.PAYMENTS_API_KEY ?? 'dev-mock-key';
  }

  async createCharge(request: CreateChargeRequest): Promise<Charge> {
    const response = await this.post('/payments', request);
    if (response.status !== 200 && response.status !== 201) {
      throw new Error(
        `Provedor recusou a cobrança (HTTP ${response.status}): ${await response.text()}`,
      );
    }
    const body = (await response.json()) as Partial<Charge>;
    if (!body.id || !body.token || !body.expiresAt) {
      throw new Error('Resposta do provedor sem id/token/expiresAt');
    }
    return { id: body.id, token: body.token, expiresAt: body.expiresAt };
  }

  async cancelCharge(reference: string): Promise<CancelResult> {
    const response = await this.post('/payments/cancel', { reference });
    if (response.status === 404) return 'not_found';
    if (response.status === 409) return 'paid';
    if (!response.ok) {
      throw new Error(
        `Provedor recusou o cancelamento (HTTP ${response.status}): ${await response.text()}`,
      );
    }
    return 'cancelled';
  }

  private async post(path: string, body: unknown): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (response.status < 500 || attempt === ATTEMPTS) return response;
        lastError = new Error(`HTTP ${response.status}`);
      } catch (err) {
        lastError = err;
      }
      this.logger.warn(
        `POST ${path} falhou (tentativa ${attempt}/${ATTEMPTS}): ${String(lastError)}`,
      );
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
