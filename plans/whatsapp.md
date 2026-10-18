# WhatsApp (Cloud API da Meta) — setup

O ai-backend atende pelo WhatsApp usando a Cloud API oficial da Meta, em paralelo ao Telegram. Cada
canal só sobe se estiver configurado no `ai-backend/.env`; é preciso ao menos um.

## Como funciona

- A Meta entrega cada mensagem por webhook em `POST /whatsapp/webhook`. O back confere a assinatura
  `X-Hub-Signature-256` (HMAC SHA256 do corpo cru com o `WHATSAPP_APP_SECRET`), responde 200 na hora
  e processa em segundo plano. Reentregas são descartadas pelo id da mensagem (`wamid`, guardado em
  `processed_events` com `type = 'whatsapp.message'`).
- `GET /whatsapp/webhook` é a verificação feita pela Meta ao cadastrar o webhook: confere
  `hub.verify_token` contra o `WHATSAPP_VERIFY_TOKEN` e devolve `hub.challenge`.
- O contato é identificado pelo `wa_id` (telefone). A tabela `chats` traduz `(channel, external_id)`
  para o `chatId` interno usado pelo resto do código; os avisos de login e de pagamento saem pelo
  canal de cada chat.
- Respostas: texto convertido para a formatação do WhatsApp, fotos uma por mensagem (não há álbum) e
  botões "Confirmar"/"Cancelar" quando o agente espera confirmação.

## 1. App na Meta for Developers

1. Em <https://developers.facebook.com/apps>, crie um app do tipo **Business** (Empresa) e adicione o
   produto **WhatsApp**. A Meta cria uma conta do WhatsApp Business de teste com um número de teste.
2. Em **WhatsApp → Configuração da API** (API Setup):
   - copie o **Phone number ID** do número de envio → `WHATSAPP_PHONE_NUMBER_ID` (é o id, não o
     telefone);
   - em **Para** (To), cadastre os números que vão conversar com o bot (até 5 no número de teste).
     Cada um recebe um código de confirmação no WhatsApp.
3. Em **Configurações do app → Básico**, copie o **App secret** → `WHATSAPP_APP_SECRET`.

## 2. Token de acesso permanente

O token temporário mostrado em Configuração da API expira em 24h. Para não expirar:

1. Em <https://business.facebook.com/settings>, **Usuários → Usuários do sistema**, crie um System
   User (papel Admin).
2. **Atribuir ativos**: dê ao System User acesso total ao app e à conta do WhatsApp Business.
3. **Gerar novo token** para o app, com as permissões `whatsapp_business_messaging` e
   `whatsapp_business_management`, validade "nunca expira" → `WHATSAPP_ACCESS_TOKEN`.

Para um teste rápido o token temporário serve; só lembre de trocá-lo no dia seguinte.

## 3. `.env`

```dotenv
WHATSAPP_ACCESS_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_VERIFY_TOKEN=um-texto-qualquer-que-voce-inventa
WHATSAPP_APP_SECRET=...
# WHATSAPP_GRAPH_VERSION=v23.0   (opcional)
```

Definida uma das quatro primeiras, todas são obrigatórias (o boot falha dizendo o que falta). Para
subir só com o WhatsApp, deixe `TELEGRAM_BOT_TOKEN` vazio.

## 4. Banco

O schema mudou (tabela `chats`; `users.telegram_chat_id` virou `users.chat_id`) e não há migrações:
um banco antigo precisa ser recriado. **Isso apaga os dados locais:**

```bash
./dev.sh reset --yes
./dev.sh up
```

## 5. Túnel HTTPS e webhook

A Meta só chama webhooks em HTTPS público. Com o back no ar:

```bash
./dev.sh tunnel
```

O comando usa o `cloudflared` (ou o `ngrok`, se só ele existir) e imprime a URL a cadastrar. A URL do
túnel rápido do cloudflared muda a cada execução: recadastre quando reiniciar o túnel.

Em **WhatsApp → Configuração** (Configuration) → **Webhook → Editar**:

- **URL de callback:** `https://<url-do-túnel>/whatsapp/webhook`
- **Token de verificação:** o mesmo `WHATSAPP_VERIFY_TOKEN` do `.env`

Ao salvar, a Meta faz o `GET` de verificação (o back precisa estar no ar). Depois, em **Campos do
webhook**, assine o campo **messages**.

## 6. Teste ponta a ponta

1. Do celular cadastrado, mande "oi" para o número de teste → chega o link de login do iFood.
2. Faça o login → chega "Login no iFood feito ✅".
3. Monte um pedido → os botões Confirmar/Cancelar aparecem e funcionam.
4. Pague pelo link do front → chega o aviso de pagamento.
5. Em paralelo, converse pelo Telegram e confira que os avisos não vazam entre os canais.

Depois da mudança do system prompt (texto neutro de canal), rode o eval: `cd ai-backend && npm run
eval`.

## Limitações conhecidas

- **Janela de 24h:** mensagem livre só é aceita até 24h depois da última mensagem do usuário. O aviso
  de pagamento costuma chegar em minutos, então cabe; fora da janela a Cloud API recusa (erro 131047)
  e o back só loga "aviso não entregue ... fora da janela de 24h". Template aprovado fica como
  evolução.
- Só texto e botões são entendidos; áudio, imagem, localização etc. são logados e ignorados.
- Número de teste: no máximo 5 destinatários cadastrados. Para atender qualquer número é preciso um
  número próprio verificado na conta Business.
