import { Module } from '@nestjs/common';
import { MockDbService } from '../db/mock-db.service.js';
import { OutboxPublisher } from '../events/outbox-publisher.service.js';
import { OrdersController } from '../orders/orders.controller.js';
import { OrdersService } from '../orders/orders.service.js';
import { ApiKeyGuard } from './api-key.guard.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';

// Pedidos ficam aqui junto: dividem o mesmo pool do Postgres e o status vem das cobranças.
@Module({
  controllers: [PaymentsController, OrdersController],
  providers: [
    MockDbService,
    OutboxPublisher,
    PaymentsService,
    OrdersService,
    ApiKeyGuard,
  ],
})
export class PaymentsModule {}
