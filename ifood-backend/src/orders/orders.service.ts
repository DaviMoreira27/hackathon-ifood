import {
  BadRequestException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { MockDbService } from '../db/mock-db.service.js';
import type { ChargeStatus } from '../payments/payments.service.js';
import { hashToken } from '../payments/token.js';

export interface SnapshotItem {
  id: string;
  name: string;
  description: string | null;
  quantity: number;
  unitPriceCents: number;
  options: { name: string; quantity: number }[];
}

export interface SnapshotSubOrder {
  // reference da cobrança deste subpedido
  chargeReference: string;
  participant: string;
  restaurant: { name: string };
  eta: string | null;
  items: SnapshotItem[];
}

export interface OrderSnapshot {
  label: string;
  address: { street: string; district: string; complement: string } | null;
  subOrders: SnapshotSubOrder[];
}

export interface PayerOrderView {
  reference: string;
  label: string;
  address: OrderSnapshot['address'];
  // subpedido do dono do link (o único que ele pode pagar)
  ownChargeReference: string;
  subOrders: (SnapshotSubOrder & {
    amountCents: number;
    status: ChargeStatus | 'missing';
    paidAt: string | null;
  })[];
}

const MAX_SUB_ORDERS = 50;
const MAX_ITEMS = 50;
const MAX_OPTIONS = 30;

const str = (v: unknown, max = 200): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';
const optStr = (v: unknown, max = 300): string | null => str(v, max) || null;
const int = (v: unknown, min: number, max: number): number | null =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max
    ? (v as number)
    : null;
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const arr = (v: unknown, max: number): unknown[] =>
  Array.isArray(v) ? v.slice(0, max) : [];

// O snapshot vem de outro serviço com dados do MCP: guarda só os campos conhecidos, com limites.
export function sanitizeSnapshot(body: unknown): OrderSnapshot {
  const raw = obj(body);
  if (!Array.isArray(raw.subOrders) || raw.subOrders.length === 0) {
    throw new BadRequestException('subOrders é obrigatório');
  }
  if (raw.subOrders.length > MAX_SUB_ORDERS) {
    throw new BadRequestException(`no máximo ${MAX_SUB_ORDERS} subpedidos`);
  }
  const address = obj(raw.address);
  return {
    label: str(raw.label, 40),
    address: str(address.street)
      ? {
          street: str(address.street),
          district: str(address.district),
          complement: str(address.complement),
        }
      : null,
    subOrders: raw.subOrders.map((s) => {
      const sub = obj(s);
      const chargeReference = str(sub.chargeReference, 100);
      if (!chargeReference) {
        throw new BadRequestException('chargeReference é obrigatório');
      }
      const restaurant = obj(sub.restaurant);
      return {
        chargeReference,
        participant: str(sub.participant, 80),
        restaurant: { name: str(restaurant.name) || 'Restaurante' },
        eta: optStr(sub.eta, 60),
        items: arr(sub.items, MAX_ITEMS).map((i, index) => {
          const item = obj(i);
          return {
            id: str(item.id, 100) || String(index),
            name: str(item.name) || 'Item',
            description: optStr(item.description),
            quantity: int(item.quantity, 1, 1000) ?? 1,
            unitPriceCents: int(item.unitPriceCents, 0, 10_000_000) ?? 0,
            options: arr(item.options, MAX_OPTIONS)
              .map((o) => ({
                name: str(obj(o).name, 120),
                quantity: int(obj(o).quantity, 1, 1000) ?? 1,
              }))
              .filter((o) => o.name),
          };
        }),
      };
    }),
  };
}

interface ChargeRow {
  reference: string;
  amount_cents: number;
  status: 'pending' | 'paid' | 'cancelled';
  expires_at: Date;
  paid_at: Date | null;
}

const statusOf = (row: ChargeRow): ChargeStatus =>
  row.status === 'pending' && row.expires_at.getTime() <= Date.now()
    ? 'expired'
    : row.status;

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(private readonly database: MockDbService) {}

  private get pool() {
    return this.database.pool;
  }

  // Idempotente: o ai-backend reenvia o pedido inteiro sempre que emite/reemite cobranças.
  async upsert(reference: string, body: unknown): Promise<{ ok: true }> {
    if (!reference || reference.length > 100) {
      throw new BadRequestException('reference inválida');
    }
    const snapshot = sanitizeSnapshot(body);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO mock_ifood.orders (reference, snapshot) VALUES ($1, $2)
         ON CONFLICT (reference) DO UPDATE SET snapshot = EXCLUDED.snapshot, updated_at = now()`,
        [reference, JSON.stringify(snapshot)],
      );
      await client.query(
        'DELETE FROM mock_ifood.order_charges WHERE order_reference = $1',
        [reference],
      );
      await client.query(
        `INSERT INTO mock_ifood.order_charges (charge_reference, order_reference)
         SELECT unnest($1::text[]), $2
         ON CONFLICT (charge_reference) DO UPDATE SET order_reference = EXCLUDED.order_reference`,
        [snapshot.subOrders.map((s) => s.chargeReference), reference],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    this.logger.log(
      `[order] ${reference} salvo (${snapshot.subOrders.length} subpedido(s))`,
    );
    return { ok: true };
  }

  // Front do pagador: o token do link é a credencial. Nunca devolve tokens de outras cobranças.
  async getByToken(token: string): Promise<PayerOrderView> {
    const { rows: own } = await this.pool.query<
      ChargeRow & { order_reference: string | null; snapshot: OrderSnapshot }
    >(
      `SELECT c.*, oc.order_reference, o.snapshot
         FROM mock_ifood.charges c
         LEFT JOIN mock_ifood.order_charges oc ON oc.charge_reference = c.reference
         LEFT JOIN mock_ifood.orders o ON o.reference = oc.order_reference
        WHERE c.token_hash = $1`,
      [hashToken(token)],
    );
    const mine = own[0];
    if (!mine) throw new NotFoundException('Link de pagamento inválido');
    if (mine.status === 'cancelled') {
      throw new GoneException(
        'Este link de pagamento foi cancelado. Peça um novo ao dono do pedido.',
      );
    }
    if (!mine.order_reference || !mine.snapshot) {
      throw new NotFoundException('Pedido ainda não disponível');
    }

    const { snapshot } = mine;
    const { rows: charges } = await this.pool.query<ChargeRow>(
      'SELECT * FROM mock_ifood.charges WHERE reference = ANY($1::text[])',
      [snapshot.subOrders.map((s) => s.chargeReference)],
    );
    const byRef = new Map(charges.map((c) => [c.reference, c]));

    return {
      reference: mine.order_reference,
      label: snapshot.label || mine.order_reference,
      address: snapshot.address,
      ownChargeReference: mine.reference,
      subOrders: snapshot.subOrders.map((s) => {
        const charge = byRef.get(s.chargeReference);
        return {
          ...s,
          amountCents: charge?.amount_cents ?? 0,
          status: charge ? statusOf(charge) : 'missing',
          paidAt: charge?.paid_at ? charge.paid_at.toISOString() : null,
        };
      }),
    };
  }
}
