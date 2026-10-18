import 'dotenv/config'; // carrega .env antes de qualquer módulo
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { config } from './config.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // O front do pagador roda em outra porta do localhost e chama esta API direto do navegador.
  app.enableCors();
  app.enableShutdownHooks();
  await app.listen(config.port);
  new Logger('Bootstrap').log(`Mock do iFood ouvindo na porta ${config.port}`);
}
await bootstrap();
