import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module.js';
import { ChatsModule } from '../chats/chats.module.js';
import { DbModule } from '../db/db.module.js';
import { WhatsappClient } from './whatsapp.client.js';
import { WhatsappController } from './whatsapp.controller.js';
import { WhatsappService } from './whatsapp.service.js';

@Module({
  imports: [AgentModule, ChatsModule, DbModule],
  controllers: [WhatsappController],
  providers: [WhatsappService, WhatsappClient],
  exports: [WhatsappService],
})
export class WhatsappModule {}
