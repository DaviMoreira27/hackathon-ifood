import { Module } from '@nestjs/common';
import { TokenCipher } from './token-cipher.js';
import { UsersService } from './users.service.js';

@Module({
  providers: [TokenCipher, UsersService],
  exports: [UsersService, TokenCipher],
})
export class UsersModule {}
