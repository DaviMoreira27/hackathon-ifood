# hackathon-ifood

1. Integração com o telegram
2. Integração com o MCP + Adicionar LLM (Claude do Davi) + Fluxo de autorização
3. Criar mock do Ifood (backend) para publicar evento de pagamento confirmado e mockar informações
4. Frontend mock do ifood, para simular passo a passo dentro do app.

## Rodando tudo no mesmo computador

```bash
./dev.sh up        # sobe tudo (pode rodar de novo à vontade; só inicia o que falta)
./dev.sh status    # o que está no ar
./dev.sh logs      # logs dos serviços (ou: ./dev.sh logs ai-backend | ifood-backend | frontend)
./dev.sh down      # para tudo (os dados do banco ficam)
```

O `up` faz, nesta ordem: Postgres e RabbitMQ em containers (docker ou podman, o que existir) → cria o banco e aplica o schema se ele estiver vazio (`ai-backend/db/setup.sh`; não há migrações, o schema vive em `ai-backend/db/init.sql` e mudanças nele pedem `./dev.sh reset --yes`) → mock do iFood (porta 3001) → `ai-backend` (porta 3000) → front do pagador (porta 5173).

- Antes do primeiro `up`, preencha `ai-backend/.env` (se não existir, o script cria a partir do exemplo e avisa o que falta). O `.env` do mock é criado sozinho.
- O front do pagador também sobe pelo script (porta 5173, `FRONT_PORT` para trocar). Se não houver `frontend/.env.local` nem `frontend/.env`, o script cria `frontend/.env.local` com `NEXT_PUBLIC_API_URL=http://localhost:3001`. O link enviado no chat vem de `PAYMENT_LINK_TEMPLATE` (padrão `http://localhost:5173/pay/{token}`). Ele consome `GET /orders/by-token/:token`, `GET /payments/by-token/:token` e `POST /payments/by-token/:token/pay` no mock.
- Ao emitir as cobranças, o ai-backend envia o pedido ao mock (`PUT /orders/:id`, com `x-api-key`), juntando o banco com o `getCart` do MCP.
- Outros comandos: `./dev.sh restart` (reinicia os backends e o front), `./dev.sh reset --yes` (**apaga** banco e filas e recomeça do zero) e `./dev.sh tunnel` (URL HTTPS pública para o webhook do WhatsApp).
- WhatsApp (Cloud API da Meta): passo a passo em [`plans/whatsapp.md`](plans/whatsapp.md). Telegram e WhatsApp são opcionais, mas ao menos um precisa estar configurado no `ai-backend/.env`.
- Testes de integração (Postgres/RabbitMQ reais) ficam pulados sem `TEST_DATABASE_URL`, `TEST_RABBITMQ_URL` e `TEST_MOCK_URL` (ver os cabeçalhos dos `*.spec.ts`).
