# Performance e organização do ai-backend — plano

Anotações de 2026-10-18. Dois objetivos: **responder mais rápido** (menos idas e voltas em série
entre banco, MCP e LLM) e **deixar o código mais fácil de mexer** sem perder as garantias de
segurança que já existem (gates de confirmação, validadores, envelope de dados não confiáveis).

Princípio: refatoração estrutural primeiro e sem mudar comportamento (os specs atuais,
`agent.service.spec.ts` e `agent.security.spec.ts`, são a rede de proteção). As melhorias de
performance entram depois, em cima da estrutura nova, porque várias delas ficam triviais com ela.

Para medir antes e depois: `agent_turns` já guarda `duration_ms`, `rounds` e tokens de cache. Tirar
uma linha de base com o eval (`npm run eval`) antes da fase 2.

## Diagnóstico de organização

O que pesa hoje:

- **`agent.service.ts` (~1000 linhas) faz tudo**: fila por chat, comandos (`/logout`, `/confirmar`),
  montagem do contexto, loop do LLM, despacho de ferramentas, gates, sync do carrinho, validadores,
  fotos, resumo, confirmação e trace. `runTools` sozinho tem ~300 linhas.
- **Despacho de ferramentas por cadeia de `if`**: price → diet → group → MCP, cada ramo com o próprio
  try/catch, o próprio formato de erro e a própria regra de confirmação. Adicionar uma família de
  ferramentas exige mexer no meio do loop.
- **Gates espalhados e repetidos**: ids nunca vistos, trava do checkout, filtro alimentar e
  confirmação de ferramenta sensível são quatro blocos parecidos dentro de `runTools`. O bloco
  "se já há pending → ALREADY_PENDING; senão grava pending e devolve BLOCKED" aparece três vezes.
  O tipo `Preparation` (`run | confirm | reject`) já existe e é exatamente o contrato de um gate.
- **`TurnState` é um saco mutável** passado para todo lado (`appendices`, `cartChanged`,
  `dietChanged`, `succeeded`, `trace`, `validatorHits`...). Qualquer função pode mexer em qualquer
  campo, e não há lugar natural para cache dentro do turno (por isso `getOrderView` roda 2 a 4 vezes).
- **`group-order.service.ts` (~1050 linhas)** mistura leitura (views, prévia), comandos (participante,
  sync, pagador, confirmar, reabrir, cancelar) e cobrança (`ensureCharges`, `reissue`, `release`).
- **29 leituras de `process.env` espalhadas**, várias a cada chamada (`triggersCartSync`,
  `requiresConfirmation`, `isCheckoutTool`, `isTrustedImageUrl`), sem validação no boot. Foi assim que
  passou despercebido que `MCP_CHECKOUT_TOOL_PATTERN=checkout` no `.env.example` não casa
  `submitOrder` (a trava de pagamento do checkout fica desligada com esse valor).
- **Helpers duplicados**: `isObj`/`isPlainObject`, `text()`, `unwrap`/`unwrapToolText` existem em
  `images.ts`, `cart-sync.ts`, `price-tools.ts` e `agent.service.ts`.
- **Observers feitos à mão**: `auth.onLogin` e `payments.onPaymentApplied` mantêm arrays de
  listeners próprios, cada um com o seu tratamento de erro.
- **Código morto**: `CartsModule`/`CartsService` e `OrdersModule`/`OrdersService` não são usados por
  ninguém (o domínio está em `group-order`); `AppController`/`AppService` é o "Hello World" do
  scaffold.

## Arquitetura proposta para o agente

