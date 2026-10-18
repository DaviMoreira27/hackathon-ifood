// Lido a cada uso (não no import) para o dotenv já ter carregado o .env e para os testes
// poderem mudar o ambiente.
export const config = {
  get port(): number {
    return Number(process.env.PORT ?? 3001);
  },
  get databaseUrl(): string {
    return (
      process.env.DATABASE_URL ??
      'postgresql://ifood:ifood@localhost:5433/ifood'
    );
  },
  get rabbitUrl(): string {
    return process.env.RABBITMQ_URL ?? 'amqp://ifood:ifood@localhost:5672';
  },
  // Chave que o ai-backend envia para criar/cancelar cobranças (chamadas servidor-a-servidor).
  get apiKey(): string {
    return process.env.MOCK_API_KEY ?? 'dev-mock-key';
  },
  // Segredo que deriva o token de pagamento de cada cobrança.
  get tokenSecret(): string {
    return process.env.MOCK_TOKEN_SECRET ?? 'dev-token-secret';
  },
};
