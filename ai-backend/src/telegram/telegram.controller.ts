import {
  Body,
  Controller,
  Headers,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { TelegramService } from './telegram.service.js';

interface SendMessageDto {
  chatId: number;
  text: string;
}

// Sem chave, qualquer um que alcance a porta mandaria mensagens em nome do bot para qualquer chat
// (ex.: um "link de login" falso). Sem INTERNAL_API_KEY definida, a rota fica desligada.
function isAuthorized(provided: string | undefined): boolean {
  const expected = process.env.INTERNAL_API_KEY;
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

@Controller('telegram')
export class TelegramController {
  constructor(private readonly telegramService: TelegramService) {}

  @Post('send')
  async send(
    @Headers('x-internal-api-key') apiKey: string | undefined,
    @Body() body: SendMessageDto,
  ): Promise<{ ok: boolean }> {
    if (!isAuthorized(apiKey)) throw new UnauthorizedException();
    if (
      typeof body?.chatId !== 'number' ||
      typeof body.text !== 'string' ||
      !body.text
    ) {
      return { ok: false };
    }
    await this.telegramService.sendMessage(body.chatId, body.text);
    return { ok: true };
  }
}
