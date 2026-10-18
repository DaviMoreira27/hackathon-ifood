import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { McpModule } from '../mcp/mcp.module.js';
import { OrderSnapshotService } from './order-snapshot.service.js';
import { PaymentEventsConsumer } from './payment-events.consumer.js';
import { PaymentProviderClient } from './payment-provider.client.js';
import { PaymentsService } from './payments.service.js';

@Module({
  imports: [AuthModule, McpModule],
  providers: [
    PaymentProviderClient,
    PaymentsService,
    PaymentEventsConsumer,
    OrderSnapshotService,
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