```
src/agent/
  agent.service.ts          fachada: fila por chat + comandos; chama TurnRunner
  chat-queue.ts             fila serializada por chat (keyed mutex) + limite de profundidade
  turn/
    turn-context.ts         estado do turno com acesso controlado + memo (orderView, corpus)
    turn-runner.ts          loop do LLM: monta request, trata stop_reason, chama executor
    reply-finalizer.ts      validadores, fotos, resumo do pedido, confirmação, apêndices
  tools/
    tool-handler.ts         interface ToolHandler
    tool-registry.ts        junta as fontes, ordena por nome, resolve handler por nome
    tool-executor.ts        executa um lote: leituras em paralelo, escritas em série, ordem preservada
    sources/
      mcp.source.ts         ferramentas do iFood (via McpService)
      group.source.ts       group_* (adapta GroupOrderTools)
      diet.source.ts        diet_* (adapta DietaryTools)
      price.source.ts       compare_prices
    gates/
      gate.ts               interface ToolGate
      unseen-ids.gate.ts
      checkout.gate.ts
      diet.gate.ts
      confirm.gate.ts
    hooks/
      cart-sync.hook.ts     depois de escrita em carrinho: getCart + syncIfoodCart (agrupado por cartId)
  history/
    conversation.store.ts   recent + rowsToMessages + messagesToRows + gravação do turno
```

### Padrões e por que cada um

**Strategy + Registry para ferramentas.** Cada família implementa a mesma interface; o executor não
sabe de onde a ferramenta vem.

```ts
export interface ToolHandler {
  definition: Tool;
  readOnly: boolean;
  // Escrita que dispara sync do carrinho, ferramenta local etc. ficam em metadados, não em if.
  tags?: ReadonlySet<'cart-write' | 'local' | 'diet'>;
  execute(input: Record<string, unknown>, ctx: TurnContext): Promise<ToolOutcome>;
}

export interface ToolOutcome {
  text: string;
  isError: boolean;
  appendix?: string;
}
```

O `ToolRegistry` monta a lista uma vez por turno (MCP + group + diet + price), aplica `strictTool`
nas locais e **ordena por nome** (prefixo de cache estável). `has`, `isReadOnly` e a mensagem
"Ferramenta inexistente" saem daqui.

**Chain of Responsibility para os gates.** Cada gate devolve o `Preparation` que já existe; o
executor percorre a cadeia e para no primeiro `reject` ou `confirm`. A lógica de pending
(`ALREADY_PENDING_RESULT` / `BLOCKED_RESULT`) fica num lugar só, no executor.

```ts
export interface ToolGate {
  // Gates podem ignorar chamadas pré-aprovadas (/confirmar) ou ferramentas que não lhes dizem respeito.
  check(call: ToolCall, ctx: TurnContext): Promise<Preparation>;
}
```

Ordem da cadeia (a mesma de hoje): `UnseenIdsGate` → `CheckoutGate` → `DietGate` → `ConfirmGate`.
O `prepare` de `group_confirm_order` vira mais um gate. Falha inesperada dentro de um gate vira
`reject` com a mensagem de "lado seguro" (comportamento atual), tratada uma vez no executor.

**Hooks pós-execução (Observer local).** O sync do carrinho deixa de ser um `if (triggersCartSync)`
no meio do executor e vira um hook que recebe todos os resultados do lote. Isso permite agrupar por
`cartId` e chamar `getCart` uma vez por carrinho (item 2.5).

**TurnContext em vez de TurnState.** Objeto com métodos em vez de campos soltos:

```ts
class TurnContext {
  readonly chatId: number;
  readonly userId: number;
  orderView(): Promise<OrderView>;      // memoizado; invalidado por markOrderChanged()
  markOrderChanged(): void;             // chamado por group_* e pelo hook de sync
  corpus(): FactCorpus;                 // ids e centavos vistos; incremental, não recalcula tudo
  addAppendix(text: string): void;      // já deduplica
  requestConfirmation(p: PendingAction): 'pending' | 'already-pending';
  recordTool(name: string, ok: boolean, ms: number): void;  // trace + succeeded
}
```

Resolve de graça: `getOrderView` repetido no turno, `factCorpus` recalculado a cada escrita e a
duplicação do bloco de pending.

**Fachada fina.** `AgentService` fica só com: fila (`ChatQueue`), comandos (`/logout`,
`/confirmar`), login e delegação para `TurnRunner`. `ReplyFinalizer` concentra tudo que acontece com
o texto final (validadores, retry de correção, `takeImages`, resumo, `withConfirmation`).

### Fora do agente

