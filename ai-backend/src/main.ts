import 'dotenv/config'; // carrega .env antes de qualquer módulo
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  const logger = new Logger('Bootstrap');
  logger.log(`HTTP ouvindo na porta ${port}`);
  logger.log(
    `IFOOD_REDIRECT_URI=${process.env.IFOOD_REDIRECT_URI ?? '(padrão)'}`,
  );
  logger.log(
    `MCP_SERVER_URL=${process.env.MCP_SERVER_URL ?? '(não definida)'}`,
  );
  if (!process.env.ANTHROPIC_API_KEY)
    logger.warn('ANTHROPIC_API_KEY não definida');
}
await bootstrap();
