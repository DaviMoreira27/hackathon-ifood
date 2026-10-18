import { Module } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { AuthModule } from '../auth/auth.module.js';
import { DietaryModule } from '../dietary/dietary.module.js';
import { GroupOrderModule } from '../group-order/group-order.module.js';
import { McpModule } from '../mcp/mcp.module.js';
import { MessagesModule } from '../messages/messages.module.js';
import { UsersModule } from '../users/users.module.js';
import { AgentService, ANTHROPIC_CLIENT } from './agent.service.js';
import { TurnTracesService } from './turn-traces.service.js';
import {
  AGENT_CONFIG,
  loadAgentConfig,
  type AgentConfig,
} from './agent.config.js';

@Module({
  imports: [
    AuthModule,
    McpModule,
    UsersModule,
    MessagesModule,
    GroupOrderModule,
    DietaryModule,
  ],
  providers: [
    AgentService,
    TurnTracesService,
    { provide: AGENT_CONFIG, useFactory: () => loadAgentConfig() },
    {
      provide: ANTHROPIC_CLIENT,
      inject: [AGENT_CONFIG],
      useFactory: (config: AgentConfig) =>
        new Anthropic({ apiKey: config.apiKey }),
    },
  ],
  exports: [AgentService],
})
export class AgentModule {}