**Config tipada e validada no boot.** Um `AppConfig` (provider Nest, ou `@nestjs/config` com schema)
lido uma vez: regex compiladas (`MCP_CHECKOUT_TOOL_PATTERN`, `DIET_GUARDED_TOOL_PATTERN`), listas
(`MCP_CART_SYNC_TOOLS`, `MCP_CONFIRM_TOOLS`, hosts confiáveis), números (`PAYMENT_TTL_MINUTES`) e
`AGENT_EFFORT` validado contra os valores aceitos. Boot falha com mensagem clara se algo estiver
inválido. Funções puras como `requiresConfirmation` passam a receber a config por parâmetro (fica
mais fácil de testar também).

**`group-order` dividido por responsabilidade (leitura × escrita, sem CQRS de verdade).**

- `OrderQueryService`: `getOrderView`, `hasPaidOrder`, `openIfoodCartIds`. Aqui entra a correção do
  N+1 (item 2.3).
- `OrderCommandService`: participante, sync, pagador, confirmar, reabrir, cancelar, finalizar.
- `ChargesService`: `ensureCharges`, `pendingLinks`, `reissue`, a parte de `release` que fala com o
  provedor de pagamento.

`GroupOrderTools` continua sendo o adaptador para o LLM (vira `group.source.ts`). A divisão em
arquivos menores está no 4.1.

**Eventos de domínio.** Trocar os arrays de listeners por `@nestjs/event-emitter` (`user.logged-in`,
`payment.applied`). O Telegram assina com `@OnEvent`; Auth e Payments deixam de conhecer quem
escuta. Mudança pequena e isolada.

**Utilitários comuns.** `src/common/json.ts` (`isObj`, `pick`, `text`, `parseJsonSafe`) e
`src/agent/tool-envelope.ts` (`wrapToolResult`, `unwrapToolText`, `shrinkToolResult`, hoje em
`tool-policy.ts` e duplicados em `images.ts`/`cart-sync.ts`).

### O que não fazer (por enquanto)

- **Hexagonal/DDD completo, repositórios e CQRS (command/query bus).** Fora do escopo agora. O
  Drizzle já é a camada de acesso e os serviços de domínio são testáveis com o banco de integração.
  Reavaliar só se a divisão das fases 1 e 4 não for suficiente.
- **Interfaces para o cliente Anthropic e para o MCP só "por arquitetura".** O token
  `ANTHROPIC_CLIENT` já permite injetar o fake nos testes.
- **Multi-agente para organizar o código.** Já discutido em `robustez-agente.md`: não é a ferramenta
  para isso.

## Fases

### Fase 0 — correções rápidas (independentes, sem refatoração)

- [ ] Corrigir `MCP_CHECKOUT_TOOL_PATTERN` no `.env.example` (deixar vazio para usar o padrão
      `submit_?order|checkout`, ou `submitOrder|checkout`) e no `.env` local.
- [ ] "Digitando..." contínuo: reenviar `sendChatAction` a cada 4s enquanto `handleRich` roda
      (`telegram.service.ts:69`); limpar o intervalo no `finally`.
- [ ] Índice `messages (chat_id, id)` no lugar de `(chat_id, created_at)` (`recent()` ordena por id).
      Migration nova + `init.sql`.
- [ ] `addMany`: um único `insert(...).values(rows)` em vez de um insert por linha.
- [ ] Timeout e retries explícitos no cliente Anthropic (`agent.module.ts`), ex.: `timeout: 60_000`,
      `maxRetries: 2`.
- [ ] Remover `CartsModule`, `OrdersModule` e o `AppController`/`AppService` do scaffold.

### Fase 1 — reorganização sem mudar comportamento

Cada passo é um PR/commit que mantém os specs verdes.

- [ ] 1.1 `src/common/json.ts` e `tool-envelope.ts`; trocar as cópias locais.
- [ ] 1.2 `AppConfig` tipado e validado no boot; trocar as leituras de `process.env`.
- [ ] 1.3 Extrair `ChatQueue` de `AgentService` (com spec próprio: serialização, limite, limpeza).
- [ ] 1.4 Introduzir `TurnContext` (sem memo ainda) no lugar de `TurnState`.
- [ ] 1.5 `ToolHandler` + `ToolRegistry` + sources; `runTools` passa a despachar pelo registry.
- [ ] 1.6 `ToolGate` + os quatro gates + gate do `group_confirm_order`; o bloco de pending fica só
      no executor. `agent.security.spec.ts` é o que mais importa aqui.
