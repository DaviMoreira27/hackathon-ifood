# Plano: memória de preferências e "pede o mesmo da sexta passada"

Status: **proposta, nada implementado**.

## Objetivo

A tabela `dietary_restrictions` já guarda restrições alimentares por usuário entre conversas. A ideia
é lembrar mais coisas no mesmo molde: endereço padrão, restaurantes favoritos, orçamento habitual
por pessoa e "o de sempre". E aceitar pedidos como "pede o mesmo da sexta passada", montados a
partir do histórico de pedidos.

## Por que não funciona hoje

O histórico de `orders` existe, mas não guarda o suficiente para **refazer** um pedido no iFood:

| Falta | Por que importa |
|---|---|
| `carts` tem só `restaurant_name`, sem `merchant_id` | `createCart` exige o `merchantId` |
| `cart_items` não guarda as personalizações (`optionId` de borda, adicionais) | `addItemToCart` precisa delas: "a pizza com borda de catupiry" voltaria sem borda |
| `UNIQUE (cart_id, ifood_item_id)` | impede duas unidades do mesmo item com personalizações diferentes |
| nenhum `ifood_order_id` nem `submitted_at` | "sexta passada" é a data em que o pedido foi enviado, não o `created_at` de quando começou a ser montado; o `orderId` também liga ao `getOrder` do iFood, que tem o detalhe oficial |
| o item guarda o pagador, não quem comeu | em grupo, "o de sempre da Maria" depende de quem comeu |
| o prompt não tem a data de hoje | o agente não tem como resolver "sexta passada" |

## Fontes de dados

O iFood já resolve parte disso, e o nosso banco completa:

- **iFood (fonte da verdade dos itens):** `getRecommendations` com `contentMode: "RECENT_ORDERS"`
  traz `lastOrderedAt`, `timesOrdered` e `lastOrderId`; `getOrder` traz os itens de um pedido;
  `contentMode: "FAVORITE_MERCHANTS"` traz as lojas favoritas. Isso cobre também pedidos feitos fora
  do bot.
- **Nosso banco (o que o iFood não sabe):** a composição do grupo (quem comeu e quem pagou cada
  item), preferências declaradas no bot e pedidos salvos com nome.

## O que fazer

### Etapa 1: histórico que dê para repetir (destrava "pede o mesmo da sexta")

- Migration:
  - `carts.merchant_id`;
  - `orders.ifood_order_id` e `orders.submitted_at`;
  - `cart_items.options` (JSONB com `optionGroupId`/`optionId`);
  - `cart_items.eater_participant_id` (quem comeu, opcional);
  - trocar o `UNIQUE (cart_id, ifood_item_id)` por um id de item do carrinho (`cartItemId` do iFood).
- `group_sync_cart` passa a receber `merchant_id` e as personalizações, que o `getCart` já devolve;
  `group_mark_finalized` grava o `orderId` do `submitOrder` e a hora do envio.
- Data de hoje (com fuso de São Paulo) num bloco dinâmico do prompt de sistema, **depois** do bloco
  fixo que tem o `cache_control`, para não estragar o cache.
- Ferramenta local de histórico: recebe um intervalo de datas explícito (o LLM converte "sexta
  passada" usando a data do prompt) e/ou um restaurante, e devolve os pedidos com loja, itens,
  personalizações e quem comeu.
- Repetir um pedido revalida tudo antes de montar o carrinho:
  - o item ainda existe (`getItem`);
  - preço atual comparado ao da época ("subiu R$ 3");
  - loja aberta;
  - personalizações ainda válidas.

  Depois segue o fluxo normal até o `/confirmar`, que continua obrigatório no `submitOrder`.

### Etapa 2: tabela de preferências

Mesmo padrão da `dietary_restrictions`: por usuário, com `person_key` ('' = o próprio usuário; senão,
o nome normalizado de outra pessoa do grupo).

| Preferência | O que guardar | Observação |
|---|---|---|
| Endereço padrão | só o `addressId` de `listAddresses` + um rótulo ("casa") e o id da conta iFood dono dele (`getUser`) | nunca o endereço ou as coordenadas. O `addressId` é da conta iFood: ao trocar de conta no mesmo Telegram, a preferência é ignorada (mesmo motivo de o `/logout` apagar o histórico) |
| Restaurantes favoritos | `merchant_id` + nome, só os declarados no bot ("adoro a Pizza Express") | os favoritos do app vêm de `FAVORITE_MERCHANTS` |
| Orçamento por pessoa | valor em centavos, só se o usuário disser | se não disser, o "habitual" é calculado na hora a partir dos últimos pedidos, sem gravar: um valor inferido e salvo fica velho sem ninguém perceber |
| "O de sempre" | pedido salvo explicitamente: `merchant_id` + itens (`itemId`, quantidade, `optionIds`) | pode ter mais de um, com nome ("o de sempre da Maria") |

- Ferramentas locais, como as `group_*` e as de restrição alimentar: ver, salvar e esquecer
  preferências.
- Resumo curto das preferências no mesmo bloco dinâmico do prompt (junto com a data), em vez de uma
  chamada de ferramenta no começo de cada mensagem: não gasta rodada e mantém o cache das
  ferramentas e do prompt fixo.

### Etapa 3: sugestões inferidas

- "Seu de sempre parece ser X (pedido 4 vezes), quer salvar?": a partir da frequência no histórico e
  de `timesOrdered` do iFood.
- Orçamento habitual calculado sugerido nas buscas (`maxItemPrice`).
- Só sugestão: nada é gravado sem o usuário pedir.

## Riscos e decisões

- **Prompt injection que persiste.** Hoje um texto malicioso no catálogo afeta uma conversa; com
  memória, ele poderia tentar gravar um "endereço padrão" e afetar os pedidos seguintes. Regras:
  - salvar só quando o usuário pedir;
  - o **código** (não o LLM) mostra o que foi salvo ("Salvei: orçamento R$ 40/pessoa");
  - trocar o endereço padrão passa pelo `/confirmar` (desviar a entrega é o ataque mais valioso);
  - preferências relidas entram no contexto com a mesma marcação de dados não confiáveis
    (`wrapToolResult`) dos resultados de ferramenta.
- **LGPD.** Comandos para ver ("o que você sabe sobre mim?") e apagar tudo. **Decidir:** o `/logout`
  apaga também as preferências ou só o histórico da conversa?
- **Preço antigo.** O preço gravado é só referência; vale sempre o que o iFood responder na hora.
- **Raciocínio do modelo (thinking).** O bloco dinâmico do prompt muda entre mensagens; isso só é
  seguro porque `rowsToMessages` já descarta os blocos de raciocínio de turnos anteriores. Manter
  essa remoção.
- **Coordenação.** A etapa 1 mexe em `group_sync_cart`, `group_mark_finalized` e nas tabelas do
  pedido em grupo: combinar antes com quem estiver trabalhando nelas.

## Ordem sugerida

1. Etapa 1: migration do histórico, data no prompt, histórico de pedidos e repetição de pedido.
2. Etapa 2: tabela de preferências, ferramentas e resumo no contexto, com confirmação na troca de
   endereço.
3. Etapa 3: sugestões inferidas.
