import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { createHmac } from 'node:crypto';
import { resetAppConfig } from '../config/app-config.js';
import { isValidSignature, WhatsappController } from './whatsapp.controller.js';
import type { WhatsappService } from './whatsapp.service.js';

const SECRET = 'segredo-do-app';
const sign = (body: Buffer, secret = SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('WhatsappController (webhook)', () => {
  let whatsapp: { handleWebhook: ReturnType<typeof vi.fn> };
  let controller: WhatsappController;

  beforeEach(() => {
    process.env.WHATSAPP_ACCESS_TOKEN = 'tok';
    process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
    process.env.WHATSAPP_VERIFY_TOKEN = 'verifica';
    process.env.WHATSAPP_APP_SECRET = SECRET;
    resetAppConfig();
    whatsapp = { handleWebhook: vi.fn().mockResolvedValue(undefined) };
    controller = new WhatsappController(whatsapp as unknown as WhatsappService);
  });

  afterEach(() => {
    for (const key of [
      'WHATSAPP_ACCESS_TOKEN',
      'WHATSAPP_PHONE_NUMBER_ID',
      'WHATSAPP_VERIFY_TOKEN',
      'WHATSAPP_APP_SECRET',
    ]) {
      delete process.env[key];
    }
    resetAppConfig();
  });

  it('GET devolve o challenge quando o verify token confere', () => {
    expect(controller.verify('subscribe', 'verifica', '1158201444')).toBe(
      '1158201444',
    );
  });

  it('GET recusa verify token errado, ausente ou modo diferente de subscribe', () => {
    expect(() => controller.verify('subscribe', 'outro', 'c')).toThrow(
      ForbiddenException,
    );
    expect(() => controller.verify('subscribe', undefined, 'c')).toThrow(
      ForbiddenException,
    );
    expect(() => controller.verify('unsubscribe', 'verifica', 'c')).toThrow(
      ForbiddenException,
    );
  });

  it('POST com assinatura válida segue para o serviço', () => {
    const body = { object: 'whatsapp_business_account', entry: [] };
    const raw = Buffer.from(JSON.stringify(body));
    const req = { rawBody: raw } as RawBodyRequest<Request>;

    controller.receive(req, sign(raw), body);

    expect(whatsapp.handleWebhook).toHaveBeenCalledWith(body);
  });

  it('POST com assinatura inválida ou ausente é recusado e não processa nada', () => {
    const body = { entry: [] };
    const raw = Buffer.from(JSON.stringify(body));
    const req = { rawBody: raw } as RawBodyRequest<Request>;

    expect(() => controller.receive(req, sign(raw, 'outro'), body)).toThrow(
      UnauthorizedException,
    );
    expect(() => controller.receive(req, undefined, body)).toThrow(
      UnauthorizedException,
    );
    expect(whatsapp.handleWebhook).not.toHaveBeenCalled();
  });

  it('assinatura vale para o corpo cru exato', () => {
    const raw = Buffer.from('{"a":1}');
    expect(isValidSignature(raw, sign(raw), SECRET)).toBe(true);
    expect(isValidSignature(Buffer.from('{"a": 1}'), sign(raw), SECRET)).toBe(
      false,
    );
    expect(isValidSignature(undefined, sign(raw), SECRET)).toBe(false);
    expect(isValidSignature(raw, sign(raw).slice(7), SECRET)).toBe(false);
  });
});