- [ ] 1.7 `ToolExecutor` (ainda com a regra atual de paralelismo) e hook de cart sync (ainda um por
      chamada).
- [ ] 1.8 `TurnRunner` e `ReplyFinalizer`; `AgentService` vira fachada.
- [ ] 1.9 Dividir `group-order.service.ts` em query / command / charges.
- [ ] 1.10 Eventos com `@nestjs/event-emitter`.

### Fase 2 — performance em cima da estrutura nova

- [ ] 2.1 Preparação do turno em paralelo: depois do token, `Promise.all` de `getSession`,
      `recent`, `orderView`, `checkoutAllowed` e `dietTools.list`. Passar o `User` já carregado
      para `getValidAccessToken` (hoje ele busca o usuário de novo).
- [ ] 2.2 Memo de `orderView` no `TurnContext`, invalidado por `markOrderChanged()`.
- [ ] 2.3 `getOrderView` sem N+1: itens de todos os carrinhos com um `inArray`, carrinhos dos
      pedidos pagos com outro.
- [ ] 2.4 `ToolExecutor`: leituras do lote em paralelo e escritas em série, mesmo em lote misto;
      tool_result sempre na ordem dos tool_use.
- [ ] 2.5 Hook de cart sync agrupado por `cartId`: um `getCart` por carrinho por lote.
- [ ] 2.6 Corpus de fatos incremental no `TurnContext` (adiciona cada tool_result ao entrar) em vez
      de `factCorpus(messages)` + regex sobre a conversa inteira a cada escrita.
- [ ] 2.7 Sessões MCP: TTL de ociosidade (fechar após ~15 min) e lista de ferramentas em cache
      global com TTL (é igual para todos; evita `listTools` por chat e a cada refresh de token).
- [ ] 2.8 Pool do Postgres dimensionado explicitamente (2.1 abre até 5 consultas por turno).
- [ ] 2.9 Status de progresso no Telegram: mensagem editável com a etapa atual a partir dos nomes das
      ferramentas ("buscando ofertas...", "montando carrinho..."). Callback `onProgress` do
      `TurnRunner` para o `TelegramService`. Streaming do texto final não entra: ele passa pelo
      validador de valores antes de sair.

### Fase 3 — tokens e cache (medir com o eval a cada passo)

- [ ] 3.1 Prompt: reforçar que chamadas independentes saem juntas na mesma resposta; rodar o eval
      com `AGENT_EFFORT=low` × `medium` e comparar `rounds`, `duration_ms` e as métricas do eval.
- [ ] 3.2 Ferramentas sempre na mesma lista: manter o checkout visível (a trava real é o
      `CheckoutGate`) para o prefixo de ferramentas não mudar quando o pedido é pago. Decidir com
      o eval se o modelo passa a tentar o checkout cedo demais.
- [ ] 3.3 Histórico estável entre mensagens:
      - janela andando em saltos (cortar em múltiplos de 20 linhas) em vez de uma linha por vez;
      - encurtar tool_result ao gravar, não ao remontar (mesmo conteúdo em todos os turnos);
      - estado do pedido como texto que fica no histórico, em vez de anexado e removido.
      Conferir `cache_read_tokens` da primeira rodada em `agent_turns`.
- [ ] 3.4 Registro de ids e valores vistos persistido por chat (tabela nova), alimentado pelo
      `TurnContext` no fim do turno. Pré-requisito do 3.5: hoje `UnseenIdsGate` e o validador de
      valores dependem dos tool_result antigos estarem no histórico.
- [ ] 3.5 Descartar tool_result de turnos mais antigos que os últimos 2 ou 3 (fica o texto do
      assistant; o estado do pedido carrega carrinhos, itens e ids).

### Fase 4 — quebrar os arquivos grandes de produção

A fase 1 cuida de `agent.service.ts` (vira `turn/`, `tools/`, `history/`) e divide
`group-order.service.ts` em três serviços. Esta fase termina o trabalho nos outros arquivos grandes.
Referência: arquivo de produção com mais de ~300 linhas ou com mais de uma responsabilidade é
candidato a quebra. Dados estáticos (catálogo, definições de ferramentas) podem passar disso desde
que fiquem sozinhos no arquivo.

