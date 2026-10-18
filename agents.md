# Agents — iFood Group Order Assistant

## Visão Geral

Um assistente conversacional que coordena pedidos em grupo via chat (Telegram ou web). O usuário descreve os participantes e o que cada um quer; o agente recomenda itens, monta carrinhos por restaurante, e ao final gera tokens de pagamento individuais (QR Code no-app ou PIX) para que cada participante pague sua parte de forma independente.

---

## Arquitetura de Agentes

```
Usuário (Telegram / Web)
        │
        ▼
┌───────────────────┐
│  Orchestrator     │  ← agente principal, mantém estado da sessão
│  Agent            │
└───────┬───────────┘
        │ delega subtarefas
        ├──────────────────────────────┐
        ▼                              ▼
┌───────────────────┐      ┌───────────────────────┐
│  Recommendation   │      │  Payment Splitter      │
│  Agent            │      │  Agent                 │
└───────────────────┘      └───────────────────────┘
```

### Orchestrator Agent

Responsável por conduzir o fluxo da conversa de ponta a ponta.

**Responsabilidades:**
- Coletar número de participantes e preferências de cada um
- Coordenar chamadas ao Recommendation Agent para sugerir pratos
- Manter estado dos carrinhos (um por restaurante)
- Delegar divisão de conta ao Payment Splitter Agent
- Entregar tokens / QR codes ao usuário final

**Tools disponíveis:**
| Tool | Descrição |
|---|---|
| `getRecommendations(userId, preferences)` | Busca sugestões de pratos/restaurantes para um participante |
| `addItemToCart(cartId, item, quantity)` | Adiciona item a um carrinho específico |
| `removeItemFromCart(cartId, itemId)` | Remove item de um carrinho |
| `listCarts()` | Lista todos os carrinhos ativos da sessão |
| `confirmCarts()` | Fecha os carrinhos e gera os pedidos |
| `getOrderSummary(orderId)` | Retorna resumo de um pedido confirmado |

---

### Recommendation Agent

Especializado em buscar e apresentar opções do catálogo iFood.

**Responsabilidades:**
- Interpretar preferências em linguagem natural (ex: "algo vegano", "pizza", "menos de R$30")
- Chamar `getRecommendations` com os filtros corretos
- Formatar as sugestões de forma legível por participante
- Suportar iterações ("não gostou, sugira outro")

**Tools disponíveis:**
| Tool | Descrição |
|---|---|
| `getRecommendations(userId, preferences, filters?)` | Retorna lista de itens recomendados |
| `getRestaurantMenu(restaurantId)` | Detalha o menu de um restaurante |
| `searchRestaurants(query, location?)` | Busca restaurantes por nome ou categoria |

---

### Payment Splitter Agent

Responsável por calcular a divisão e emitir os meios de pagamento.

**Responsabilidades:**
- Calcular quanto cada participante deve com base nos itens que escolheu
- Gerar token de pagamento in-app por participante (deep link para o app iFood)
- Gerar QR Code PIX por participante para pagamento direto via banco
- Confirmar pagamentos recebidos e notificar o grupo

**Tools disponíveis:**
| Tool | Descrição |
|---|---|
| `splitOrder(orderId, participants[])` | Calcula a divisão por participante |
| `generatePaymentToken(participantId, amount, orderId)` | Gera token/deep link para pagamento no app iFood |
| `generatePixQRCode(participantId, amount, orderId)` | Gera QR Code PIX para pagamento bancário |
| `checkPaymentStatus(paymentId)` | Consulta status de um pagamento |
| `notifyPaymentConfirmed(sessionId, participantId)` | Notifica o grupo que um participante pagou |

---

## Fluxo Principal

