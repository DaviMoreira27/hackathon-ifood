import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PaymentsModule } from '../payments/payments.module.js';
import { MockDbService } from '../db/mock-db.service.js';
import { sanitizeSnapshot } from './orders.service.js';

describe('sanitizeSnapshot', () => {
  it('guarda só os campos conhecidos, com padrões', () => {
    const s = sanitizeSnapshot({
      label: '#7',
      hack: 'x',
      subOrders: [
        {
          chargeReference: '10',
          participant: 'João',
          restaurant: { name: 'Pizza Express', evil: '<script>' },
          items: [
            {
              name: 'Margherita',
              quantity: 2,
              unitPriceCents: 3290,
              options: [{ name: 'Borda' }, { quantity: 2 }],
              token: 'segredo',
            },
          ],
        },
      ],
    });
    expect(s).toEqual({
      label: '#7',
      address: null,
      subOrders: [
        {
          chargeReference: '10',
          participant: 'João',
          restaurant: { name: 'Pizza Express' },
          eta: null,
          items: [
            {
              id: '0',
              name: 'Margherita',
              description: null,
              quantity: 2,
              unitPriceCents: 3290,
              options: [{ name: 'Borda', quantity: 1 }],
            },
          ],
        },
      ],
    });
  });

  it('recusa pedido sem subpedidos ou sem referência de cobrança', () => {
    expect(() => sanitizeSnapshot({})).toThrow();
    expect(() => sanitizeSnapshot({ subOrders: [] })).toThrow();
    expect(() => sanitizeSnapshot({ subOrders: [{ participant: 'A' }] })).toThrow();
  });
});

// Roda contra um Postgres real. Exemplo:
//   TEST_DATABASE_URL=postgresql://ifood:ifood@localhost:5433/ifood npm test
describe.skipIf(!process.env.TEST_DATABASE_URL)('API de pedidos (HTTP)', () => {
  const PREFIX = `order-http-${Date.now()}-`;
  const KEY = { 'x-api-key': 'dev-mock-key' };
  let app: INestApplication;
  let db: MockDbService;

  const charge = (reference: string, amountCents: number) =>
    request(app.getHttpServer())
      .post('/payments')
      .set(KEY)
      .send({ reference, amountCents, description: 'teste' })
      .expect(201)
      .then((r) => r.body as { token: string });

  const snapshot = (refs: string[]) => ({
    label: '#1',
    address: { street: 'Rua Augusta, 1234', district: 'Consolação', complement: '' },
    subOrders: refs.map((chargeReference, i) => ({
      chargeReference,
      participant: `Pessoa ${i + 1}`,
      restaurant: { name: 'Pizza Express' },
      eta: 'Hoje, 30 - 45min',
      items: [{ id: String(i), name: 'Margherita', quantity: 1, unitPriceCents: 3290 }],
    })),
  });

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.RABBITMQ_URL = 'amqp://nobody:nobody@127.0.0.1:1';
    const module = await Test.createTestingModule({
      imports: [PaymentsModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    db = app.get(MockDbService);
  });

  afterAll(async () => {
    await db.pool.query(
      `DELETE FROM mock_ifood.outbox WHERE payload->'data'->>'reference' LIKE $1`,
      [`${PREFIX}%`],
    );
    await db.pool.query('DELETE FROM mock_ifood.orders WHERE reference LIKE $1', [`${PREFIX}%`]);
    await db.pool.query('DELETE FROM mock_ifood.charges WHERE reference LIKE $1', [`${PREFIX}%`]);
    await app.close();
  });

  it('PUT exige a x-api-key', async () => {
    await request(app.getHttpServer())
      .put(`/orders/${PREFIX}x`)
      .send(snapshot(['a']))
      .expect(401);
  });

  it('o link mostra o pedido inteiro com o status de cada cobrança, sem tokens', async () => {
    const order = `${PREFIX}o1`;
    const [a, b] = [`${PREFIX}a`, `${PREFIX}b`];
    const tokenA = (await charge(a, 3790)).token;
    const tokenB = (await charge(b, 3790)).token;

    await request(app.getHttpServer())
      .put(`/orders/${order}`)
      .set(KEY)
      .send(snapshot([a, b]))
      .expect(200);

    await request(app.getHttpServer()).post(`/payments/by-token/${tokenB}/pay`).expect(201);

    const { body } = await request(app.getHttpServer())
      .get(`/orders/by-token/${tokenA}`)
      .expect(200);
    expect(body).toMatchObject({
      reference: order,
      label: '#1',
      ownChargeReference: a,
      address: { street: 'Rua Augusta, 1234' },
    });
    expect(body.subOrders.map((s: { status: string }) => s.status)).toEqual(['pending', 'paid']);
    expect(body.subOrders[0]).toMatchObject({ amountCents: 3790, participant: 'Pessoa 1' });
    expect(JSON.stringify(body)).not.toContain(tokenA);
    expect(JSON.stringify(body)).not.toContain(tokenB);
  });

  it('reenviar o pedido substitui os subpedidos', async () => {
    const order = `${PREFIX}o2`;
    const [a, b] = [`${PREFIX}c`, `${PREFIX}d`];
    const tokenA = (await charge(a, 1000)).token;
    await charge(b, 1000);
    const put = (refs: string[]) =>
      request(app.getHttpServer()).put(`/orders/${order}`).set(KEY).send(snapshot(refs)).expect(200);

    await put([a, b]);
    await put([a]);
    const { body } = await request(app.getHttpServer()).get(`/orders/by-token/${tokenA}`).expect(200);
    expect(body.subOrders).toHaveLength(1);
  });

  it('token inválido → 404; cobrança sem pedido → 404; cobrança cancelada → 410', async () => {
    await request(app.getHttpServer()).get('/orders/by-token/nao-existe').expect(404);

    const orphan = `${PREFIX}orphan`;
    const { token } = await charge(orphan, 500);
    await request(app.getHttpServer()).get(`/orders/by-token/${token}`).expect(404);

    await request(app.getHttpServer())
      .put(`/orders/${PREFIX}o3`)
      .set(KEY)
      .send(snapshot([orphan]))
      .expect(200);
    await request(app.getHttpServer())
      .post('/payments/cancel')
      .set(KEY)
      .send({ reference: orphan })
      .expect(201);
    await request(app.getHttpServer()).get(`/orders/by-token/${token}`).expect(410);
  });
});
