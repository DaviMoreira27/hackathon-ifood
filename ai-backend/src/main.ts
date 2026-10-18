import 'dotenv/config'; // carrega .env antes de qualquer módulo
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadAgentConfig } from './agent/agent.config.js';
import { appConfig } from './config/app-config.js';

async function bootstrap() {
  // Valida o .env antes de subir qualquer módulo: erro de configuração aparece inteiro, de uma vez.
  const config = appConfig();
  const agent = loadAgentConfig();
  const app = await NestFactory.create(AppModule);
  await app.listen(config.port);
  const logger = new Logger('Bootstrap');
  logger.log(`HTTP ouvindo na porta ${config.port}`);
  logger.log(`IFOOD_REDIRECT_URI=${config.ifood.redirectUri}`);
  logger.log(`MCP_SERVER_URL=${config.mcp.serverUrl ?? '(não definida)'}`);
  if (!agent.apiKey) logger.warn('ANTHROPIC_API_KEY não definida');
}
await bootstrap();
