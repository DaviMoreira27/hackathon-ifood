# hackathon-ifood

1. Integração com o telegram
2. Integração com o MCP + Adicionar LLM (Claude do Davi) + Fluxo de autorização
3. Criar mock do Ifood (backend) para publicar evento de pagamento confirmado e mockar informações
4. Frontend mock do ifood, para simular passo a passo dentro do app.

## Rodando tudo no mesmo computador

```bash
./dev.sh up        # sobe tudo (pode rodar de novo à vontade; só inicia o que falta)
./dev.sh status    # o que está no ar
./dev.sh logs      # logs dos backends (ou: ./dev.sh logs ai-backend)
./dev.sh down      # para tudo (os dados do banco ficam)
```

O `up` faz, nesta ordem: Postgres e RabbitMQ em containers (docker ou podman, o que existir) → cria o banco se não existir e roda as migrações que faltam (`ai-backend/db/migrate.sh`) → mock do iFood (porta 3001) → `ai-backend` (porta 3000).

- Antes do primeiro `up`, preencha `ai-backend/.env` (se não existir, o script cria a partir do exemplo e avisa o que falta). O `.env` do mock é criado sozinho.
- O front do pagador não é iniciado pelo script: o link enviado no Telegram vem de `PAYMENT_LINK_TEMPLATE` (padrão `http://localhost:5173/pay/{token}`). Ele consome `GET /payments/by-token/:token` e `POST /payments/by-token/:token/pay` no mock.
- Outros comandos: `./dev.sh migrate` (só migrações), `./dev.sh restart` (reinicia os backends) e `./dev.sh reset --yes` (**apaga** banco e filas e recomeça do zero).
- Testes de integração (Postgres/RabbitMQ reais) ficam pulados sem `TEST_DATABASE_URL`, `TEST_RABBITMQ_URL` e `TEST_MOCK_URL` (ver os cabeçalhos dos `*.spec.ts`).
