import { Module } from '@nestjs/common';
import { PaymentEventsConsumer } from './payment-events.consumer.js';
import { PaymentProviderClient } from './payment-provider.client.js';
import { PaymentsService } from './payments.service.js';

@Module({
  providers: [PaymentProviderClient, PaymentsService, PaymentEventsConsumer],
  exports: [PaymentsService],
})
export class PaymentsModule {}