Tudo sem mudar comportamento: mover código, ajustar imports, specs verdes a cada passo.

- [ ] 4.1 **`group-order.service.ts` (1052) em arquivos**, completando o 1.9:
      ```
      group-order/
        order-query.service.ts      getOrderView, hasPaidOrder, openIfoodCartIds
        order-command.service.ts    participante, sync, pagador, finalizar
        order-lifecycle.service.ts  confirmar, reabrir, cancelar (release/reissue)
        charges.service.ts          ensureCharges, pendingLinks, conversa com o provedor
        order-view.ts               montagem da OrderView e da prévia (funções puras)
        order.lookups.ts            findActiveOrder, requireCollecting, findCart, findParticipant
      ```
      `order-view.ts` puro permite testar a prévia e os `problems` sem banco.
- [ ] 4.2 **`group-order.tools.ts` (461)**: as definições (`GROUP_TOOLS`, ~130 linhas de schema)
      para `group-order.tool-defs.ts`; `str`/`num`/`parseSyncCart` para `group-order.input.ts`; a
      montagem do texto do `group_confirm_order` (links, nota) para uma função própria. Depois da
      fase 1 a classe vira o `group.source.ts` e fica só com o despacho.
- [ ] 4.3 **`dietary.tools.ts` (451)**, mesma divisão: `dietary.tool-defs.ts` (`DIET_TOOLS`),
      `dietary.input.ts` (`parseRestriction`, `parseItems`, `personStr`...), `dietary.policy.ts`
      (`policyFor`, texto que entra no system) e `verdict-cache.ts` (o `Map` de veredictos por
      usuário com limite `MAX_REMEMBERED`, hoje dentro da classe).
- [ ] 4.4 **`dietary.catalog.ts` (613)**: é dado, não lógica. Separar as listas de termos
      (`MEAT`, `FISH`, `DAIRY`, `PORK`, `ALCOHOL`...) em `dietary/catalog/terms/*.ts` por grupo e
      deixar em `catalog/restrictions.ts` só o `RESTRICTIONS` que as combina. Fica fácil revisar e
      adicionar termos sem rolar 600 linhas.
- [ ] 4.5 **`price-tools.ts` (330)**: `price-facts.ts` (leitura dos resultados: `walk`, `feesOf`,
      `priceFacts`) e `compare-prices.ts` (resolução das opções e ranking). A definição da
      ferramenta vai para `price.source.ts` na fase 1.
- [ ] 4.6 **`images.ts` (287)**: `image-trust.ts` (`isTrustedImageUrl`, `resolve`),
      `image-captions.ts` (`priceLabel`, `deliveryLabel`, captions) e `images.ts` com
      `imageCatalog` e `takeImages`. O `brl()` local some em favor do `formatBRL` de `money.ts`.
- [ ] 4.7 **`cart-sync.ts` (224)**: `parseCart` e os leitores tolerantes (`findCart`, `money`,
      `pick`) para `cart-parser.ts`; o resto vira o hook `cart-sync.hook.ts` da fase 1.
- [ ] 4.8 **`payment-events.consumer.ts` (304)**: o laço de conexão e reconexão com o RabbitMQ
      (`run`, `connect`, `cleanup`, `sleep`, `inFlight`) para `rabbit-connection.ts`, reaproveitável
      e testável sozinho; `parseEvent` para `payment-event.parser.ts`; o consumer fica com `handle`
      e `fail` (ack, retry, dead letter).
- [ ] 4.9 **`system-prompt.ts`**: quebrar o texto em seções nomeadas (`ORDER_RULES`, `TOOLS`,
      `ECONOMY`, `PHOTOS`, `SECURITY`, `STYLE`) num array juntado com `\n\n`. O prompt final continua
      byte a byte igual (um spec compara com um snapshot, para não invalidar o cache sem querer), mas
      cada regra fica fácil de achar e de testar no eval.
