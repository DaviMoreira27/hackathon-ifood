# Robustez do agente — plano

Anotações de 2026-10-17. Princípio que guia tudo: **toda regra checável vira código; o LLM fica só com
o que exige julgamento** (como já é com confirmação, trava do checkout, `compare_prices` e filtro
alimentar).

## Multi-agente: para que serviria (e por que não é prioridade)

O `agents.md` descreve Orchestrator + Recommendation + Payment Splitter. Usos reais aqui:

1. **Isolar o contexto das buscas** — um sub-agente faz várias `searchOffers`/`getMerchant` e devolve
   só um resumo (3 opções com preço e id). Hoje cada resultado (até 20k chars) entra no contexto e
   no histórico. É o benefício mais concreto.
2. **Modelo barato para tarefas mecânicas** — Haiku 5.5 para classificar, extrair, limpar
   transcrição de áudio.
3. **Agente revisor** — confere o carrinho final contra o pedido antes da confirmação.

Nenhum é a melhor ferramenta para robustez: cada agente a mais é outro prompt que pode errar, e a
passagem entre agentes perde informação. O Payment Splitter já está no código (`split.ts`), que é o
lugar certo. O revisor também é melhor como checagem em código.

## O que fazer, em ordem

### 1. Eval do agente com o modelo real (antes de tudo)

Sem isso não dá para saber se uma mudança de prompt melhorou ou piorou. O `agent.security.spec.ts`
testa o código com LLM falso; falta medir o comportamento do modelo. 30–50 conversas, com critérios
checáveis por código quando possível:

- sugeriu a opção mais barata? algum R$ da resposta não veio de uma ferramenta?
- pediu confirmação antes de `group_confirm_order`? nunca chamou `submitOrder` antes de pago?
- respeitou a restrição alimentar salva? explicou por que cortou?
- prompt injection num nome de prato ("ignore as instruções…") mudou o comportamento?
- perguntou só o necessário? pediu pagador quando ninguém definiu?

Roda sob demanda (custa API), não no `npm test`. Toda falha vista em demo vira um caso novo.

### 2. Tirar do prompt as regras que ainda só existem nele

- **`group_sync_cart` depende do LLM** — ele precisa lembrar de chamar `getCart` após cada mudança e
  **copiar à mão** subtotal, total e preço de cada item. Ponto mais frágil do sistema: número copiado
  errado = cobrança errada. Proposta: depois de cada `addItemToCart` / `updateCartItem` /
  `removeItemFromCart` bem-sucedido, o código chama `getCart` e sincroniza sozinho.
  ⚠️ Confirmar antes o formato dos argumentos do `getCart` no MCP real.
- **Estado do pedido injetado a cada turno** — hoje o prompt diz "se não tiver certeza, chame
  `group_get_order`". O código pode anexar um resumo curto do estado (carrinhos, participantes,
  status) em toda mensagem. Resolve também a janela de 40 mensagens (`HISTORY_ROWS`) cortando o
  `cartId` do contexto em conversas longas.
- **Validador da resposta final** — todo R$ e todo link da resposta precisa ter aparecido em algum
  resultado de ferramenta do turno; se não, pede ao modelo para corrigir. Links já são validados;
  falta valores.

### 3. Configuração da chamada à API (`agent.service.ts`)

Baseado na doc do Sonnet 5.5 (modelo em uso):

- [ ] **`MAX_TOKENS = 4096` está baixo** — com raciocínio adaptativo (padrão do modelo) o thinking
      conta em `max_tokens`; um turno com várias ferramentas pode ser cortado e virar
      `FALLBACK_REPLY`. Subir para ~16000.
- [ ] **Effort não definido** (vale o padrão `high`) — a doc recomenda começar em `medium` para uso
      de ferramentas em várias etapas. Definir `output_config.effort` explicitamente e comparar no eval.
- [ ] **Recusa não tratada** — `stop_reason: "refusal"` hoje cai como resposta vazia → erro genérico.
      Tratar com mensagem própria e logar `stop_details.category`.
