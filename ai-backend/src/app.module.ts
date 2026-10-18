import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { TelegramModule } from './telegram/telegram.module.js';
import { DbModule } from './db/db.module.js';
import { GroupOrderModule } from './group-order/group-order.module.js';
import { MessagesModule } from './messages/messages.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    DbModule,
    UsersModule,
    MessagesModule,
    PaymentsModule,
    GroupOrderModule,
    AuthModule,
    TelegramModule,
  ],
})
export class AppModule {}
