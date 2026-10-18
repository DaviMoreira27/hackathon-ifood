import { DynamicModule, Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AuthModule } from './auth/auth.module.js';
import { TelegramModule } from './telegram/telegram.module.js';
import { WhatsappModule } from './whatsapp/whatsapp.module.js';
import { DbModule } from './db/db.module.js';
import { GroupOrderModule } from './group-order/group-order.module.js';
import { MessagesModule } from './messages/messages.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { UsersModule } from './users/users.module.js';
import { appConfig, type AppConfig } from './config/app-config.js';

// Cada canal de chat só entra quando configurado no .env; sem nenhum, o back não tem por onde
// conversar e não sobe.
@Module({})
export class AppModule {
  static forRoot(config: Readonly<AppConfig> = appConfig()): DynamicModule {
    const channels = [
      ...(config.telegramBotToken ? [TelegramModule] : []),
      ...(config.whatsapp ? [WhatsappModule] : []),
    ];
    if (channels.length === 0) {
      throw new Error(
        'Nenhum canal de chat configurado: defina TELEGRAM_BOT_TOKEN e/ou as variáveis WHATSAPP_* no .env',
      );
    }
    return {
      module: AppModule,
      imports: [
        EventEmitterModule.forRoot(),
        DbModule,
        UsersModule,
        MessagesModule,
        PaymentsModule,
        GroupOrderModule,
        AuthModule,
        ...channels,
      ],
    };
  }
}
