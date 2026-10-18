import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import { ChargesService } from './charges.service.js';
import type {
  AssignPayerInput,
  CartSummary,
  OrderView,
  SyncCartInput,
  SyncCartResult,
} from './group-order.types.js';
import { OrderCommandService } from './order-command.service.js';
import { OrderQueryService } from './order-query.service.js';

export * from './group-order.types.js';

// Ponto de entrada do pedido em grupo: leituras em OrderQueryService, escritas em
// OrderCommandService e cobranças em ChargesService.
@Injectable()
export class GroupOrderService {
  private readonly query: OrderQueryService;
  private readonly commands: OrderCommandService;

  constructor(database: DbService, paymentsService: PaymentsService) {
    this.query = new OrderQueryService(database);
    this.commands = new OrderCommandService(
      database,
      this.query,
      new ChargesService(database, paymentsService),
    );
  }

  hasPaidOrder(userId: number): Promise<boolean> {
    return this.query.hasPaidOrder(userId);
  }

  openIfoodCartIds(userId: number): Promise<string[]> {
    return this.query.openIfoodCartIds(userId);
  }

  getOrderView(userId: number): Promise<OrderView> {
    return this.query.getOrderView(userId);
  }

  addParticipant(userId: number, rawName: string) {
    return this.commands.addParticipant(userId, rawName);
  }

  syncCart(userId: number, input: SyncCartInput): Promise<SyncCartResult> {
    return this.commands.syncCart(userId, input);
  }

  assignPayer(userId: number, input: AssignPayerInput): Promise<CartSummary> {
    return this.commands.assignPayer(userId, input);
  }

  confirmOrder(userId: number) {
    return this.commands.confirmOrder(userId);
  }

  reopenOrder(userId: number) {
    return this.commands.reopenOrder(userId);
  }

  cancelOrder(userId: number) {
    return this.commands.cancelOrder(userId);
  }

  markFinalized(userId: number, orderId?: number) {
    return this.commands.markFinalized(userId, orderId);
  }
}
