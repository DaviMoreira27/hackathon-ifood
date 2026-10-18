import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthModule } from './auth/auth.module.js';
import { TelegramModule } from './telegram/telegram.module.js';
import { DbModule } from './db/db.module.js';
import { CartsModule } from './carts/carts.module.js';
import { GroupOrderModule } from './group-order/group-order.module.js';
import { MessagesModule } from './messages/messages.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    DbModule,
    UsersModule,
    MessagesModule,
    OrdersModule,
    CartsModule,
    PaymentsModule,
    GroupOrderModule,
    AuthModule,
    TelegramModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
