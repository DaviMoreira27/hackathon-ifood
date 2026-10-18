import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { PendingLoginsService } from './pending-logins.service.js';

@Module({
  imports: [UsersModule],
  controllers: [AuthController],
  providers: [AuthService, PendingLoginsService],
  exports: [AuthService],
})
export class AuthModule {}