```
1. INÍCIO DA SESSÃO
   Usuário: "Quero pedir pra 3 pessoas"
   Orchestrator: coleta nomes/IDs dos participantes

2. COLETA DE PREFERÊNCIAS
   Orchestrator (para cada participante):
     "O que o João quer comer?"
   Usuário: "Ele quer uma pizza"
   → Orchestrator → Recommendation Agent → getRecommendations("João", "pizza")
   → Exibe opções → Usuário confirma item

3. MONTAGEM DOS CARRINHOS
   Orchestrator agrupa itens por restaurante:
   - Carrinho A (Pizza Hut): item do João + item da Maria
   - Carrinho B (McDonald's): item do Pedro
   → addItemToCart(carrinhoA, pizzaCalabresa, 1)
   → addItemToCart(carrinhoB, BigMac, 1)

4. CONFIRMAÇÃO
   Orchestrator exibe resumo de todos os carrinhos
   Usuário aprova → confirmCarts()

5. DIVISÃO DA CONTA
   Usuário: "Divide a conta"
   → Payment Splitter Agent → splitOrder(orderId, [João, Maria, Pedro])
   Retorna:
     João:  R$ 42,90
     Maria: R$ 38,50
     Pedro: R$ 29,00

6. PAGAMENTO
   Payment Splitter Agent gera para cada participante:
   a) Token iFood → deep link para o app com resumo do pedido
   b) PIX QR Code → para pagamento direto via banco

   Usuário escolhe o modo (ou ambos são oferecidos)
   → generatePaymentToken(João, 42.90, orderId)
   → generatePixQRCode(João, 42.90, orderId)

7. CONFIRMAÇÃO DE PAGAMENTOS
   → checkPaymentStatus() polling ou webhook
   → notifyPaymentConfirmed() para cada pagamento recebido
   → Quando todos pagaram: pedido liberado para preparo
```

---

## Integrações

| Sistema | Responsabilidade |
|---|---|
| `ifood-backend` | Mock das APIs iFood: catálogo, carrinhos, pedidos, webhooks de pagamento |
| `ai-backend` | Orquestração dos agentes via MCP + Claude; exposição do chat via Telegram |
| Telegram Bot | Interface de chat para o usuário |
| PIX (mock) | Geração de QR Codes PIX para pagamento bancário |

---

## Canais de Entrega dos QR Codes

### Token iFood (in-app)
- Deep link do tipo `ifood://checkout?token=<token>`
- Ao abrir no app, o usuário vê o resumo do seu pedido e escolhe a forma de pagamento dentro do iFood
- Gerado pelo `ifood-backend` após `confirmCarts()`

### PIX QR Code
- QR Code estático ou dinâmico no padrão Banco Central
- Valor já embutido no payload do QR Code
- Pode ser pago por qualquer app bancário
- Gerado pelo `ifood-backend` ou mock de PSP

---

## Regras de carrinhos e pagadores

- Cada restaurante é **um carrinho**; cada carrinho gera um pedido independente no iFood.
- Cada item tem **exatamente um pagador**.
- Cada pessoa paga em **no máximo um carrinho** (o banco garante: `UNIQUE (participant_id)` em `cart_payers`). Quem quer itens de dois restaurantes precisa de outra pessoa pagando o segundo.
- Carrinho com 1 item: um único pagador. Carrinho com 2 ou mais itens: itens diferentes podem ter pagadores diferentes.
- Taxas e descontos do carrinho são divididos entre os pagadores **proporcionalmente ao valor dos itens** de cada um (maior resto, em centavos; a soma é sempre exatamente o total). Quem calcula é o sistema (`group-order/split.ts`), nunca o LLM.
- O pedido só vai para o `checkout` do iFood depois que **todos pagaram**.

## Pagamentos e eventos

```
group_confirm_order (ai-backend, após /confirmar do dono)
  └─► cria payments (1 por pagador) e pede a cobrança ao mock:  POST /payments {reference = payments.id}
        └─◄ token → link  http://localhost:<front>/pay/<token>   (enviado no Telegram, anexado pelo código)

pagador abre o link no front ─► GET /payments/by-token/:token  e  POST …/pay   (mock do iFood)
  └─► mock: UPDATE condicional + linha no outbox (mesma transação)
        └─► OutboxPublisher ─► RabbitMQ  exchange ifood.payments / routing key payment.confirmed
              └─► ai-backend.payments ─► PaymentEventsConsumer ─► PaymentsService.applyConfirmedEvent
                    └─► payments → carts → orders (pago) + aviso no Telegram do dono
```

| Peça | Garantia |
|---|---|
| Outbox no mock | o evento nasce na mesma transação do pagamento; se o RabbitMQ estiver fora, espera e sai quando voltar (at-least-once) |
| Fila durável + binding declarada também pelo mock | evento publicado antes do consumidor subir fica guardado |
| `processed_events` + `FOR UPDATE` no pedido | consumidor idempotente e seguro com eventos simultâneos do mesmo pedido |
| Retry (`.retry`, 5 s) e `.dlq` | falha transitória repete até 5 vezes; evento inválido/inconsistente (valor divergente, pagamento anulado) vai direto para a DLQ |

Evento `payment.confirmed` v1: `{ eventId, type, version: 1, occurredAt, data: { paymentId, reference, amountCents, paidAt } }`.
A topologia está duplicada em `ai-backend/src/payments/topology.ts` e `ifood-backend/src/events/topology.ts`: mudou um, mude o outro.
