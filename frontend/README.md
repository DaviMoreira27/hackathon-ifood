# iFood – fluxo de pedido (frontend)

Simulação das telas do fluxo de pedido. Next.js 14 (App Router) + TypeScript + Tailwind + Zustand,
pensado para conviver com um backend NestJS (mesma linguagem, tipos em `src/lib/types.ts` espelham os DTOs).

## Rodar
```bash
npm install
cp .env.example .env.local   # opcional: NEXT_PUBLIC_API_URL=http://localhost:3000
npm run dev                  # http://localhost:3001
```
Sem `NEXT_PUBLIC_API_URL`, o pedido é criado com dados mockados (`src/services/api.ts`).

## Modelo
Um **pedido** (link compartilhado) tem vários **subpedidos**: do mesmo restaurante (itens diferentes) ou de restaurantes
diferentes. Cada subpedido pode ser pago por uma pessoa diferente e **uma única vez**; quem quiser pagar mais de um
entra de novo no link. A interface é somente leitura (sem limpar/editar/adicionar itens).

Status do subpedido: `open` (selecionável) · `awaiting_payment` (Pix gerado) · `paid` (bloqueado).

## Fluxo
| Rota | Tela |
|---|---|
| `/sacola` | Lista de subpedidos; seleciona **um** em aberto → Continuar |
| `/checkout` | Só o subpedido escolhido: pagamento, resumo, CPF → Finalizar abre "Revise o seu pedido" |
| `/pagamento` | iFood Pago, só pelo app: Google Pay, Pix (abre ao tocar no método em `/checkout`) |
| `/pix` | Pix copia e cola com contagem regressiva (ao vencer, o subpedido volta a `open`) |
| `/pedido-confirmado` | Subpedido pago → "Pagar outro subpedido" volta à lista (botão `[dev]` no Pix simula a aprovação) |

## Contrato esperado do backend
`POST /orders/:orderId/sub-orders/:subOrderId/payments` com `CreatePaymentPayload` → `Charge` (ver `src/lib/types.ts`).
- Responder **409** se o subpedido já estiver pago ou aguardando pagamento (a regra de "pagar uma única vez" precisa valer no servidor; o front só reflete).
- Para Pix, `Charge` traz `pixCode` e `expiresAt` (epoch ms).
- A lista de subpedidos (com `status` e `paidBy`) deve vir do backend; hoje é mock em `src/lib/mock.ts`.

## Layout no desktop
O app aparece dentro de uma moldura de celular centralizada (tela 420×800) escalada para caber na altura da janela
(notebook 15,6" incluído). Abaixo de 520 px de largura ocupa a tela inteira.
