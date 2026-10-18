import { Module } from '@nestjs/common';
import { MockDbService } from '../db/mock-db.service.js';
import { OutboxPublisher } from '../events/outbox-publisher.service.js';
import { ApiKeyGuard } from './api-key.guard.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';

@Module({
  controllers: [PaymentsController],
  providers: [MockDbService, OutboxPublisher, PaymentsService, ApiKeyGuard],
})
export class PaymentsModule {}
