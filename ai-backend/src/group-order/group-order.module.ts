import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module.js';
import { GroupOrderService } from './group-order.service.js';
import { GroupOrderTools } from './group-order.tools.js';

@Module({
  imports: [PaymentsModule],
  providers: [GroupOrderService, GroupOrderTools],
  exports: [GroupOrderService, GroupOrderTools],
})
export class GroupOrderModule {}
