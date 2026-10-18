# Plano: suportar o bot dentro de um grupo do Telegram

Status: **proposta, nada implementado**.

## Objetivo

Hoje o "pedido em grupo" depende do dono: ele digita o pedido de todo mundo, e os outros só recebem
o link de pagamento. Com o bot num grupo real do Telegram, cada pessoa escreve "quero o X" e o bot
liga o `from.id` dela a um participante do pedido. É a demo mais forte possível com o que já existe
(participantes, um pagador por item e uma pessoa pagando em um carrinho só).

## Por que não funciona hoje

O sistema assume que **chat = pessoa**, o que só vale em conversa privada. Num grupo o `chat.id` é do
grupo (negativo) e quem fala é outra coisa (`msg.from.id`). Suportar grupo é separar essas duas
identidades.

| Onde | Suposição atual | Problema no grupo |
|---|---|---|
| `AuthService`, tokens, sessão MCP | cada `chatId` é um usuário com login iFood próprio | o grupo viraria "um usuário"; a primeira pessoa que logasse seria dona de tudo |
| `users.telegram_chat_id` | guarda o id do chat | precisa guardar o id da **pessoa** (`from.id`) |
| `GroupOrderService` | acha o pedido ativo pelo dono (`ownerUserId`) | precisa achar pelo **chat do grupo** |
| `/confirmar` | quem digitar no chat confirma | qualquer membro confirmaria a compra do dono |
| link de login OAuth | enviado no próprio chat | num grupo, qualquer um clicaria; o login precisa ser no **privado** |
| aviso de pagamento | vai para o `ownerChatId` | em grupo deve ir para o grupo, com @menção |
| `MAX_QUEUED_PER_CHAT = 3` | uma pessoa por chat | num grupo ativo viraria "aguarde" o tempo todo |
| histórico | texto cru, sem autor | o modelo não saberia quem disse "quero pizza" |

## O que fazer, por camada

### 1. Telegram (`ai-backend/src/telegram/telegram.service.ts`)

- Detectar `msg.chat.type` (`private` ou `group`/`supergroup`) e buscar o username do bot com `getMe`.
- Em grupo, responder só quando for mencionado (`@bot`), em resposta ao bot, ou por comando. Remover a
  menção do texto antes de mandar ao agent.
- Passar ao agent **quem falou** (`from.id`, nome) separado de **onde** (`chat.id`).
- Responder como reply à mensagem e marcar pessoas com @.

### 2. Identidade (banco)

- Reinterpretar `users.telegram_chat_id` como id do usuário do Telegram. Em conversa privada os dois
  são iguais, então o que já existe continua funcionando.
- Acrescentar `orders.chat_id` (o grupo onde o pedido vive) e `participants.user_id` (liga o
  participante à pessoa de verdade). Nova migração em `ai-backend/db/migrations/` e atualização do
  `init.sql` e do `schema.ts`.
- O primeiro "quero X" de alguém cria o participante automaticamente. `group_add_participant`
  continua existindo para quem não está no chat.

### 3. Dono e permissões

- O **dono** é quem abriu o pedido. É a conta iFood dele que cria os carrinhos e roda o
  `submitOrder`, então o agent do grupo roda com os **tokens do dono**.
- O contexto das ferramentas (`ToolContext`) passa a ter `speaker` e `owner`.
- Qualquer um pode escolher seus itens e dizer quem paga. **Só o dono** confirma
  (`group_confirm_order`), reabre, cancela, digita `/confirmar` e finaliza.

### 4. Login

- Se o dono não estiver logado, o bot no grupo responde "o dono precisa entrar pelo privado" com um
  link `t.me/<bot>?start=login`. O link OAuth em si só é enviado no chat privado.

### 5. Agent e prompt

- Gravar cada mensagem com o autor (`[Ana]: quero calabresa`) e ensinar no prompt que há vários
  falantes e que confirmações vêm só do dono.
- Subir o limite de fila por chat e limitar por pessoa, para não estourar o custo de LLM.

### 6. Notificações

- Aviso de pagamento e links de cobrança vão para o grupo, com @menção. O bot só consegue mandar
  mensagem privada a quem já deu `/start` nele, então o grupo é o canal confiável.

## Decisões em aberto

- **Quem é o dono?** Quem abre o pedido (recomendado), ou um admin fixo do grupo?
- **Quando o bot responde:** só com menção (recomendado), ou lê tudo? Ler tudo exige desligar o modo de
  privacidade do bot e gasta mais tokens.
- **O pedido em andamento é do grupo ou de cada pessoa?** Recomendado: um por grupo.
- **Chat privado continua funcionando?** Sim: é o mesmo código com um participante só.

## Configuração do bot (BotFather)

Adicionar o bot ao grupo. Com a privacidade ligada (padrão), ele só vê comandos, menções e respostas a
ele, o que combina com "responder só quando mencionado". Para ele ler todas as mensagens, use
`/setprivacy` → Disable.

## Ordem de implementação e esforço

Cada passo já deixa algo demonstrável:

1. Camada do Telegram e autor nas mensagens.
2. Identidade e pedido por chat (migração + `GroupOrderService`).
3. Permissão só-dono e login no privado.
4. Notificações no grupo e prompt.

Estimativa: cerca de uma tarde de trabalho, mais uma rodada de testes (unitários e de integração com a
infra real, como nas suítes atuais).

## Riscos e cuidados

- **Prompt injection vindo de qualquer membro do grupo.** Hoje só o dono fala; num grupo qualquer
  pessoa consegue escrever texto que o modelo lê. Manter o gate de `/confirmar` restrito ao dono é
  essencial.
- **Custo.** Mais mensagens chegam ao LLM; manter a regra "só responde se mencionado" e o limite por
  pessoa.
- **Migração de grupo para supergrupo** muda o `chat.id` no Telegram; tratar o evento de migração ou
  documentar a limitação.
- **Coordenação de arquivos:** `agent.service.ts` e `telegram.service.ts` são os arquivos centrais
  desta mudança e também são editados por outra sessão do Claude (`ai-backend-ba`). Combinar antes de
  começar para não sobrescrever o trabalho um do outro.
