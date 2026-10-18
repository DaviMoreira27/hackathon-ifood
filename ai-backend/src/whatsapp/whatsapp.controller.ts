import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Headers,
  HttpCode,
  Post,
  Query,
  Req,
  UnauthorizedException,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { appConfig } from '../config/app-config.js';
import { WhatsappService, type WhatsappWebhook } from './whatsapp.service.js';

const safeEqual = (provided: string, expected: string) => {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

// X-Hub-Signature-256 = "sha256=" + HMAC-SHA256 do corpo cru com o app secret. Prova que o POST
// veio da Meta: sem isso, qualquer um mandaria mensagens ao agente em nome de qualquer número.
export function isValidSignature(
  rawBody: Buffer | undefined,
  header: string | undefined,
  secret: string,
): boolean {
  if (!rawBody || !header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqual(header.slice('sha256='.length), expected);
}

@Controller('whatsapp/webhook')
export class WhatsappController {
  constructor(private readonly whatsapp: WhatsappService) {}

  // Verificação feita pela Meta ao cadastrar o webhook: devolve o challenge em texto puro.
  @Get()
  @Header('Content-Type', 'text/plain')
  verify(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') token: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
  ): string {
    const expected = appConfig().whatsapp!.verifyToken;
    if (mode !== 'subscribe' || !token || !safeEqual(token, expected)) {
      throw new ForbiddenException();
    }
    return challenge ?? '';
  }

  // Responde 200 na hora e processa depois: o turno do agente leva segundos e a Meta reentrega
  // o webhook se a resposta demora.
  @Post()
  @HttpCode(200)
  receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Body() body: WhatsappWebhook,
  ): void {
    if (
      !isValidSignature(req.rawBody, signature, appConfig().whatsapp!.appSecret)
    ) {
      throw new UnauthorizedException();
    }
    void this.whatsapp.handleWebhook(body);
  }
}
