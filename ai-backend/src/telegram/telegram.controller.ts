import { Body, Controller, Post } from '@nestjs/common';
import { TelegramService } from './telegram.service.js';

interface SendMessageDto {
  chatId: number;
  text: string;
}

@Controller('telegram')
export class TelegramController {
  constructor(private readonly telegramService: TelegramService) {}

  @Post('send')
  async send(@Body() body: SendMessageDto): Promise<{ ok: boolean }> {
    await this.telegramService.sendMessage(body.chatId, body.text);
    return { ok: true };
  }
}
