import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthModule } from './auth/auth.module.js';
import { TelegramModule } from './telegram/telegram.module.js';
import { DbModule } from './db/db.module.js';
import { CartsModule } from './carts/carts.module.js';
import { MessagesModule } from './messages/messages.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    DbModule,
    UsersModule,
    MessagesModule,
    OrdersModule,
    CartsModule,
    AuthModule,
    TelegramModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
