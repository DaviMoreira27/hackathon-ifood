import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PaymentsModule } from './payments.module.js';
import { MockDbService } from '../db/mock-db.service.js';

// Roda contra um Postgres real. Exemplo:
//   TEST_DATABASE_URL=postgresql://ifood:ifood@localhost:5433/ifood npm test
// O RabbitMQ aqui fica de propósito inalcançável: o que interessa é o outbox (a publicação é
// testada em events.integration.spec.ts).
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'API de pagamentos (HTTP)',
  () => {
    const PREFIX = `http-${Date.now()}-`;
    const KEY = { 'x-api-key': 'dev-mock-key' };
    let app: INestApplication;
    let db: MockDbService;
    let seq = 0;
    const ref = () => `${PREFIX}${++seq}`;

    const create = (reference: string, amountCents = 4290, extra = {}) =>
      request(app.getHttpServer())
        .post('/payments')
        .set(KEY)
        .send({ reference, amountCents, description: 'Pizza', ...extra });

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
      await db.pool.query(
        'DELETE FROM mock_ifood.charges WHERE reference LIKE $1',
        [`${PREFIX}%`],
      );
      await app.close();
    });

    it('exige a x-api-key nas rotas servidor-a-servidor', async () => {
      await request(app.getHttpServer())
        .post('/payments')
        .send({ reference: ref(), amountCents: 100 })
        .expect(401);
      await request(app.getHttpServer())
        .post('/payments')
        .set('x-api-key', 'errada')
        .send({ reference: ref(), amountCents: 100 })
        .expect(401);
      await request(app.getHttpServer())
        .post('/payments/cancel')
        .send({ reference: 'x' })
        .expect(401);
    });

    it('valida o corpo', async () => {
      await create('', 100).expect(400);
      await create(ref(), 0).expect(400);
      await create(ref(), -5).expect(400);
      await create(ref(), 10.5).expect(400);
      await create(ref(), 100, { expiresInMinutes: 0 }).expect(400);
      await request(app.getHttpServer())
        .post('/payments')
        .set(KEY)
        .send({ amountCents: 100 })
        .expect(400);
    });

    it('cria a cobrança, e repetir a chamada devolve a mesma (idempotente)', async () => {
      const reference = ref();
      const first = await create(reference).expect(201);
      expect(first.body).toMatchObject({
        amountCents: 4290,
        status: 'pending',
        description: 'Pizza',
      });
      expect(first.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const again = await create(reference).expect(200);
      expect(again.body.token).toBe(first.body.token);
      expect(again.body.id).toBe(first.body.id);

      await create(reference, 9999).expect(409);
    });

    it('não guarda o token em texto puro', async () => {
      const reference = ref();
      const { body } = await create(reference).expect(201);
      const { rows } = await db.pool.query(
        'SELECT token_hash FROM mock_ifood.charges WHERE reference = $1',
        [reference],
      );
      expect(rows[0].token_hash).not.toBe(body.token);
      expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('o front consulta pelo token e não recebe a referência interna', async () => {
      const { body } = await create(ref()).expect(201);

      const view = await request(app.getHttpServer())
        .get(`/payments/by-token/${body.token}`)
        .expect(200);
      expect(view.body).toMatchObject({ amountCents: 4290, status: 'pending' });
      expect(view.body.reference).toBeUndefined();
      expect(view.body.token).toBeUndefined();

      await request(app.getHttpServer())
        .get('/payments/by-token/nao-existe')
        .expect(404);
    });

    it('pagar muda o status, grava UM evento no outbox e o segundo pagamento é recusado', async () => {
      const reference = ref();
      const { body } = await create(reference).expect(201);

      const paid = await request(app.getHttpServer())
        .post(`/payments/by-token/${body.token}/pay`)
        .expect(201);
      expect(paid.body.status).toBe('paid');
      expect(paid.body.paidAt).toBeTruthy();

      const second = await request(app.getHttpServer())
        .post(`/payments/by-token/${body.token}/pay`)
        .expect(409);
      expect(second.body.status).toBe('paid');

      const { rows } = await db.pool.query(
        `SELECT payload FROM mock_ifood.outbox WHERE payload->'data'->>'reference' = $1`,
        [reference],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].payload).toMatchObject({
        type: 'payment.confirmed',
        version: 1,
        data: { reference, amountCents: 4290, paymentId: body.id },
      });
      expect(rows[0].payload.eventId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('pagamentos simultâneos do mesmo link: só um vence e só um evento é criado', async () => {
      const reference = ref();
      const { body } = await create(reference).expect(201);

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          request(app.getHttpServer()).post(
            `/payments/by-token/${body.token}/pay`,
          ),
        ),
      );

      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(7);
      const { rows } = await db.pool.query(
        `SELECT count(*)::int AS n FROM mock_ifood.outbox WHERE payload->'data'->>'reference' = $1`,
        [reference],
      );
      expect(rows[0].n).toBe(1);
    });

    it('cobrança expirada não pode ser paga', async () => {
      const reference = ref();
      const { body } = await create(reference, 100, {
        expiresInMinutes: 5,
      }).expect(201);
      await db.pool.query(
        `UPDATE mock_ifood.charges SET expires_at = now() - interval '1 minute' WHERE reference = $1`,
        [reference],
      );

      const view = await request(app.getHttpServer()).get(
        `/payments/by-token/${body.token}`,
      );
      expect(view.body.status).toBe('expired');
      const pay = await request(app.getHttpServer())
        .post(`/payments/by-token/${body.token}/pay`)
        .expect(409);
      expect(pay.body.status).toBe('expired');

      const { rows } = await db.pool.query(
        `SELECT count(*)::int AS n FROM mock_ifood.outbox WHERE payload->'data'->>'reference' = $1`,
        [reference],
      );
      expect(rows[0].n).toBe(0);
    });

    it('cancelar: idempotente, impede o pagamento, e não cancela o que já foi pago', async () => {
      const cancelRef = ref();
      const cancelled = await create(cancelRef);
      const cancel = () =>
        request(app.getHttpServer())
          .post('/payments/cancel')
          .set(KEY)
          .send({ reference: cancelRef });

      expect((await cancel().expect(201)).body.status).toBe('cancelled');
      expect((await cancel().expect(201)).body.status).toBe('cancelled'); // idempotente
      const pay = await request(app.getHttpServer())
        .post(`/payments/by-token/${cancelled.body.token}/pay`)
        .expect(409);
      expect(pay.body.status).toBe('cancelled');

      const paidRef = ref();
      const paid = await create(paidRef);
      await request(app.getHttpServer())
        .post(`/payments/by-token/${paid.body.token}/pay`)
        .expect(201);
      const denied = await request(app.getHttpServer())
        .post('/payments/cancel')
        .set(KEY)
        .send({ reference: paidRef })
        .expect(409);
      expect(denied.body.status).toBe('paid');

      await request(app.getHttpServer())
        .post('/payments/cancel')
        .set(KEY)
        .send({ reference: 'nao-existe' })
        .expect(404);
      await request(app.getHttpServer())
        .post('/payments/cancel')
        .set(KEY)
        .send({})
        .expect(400);
    });
  },
);
