import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import { agentTurns } from '../db/schema.js';

export type NewTurnTrace = typeof agentTurns.$inferInsert;

@Injectable()
export class TurnTracesService {
  private readonly logger = new Logger(TurnTracesService.name);

  constructor(private readonly database: DbService) {}

  // Melhor esforço: falha ao gravar o trace nunca derruba a resposta ao usuário.
  async record(trace: NewTurnTrace): Promise<void> {
    try {
      await this.database.db.insert(agentTurns).values(trace);
    } catch (err) {
      this.logger.warn(
        `[trace] falha ao gravar o turno do chat ${trace.chatId}: ${String(err)}`,
      );
    }
  }
}
