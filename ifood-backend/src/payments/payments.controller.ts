import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiKeyGuard } from './api-key.guard.js';
import { PaymentsService } from './payments.service.js';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  // Servidor-a-servidor (ai-backend).
  @Post()
  @UseGuards(ApiKeyGuard)
  async create(
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!body || typeof body !== 'object') {
      throw new BadRequestException('Corpo inválido');
    }
    const { charge, token, created } = await this.payments.createCharge({
      reference: body.reference as string,
      amountCents: body.amountCents as number,
      description: body.description as string | undefined,
      expiresInMinutes: body.expiresInMinutes as number | undefined,
    });
    res.status(created ? 201 : 200);
    return { ...charge, token };
  }

  @Post('cancel')
  @UseGuards(ApiKeyGuard)
  cancel(@Body() body: { reference?: string }) {
    return this.payments.cancel(body?.reference as string);
  }

  // Usadas pelo front do pagador (o token do link é a credencial).
  @Get('by-token/:token')
  getByToken(@Param('token') token: string) {
    return this.payments.getByToken(token);
  }

  @Post('by-token/:token/pay')
  pay(@Param('token') token: string) {
    return this.payments.payByToken(token);
  }
}