- [ ] 4.10 **Regras de coesão de módulo**: cada módulo exporta só pelo `*.module.ts` e por um
      `index.ts` com os tipos públicos; `agent/` não importa arquivos internos de `group-order/` e
      `dietary/` (só o que for exportado). Hoje `agent.service.ts` importa `group-order.errors`,
      `money`, `dietary.tools` e `schema` diretamente.
- [ ] 4.11 Ligar `max-lines` no `.oxlintrc.json` como `warn` (ex.: 400 linhas, ignorando
      `*.spec.ts`, `eval/` e o catálogo) para o problema não voltar. Conferir se a versão do oxlint
      em uso suporta a regra.

### Fase 5 — specs e eval

Os arquivos de teste também cresceram junto com o código: `agent.service.spec.ts` (922),
`group-order.service.spec.ts` (738), `agent.security.spec.ts` (453), `eval/fake-ifood.ts` (887),
`eval/scenarios.ts` (747) e `eval/fake-stores.ts` (423). Depende das fases 1 e 4, porque a divisão
dos specs acompanha a divisão do código.

- [ ] 5.1 **Specs do agente por unidade.** Os blocos `describe` já mostram o corte: fila, ferramentas
      do pedido em grupo, gate do `/confirmar`, restrição alimentar, sync do carrinho, validador da
      resposta final, segurança. Cada um vira o spec da unidade correspondente da fase 1
      (`chat-queue.spec.ts`, `tool-executor.spec.ts`, `gates/*.spec.ts`, `cart-sync.hook.spec.ts`,
      `reply-finalizer.spec.ts`). `agent.service.spec.ts` fica só com o fluxo ponta a ponta (alguns
      casos felizes e de erro). `agent.security.spec.ts` continua existindo como suíte de
      regressão de segurança, mas ponta a ponta e sem repetir o que os specs dos gates cobrem.
- [ ] 5.2 **Builders compartilhados.** Os specs montam o mesmo `AgentService` com fakes e as mesmas
      respostas do LLM em vários arquivos. Extrair para `test/support/`: `fakeAnthropic()` com
      fila de respostas, `toolUse(name, input)`, `textReply(text)`, `fakeMcpSession(tools)`,
      `buildAgent(overrides)`.
- [ ] 5.3 **`group-order.service.spec.ts` por serviço** da fase 4.1 (query, command, lifecycle,
      charges), mais um spec puro de `order-view.ts` sem banco.
- [ ] 5.4 **`eval/fake-ifood.ts`**: dados (`MERCHANTS`, `ITEMS`, endereços, vouchers) para
      `eval/fixtures/*.ts` ou JSON; schemas das ferramentas falsas para `eval/fake-ifood/tools.ts`;
      a classe `FakeIfood` dividida por área do MCP (`discovery.ts`, `cart.ts`, `orders.ts`).
- [ ] 5.5 **`eval/scenarios.ts`**: um arquivo por tema em `eval/scenarios/` (economia, pedido em
      grupo, restrição alimentar, segurança, robustez) e um `index.ts` que junta. Os helpers de
      checagem (`groupQuestion`, `askedWhoPays`) vão para junto dos de `harness.ts`, em
      `eval/checks.ts`.
- [ ] 5.6 **`eval/fake-stores.ts`**: `MemoryGroupOrders` (~300 linhas) reimplementa as regras do
      pedido em grupo e pode divergir do serviço real. Avaliar rodar o eval com o
      `GroupOrderService` de verdade sobre o Postgres de teste (o mesmo do `db.integration.spec.ts`);
      se ficar lento demais, manter o fake, mas com um spec que roda os mesmos casos contra os dois
      e compara.
- [ ] 5.7 **`eval/harness.ts`**: separar criação do contexto e execução (`createCtx`,
      `runScenario`), setup (`presetCart`, `seedHistory`) e checks (`check`, `globalChecks`...) em
      três arquivos.

### Depois, se for escalar

- [ ] Fila por chat e confirmações pendentes fora da memória (`pg_advisory_xact_lock(chat_id)` ou
      Redis), para rodar mais de uma instância. Hoje `ChatQueue`, `pendingActions` e as sessões MCP
      prendem o serviço a um processo só.
- [ ] Telegram por webhook em vez de long polling.
