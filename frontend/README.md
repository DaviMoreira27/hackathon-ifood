# iFood – fluxo de pedido (frontend)

Simulação das telas do fluxo de pedido. Next.js 14 (App Router) + TypeScript + Tailwind + Zustand,
pensado para conviver com um backend NestJS (mesma linguagem, tipos em `src/lib/types.ts` espelham os DTOs).

## Rodar
```bash
npm install
cp .env.example .env.local   # NEXT_PUBLIC_API_URL=http://localhost:3001 (ifood-backend)
npm run dev                  # http://localhost:5173
```
Com o backend, a entrada é o link enviado no Telegram: `http://localhost:5173/pay/<token>`.
Sem `NEXT_PUBLIC_API_URL`, `/sacola` abre com dados mockados (`src/lib/mock.ts`).

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

## Backend (ifood-backend, mock do iFood)
| Chamada | Uso |
|---|---|
| `GET /orders/by-token/:token` | Pedido do link: subpedidos (um por cobrança) com itens e status. Só o subpedido do token fica selecionável; os outros aparecem como pagos ou aguardando o pagamento de cada pessoa |
| `GET /payments/by-token/:token` | Status da cobrança (antes de pagar e no polling do Pix) |
| `POST /payments/by-token/:token/pay` | Paga: Google Pay na hora, Pix pelo botão `[dev]`. O mock publica `payment.confirmed` e o ai-backend avisa no Telegram |

O pedido é enviado ao mock pelo ai-backend quando as cobranças são emitidas, com os itens/valores do
banco e os detalhes do `getCart` do MCP (loja, complementos, observação, prazo, endereço).
O código Pix copia e cola é montado no front (`src/lib/pix.ts`) com o valor da cobrança.

## Layout no desktop
O app aparece dentro de uma moldura de celular centralizada (tela 420×800) escalada para caber na altura da janela
(notebook 15,6" incluído). Abaixo de 520 px de largura ocupa a tela inteira.
