import type { Logger } from '@nestjs/common';
import type { Message } from '@anthropic-ai/sdk/resources/messages.js';
import { imageCatalog, takeImages, type ReplyImage } from '../images.js';
import { orderSummary } from '../order-state.js';
import {
  correctionNote,
  emptyReplyNote,
  knownCents,
  stripAmounts,
  unbackedClaims,
  unknownAmounts,
} from '../reply-check.js';
import type { PendingAction, TurnContext } from './turn-context.js';
import type { TurnTranscript } from './turn-transcript.js';

export const FALLBACK_REPLY =
  'Desculpe, ocorreu um erro interno. Tente novamente.';
export const REFUSAL_REPLY =
  'Não posso ajudar com esse pedido. Posso ajudar a buscar comida, montar o carrinho ou dividir a conta.';

export type Finalized =
  { kind: 'retry' } | { kind: 'reply'; text: string; images: ReplyImage[] };

// Tudo o que acontece com a resposta final do LLM antes de ela sair: validadores (com uma nova
// tentativa), fotos, resumo do pedido montado pelo código, links e o pedido de confirmação.
export class ReplyFinalizer {
  constructor(private readonly logger: Logger) {}

  // `canRetry`: ainda dá para pedir uma correção ao modelo neste turno.
  async finalize(
    response: Message,
    ctx: TurnContext,
    transcript: TurnTranscript,
    { retried, canRetry }: { retried: boolean; canRetry: boolean },
  ): Promise<Finalized> {
    // Com max_tokens o modelo pode parar no meio de um tool_use. Ele não é executado, então
    // não pode ir para o histórico: um tool_use sem tool_result quebra todas as próximas chamadas.
    const content = response.content.filter((b) => b.type !== 'tool_use');
    let text = content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    // O modelo às vezes encerra o turno só com raciocínio, sem texto: pede a resposta uma vez
    // em vez de mandar o erro genérico ao usuário. Com links ou confirmação pendente, o código
    // já tem o que mostrar.
    if (
      !text.trim() &&
      !ctx.appendices.length &&
      !ctx.pendingAction &&
      canRetry
    ) {
      ctx.recordValidatorHit(`vazia:${response.stop_reason}`);
      this.logger.warn(
        `[agent] resposta sem texto no chat ${ctx.chatId} (stop_reason=${response.stop_reason}); pedindo de novo`,
      );
      if (content.length)
        transcript.pushScratch({ role: 'assistant', content });
      transcript.pushScratch({
        role: 'user',
        content: [{ type: 'text', text: emptyReplyNote() }],
      });
      return { kind: 'retry' };
    }

    // Validador da resposta final: todo R$ precisa ter vindo de uma ferramenta, do sistema
    // ou do usuário, e toda ação afirmada precisa ter dado certo neste turno.
    const known = ctx.appendices.length
      ? new Set([
          ...ctx.facts.knownCents(),
          ...knownCents(ctx.appendices.join('\n')),
        ])
      : ctx.facts.knownCents();
    const amounts = unknownAmounts(text, known);
    const claims = unbackedClaims(text, [...ctx.succeeded]);
    if (amounts.length || claims.length) {
      const hits = [
        ...amounts.map((a) => `valor:${a.text}`),
        ...claims.map((c) => `acao:${c}`),
      ];
      ctx.recordValidatorHit(...hits);
      this.logger.warn(
        `[agent] validador da resposta disparou no chat ${ctx.chatId}${retried ? ' (de novo)' : ''}: ${hits.join(', ')}`,
      );
      if (canRetry) {
        transcript.pushScratch({ role: 'assistant', content });
        transcript.pushScratch({
          role: 'user',
          content: [{ type: 'text', text: correctionNote(amounts, claims) }],
        });
        return { kind: 'retry' };
      }
      // Persistiu: o valor sem origem sai da resposta.
      text = stripAmounts(text, amounts);
    }

    transcript.push({ role: 'assistant', content });
    // As fotos saem do texto e vão como imagens; só valem URLs que vieram das ferramentas.
    const { text: cleaned, images } = takeImages(
      text,
      imageCatalog(transcript.messages),
    );
    const summary = ctx.cartWasChanged
      ? await this.orderSummary(ctx, cleaned)
      : null;
    const reply = [
      cleaned || (ctx.appendices.length || summary ? '' : FALLBACK_REPLY),
      summary,
      ...ctx.appendices,
    ]
      .filter(Boolean)
      .join('\n\n');
    return { kind: 'reply', text: reply, images };
  }

  // O aviso de confirmação é montado pelo código a partir dos argumentos reais: o LLM não
  // consegue esconder ou maquiar o que vai ser executado.
  withConfirmation(reply: string, pending?: PendingAction): string {
    if (!pending) return reply;
    return [
      reply,
      '',
      // Nome da ferramenta e argumentos ficam só nos logs: quem lê é uma pessoa.
      pending.summary
        ? '⚠️ **Confirmação necessária:**'
        : '⚠️ **Confirmação necessária**',
      ...(pending.summary ? [pending.summary] : []),
      '',
      'Toque em **Confirmar** ou responda **confirmar** em até 5 minutos para seguir. Qualquer outra mensagem cancela.',
    ].join('\n');
  }

  private async orderSummary(
    ctx: TurnContext,
    reply: string,
  ): Promise<string | null> {
    try {
      return orderSummary(await ctx.orderView(), reply);
    } catch (err) {
      this.logger.warn(
        `[agent] não consegui montar o resumo do pedido do chat ${ctx.chatId}: ${String(err)}`,
      );
      return null;
    }
  }
}
