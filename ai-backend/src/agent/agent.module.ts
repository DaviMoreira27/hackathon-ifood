import { Module } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { AuthModule } from '../auth/auth.module.js';
import { McpModule } from '../mcp/mcp.module.js';
import { MessagesModule } from '../messages/messages.module.js';
import { UsersModule } from '../users/users.module.js';
import { AgentService, ANTHROPIC_CLIENT } from './agent.service.js';

@Module({
  imports: [AuthModule, McpModule, UsersModule, MessagesModule],
  providers: [
    AgentService,
    {
      provide: ANTHROPIC_CLIENT,
      useFactory: () =>
        new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
    },
  ],
  exports: [AgentService],
})
export class AgentModule {}
