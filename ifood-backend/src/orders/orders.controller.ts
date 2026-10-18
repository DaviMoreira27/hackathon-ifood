import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../payments/api-key.guard.js';
import { OrdersService } from './orders.service.js';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  // Servidor-a-servidor (ai-backend): o pedido com os dados do carrinho vindos do MCP.
  @Put(':reference')
  @UseGuards(ApiKeyGuard)
  upsert(@Param('reference') reference: string, @Body() body: unknown) {
    return this.orders.upsert(reference, body);
  }

  // Usada pelo front do pagador (o token do link é a credencial).
  @Get('by-token/:token')
  getByToken(@Param('token') token: string) {
    return this.orders.getByToken(token);
  }
}
