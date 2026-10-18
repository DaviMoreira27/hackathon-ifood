import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

// Protege as rotas servidor-a-servidor (criar/cancelar cobrança). As rotas por token
// (usadas pelo front do pagador) são públicas: o token é a credencial.
@Injectable()
export class ApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
    }>();
    const header = request.headers['x-api-key'];
    const provided = Buffer.from(typeof header === 'string' ? header : '');
    const expected = Buffer.from(config.apiKey);

    if (
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    ) {
      throw new UnauthorizedException('x-api-key inválida');
    }
    return true;
  }
}
