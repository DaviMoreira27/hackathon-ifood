import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import TelegramBot from 'node-telegram-bot-api';

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private bot: TelegramBot;

  onModuleInit(): void {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN não definido no .env');

    this.bot = new TelegramBot(token, { polling: true });
    this.bot.on('message', (msg) => this.handleMessage(msg));
    this.bot.on('polling_error', (err) => this.logger.error('Polling error:', err));

    this.logger.log('Telegram bot iniciado com long polling');
  }

  onModuleDestroy(): void {
    void this.bot?.stopPolling();
  }

  private handleMessage(msg: TelegramBot.Message): void {
    console.log(`chatId: ${msg.chat.id} | from: ${msg.from?.username} | text: ${msg.text}`);
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    const MAX = 4096;
    for (let i = 0; i < text.length; i += MAX) {
      await this.bot.sendMessage(chatId, text.slice(i, i + MAX));
    }
  }
}
