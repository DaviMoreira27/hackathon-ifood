import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module.js';
import { ChatsModule } from '../chats/chats.module.js';
import { TelegramController } from './telegram.controller.js';
import { TelegramService } from './telegram.service.js';

@Module({
  imports: [AgentModule, ChatsModule],
  controllers: [TelegramController],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
