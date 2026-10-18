import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module.js';
import { TelegramController } from './telegram.controller.js';
import { TelegramService } from './telegram.service.js';

@Module({
  imports: [AgentModule],
  controllers: [TelegramController],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
