import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { TelegramModule } from './telegram/telegram.module.js';

@Module({
  imports: [TelegramModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
