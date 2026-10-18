import {
  Controller,
  Get,
  Header,
  HttpException,
  Logger,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthService } from './auth.service.js';

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );

// A mensagem pode conter texto da query string (?error=...): sempre escapada, senão vira XSS refletido.
const page = (message: string) =>
  `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>iFood</title></head><body style="font-family:sans-serif;text-align:center;padding:48px 16px"><h2>${escapeHtml(message)}</h2></body></html>`;

@Controller()
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private readonly authService: AuthService) {}

  // redirect_uri registrado no iFood (IFOOD_REDIRECT_URI): recebe ?code=...&state=... após o login.
  @Get('redirect')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async redirect(
    @Res({ passthrough: true }) res: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
    @Query('scope') scope?: string,
  ): Promise<string> {
    this.logger.log(
      `[redirect] recebido — code=${code ? 'sim' : 'não'} state=${state ?? '-'} error=${error ?? '-'}`,
    );
    if (scope) this.logger.log(`[redirect] escopos concedidos: ${scope}`);

    if (error) {
      this.logger.warn(`[redirect] iFood retornou erro: ${error}`);
      res.status(400);
      return page(`Login não concluído: ${error}`);
    }
    if (!code || !state) {
      this.logger.warn('[redirect] faltando code ou state');
      res.status(400);
      return page('Parâmetros code e state são obrigatórios.');
    }

    try {
      const chatId = await this.authService.handleCallback(code, state);
      this.logger.log(`[redirect] login concluído para o chat ${chatId}`);
      return page('Login feito ✅ Pode voltar ao Telegram.');
    } catch (err) {
      this.logger.error(`[redirect] falha no login: ${String(err)}`);
      res.status(err instanceof HttpException ? err.getStatus() : 500);
      return page(
        err instanceof HttpException
          ? `${err.message} Mande uma nova mensagem no Telegram para receber outro link.`
          : 'Erro ao concluir o login. Veja os logs do backend.',
      );
    }
  }
}
