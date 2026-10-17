import { Module } from '@nestjs/common';
import { CartsService } from './carts.service.js';

@Module({
  providers: [CartsService],
  exports: [CartsService],
})
export class CartsModule {}