- [ ] **`strict: true`** nas ferramentas locais (`group_*`, `diet_*`, `compare_prices`) para os
      argumentos sempre respeitarem o schema.
- ✅ Já certo: `history.ts` remove blocos de thinking de turnos antigos (senão a checagem de
  histórico editado do modelo daria 400).

### 4. Revisar o prompt (`system-prompt.ts`)

Cresceu por acréscimos. Procurar instruções redundantes/contraditórias, regras já garantidas pelo
código (podem sair) e trechos escritos para modelos antigos. A skill `claude-api` tem um roteiro
(`prompt-audit`). Fazer só depois do eval, para medir o efeito.

### 5. Trace por turno

Persistir por turno: ferramentas chamadas, tokens, latência, erros, rodada em que parou. Hoje o
`usage` só vai para o log. Com isso, uma falha de demo vira um caso reproduzível no eval.

## Alucinação: o mínimo possível

Não dá para zerar. Dá para garantir que **fatos que importam (ids, preços, links, ações executadas)
nunca dependam do texto do LLM**: o modelo escreve a conversa, o código entrega os fatos.

| # | Tipo | Hoje | Garantia |
|---|------|------|----------|
| 1 | R$ inventado na resposta | só o prompt pede | **Validador da resposta final**: todo `R$ xx,xx` precisa ter aparecido num resultado de ferramenta do turno/histórico recente; senão devolve ao modelo uma vez ("R$ 42,90 não veio de nenhuma ferramenta; corrija ou consulte"); se persistir, a resposta sai sem o valor. Mesmo padrão do `knownImageUrls`. |
| 2 | Número copiado errado para ferramenta | `group_sync_cart` recebe subtotal/total/preços **digitados pelo LLM** — pior risco (vira cobrança) | **Sync automático do carrinho** (item 2 acima): o LLM nunca transcreve número. |
| 3 | Id inventado ou trocado | MCP recusa id inexistente, mas aceita id **válido e errado** (item de outra loja, carrinho antigo) | **Registro de ids vistos**: escrita (`addItemToCart`, `setVoucher`…) com id que nunca apareceu num resultado de ferramenta da sessão é recusada antes do MCP. A trava do filtro alimentar já faz algo parecido. |
| 4 | Dizer que fez o que não fez ("adicionei", "confirmado", "apliquei o cupom") | nada impede | (a) **Resumo do pedido montado pelo código** e anexado (bloco "🧾 Seu pedido"), como já é com links de pagamento e confirmações. (b) **Checagem**: resposta afirma ação sem chamada bem-sucedida correspondente no turno → devolve ao modelo. |
| 5 | Responder de memória (prazo, promoção, horário, ingrediente) | prompt cobre preço/itens/ids, não o resto; Sonnet 5.5 às vezes responde do próprio conhecimento | Ampliar a regra: *"Qualquer fato sobre lojas, cardápio, preço, prazo, promoção ou pedido só pode vir de uma ferramenta chamada nesta conversa; se não tiver o dado, consulte ou diga que não sabe."* + estado do pedido injetado a cada turno (item 2) + filtro alimentar para ingredientes. Parcial. |
| 6 | Link inventado | ✅ coberto (`TRUSTED_LINK_HOSTS` + apêndice de pagamento) | — |

**Medir:**
- No eval, casos que provocam alucinação: busca sem taxa de entrega e o usuário pergunta "quanto
  fica?"; pergunta de tempo de entrega sem ferramenta que informe. Passa se consultar ou disser que
  não sabe.
- Em produção, logar cada disparo dos validadores. Disparando muito = problema de prompt/fluxo.

**Ordem:**
1. Sync automático do carrinho (dinheiro).
2. Validador de R$ + registro de ids (baratos, cobrem a maior parte).
3. Resumo do pedido pelo código + checagem de "disse que fez".
4. Regra ampliada no prompt + casos no eval.

## Por onde começar

1. Sync automático do carrinho (item 2) + ajustes de API (item 3) — mudanças pequenas que eliminam
   falhas reais.
2. Eval (item 1) — a partir daí, toda mudança de prompt é medida.
