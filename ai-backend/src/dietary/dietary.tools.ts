import { Injectable, Logger } from '@nestjs/common';
import {
  GroupOrderError,
  type LocalToolResult,
  type Preparation,
  type ToolContext,
} from '../group-order/index.js';
import { RESTRICTIONS } from './catalog/index.js';
import {
  checkItems,
  customKind,
  describeRestriction,
  formatVerdicts,
  type ItemVerdict,
  type SavedRestriction,
} from './dietary.check.js';
import { DietaryService } from './dietary.service.js';
import { DIET_CHECK, DIET_REMOVE, DIET_SAVE } from './dietary.tool-defs.js';
import {
  leafValues,
  parseItems,
  parsePerson,
  parseRestriction,
  type Input,
} from './dietary.input.js';
import { DIET_LIMIT_APPENDIX } from './dietary.policy.js';
import { VerdictCache } from './verdict-cache.js';
import { appConfig } from '../config/app-config.js';

// Filtro de restrição alimentar, ligado só para quem declarou uma restrição. As ferramentas ficam
// sempre na lista (assim o modelo consegue salvar quando o usuário falar), mas a política de uso
// (policyFor) só entra no prompt quando existe restrição salva, e diet_check_items recusa rodar
// sem restrição. A trava do carrinho (prepareMcpCall) é do código: o LLM não decide sozinho
// adicionar um item cortado.

const ok = (text: string, extra: Partial<LocalToolResult> = {}) => ({
  text,
  isError: false,
  ...extra,
});

@Injectable()
export class DietaryTools {
  private readonly logger = new Logger(DietaryTools.name);
  private readonly verdicts = new VerdictCache();

  constructor(private readonly diet: DietaryService) {}

  has(name: string): boolean {
    return name === DIET_SAVE || name === DIET_REMOVE || name === DIET_CHECK;
  }

  list(userId: number): Promise<SavedRestriction[]> {
    return this.diet.list(userId);
  }

  async execute(
    name: string,
    rawInput: unknown,
    ctx: ToolContext,
  ): Promise<LocalToolResult> {
    const input = (
      rawInput && typeof rawInput === 'object' ? rawInput : {}
    ) as Input;
    try {
      switch (name) {
        case DIET_SAVE: {
          const who = parsePerson(input);
          const raw = input.restrictions;
          if (!Array.isArray(raw) || raw.length === 0 || raw.length > 10) {
            throw new GroupOrderError('Informe de 1 a 10 restrições.');
          }
          const entries = raw.map(parseRestriction);
          await this.diet.save(ctx.userId, who, entries);
          this.verdicts.clear(ctx.userId);
          this.logger.log(
            `[diet] usuário ${ctx.userId} salvou ${entries.map((e) => e.kind).join(', ')}`,
          );
          const saved = await this.diet.list(ctx.userId);
          return ok(
            `Salvo. Restrições ativas agora: ${saved.map(describeRestriction).join('; ')}. A partir de agora confira os itens com ${DIET_CHECK} antes de sugerir ou adicionar.`,
          );
        }

        case DIET_REMOVE: {
          const who = parsePerson(input);
          const kinds = Array.isArray(input.kinds)
            ? input.kinds
                .filter((k): k is string => typeof k === 'string')
                .map((k) => (RESTRICTIONS[k] ? k : customKind(k)))
            : undefined;
          const removed = await this.diet.remove(ctx.userId, who.key, kinds);
          this.verdicts.clear(ctx.userId);
          const saved = await this.diet.list(ctx.userId);
          return ok(
            `${removed} restrição(ões) removida(s). ${saved.length ? `Ainda ativas: ${saved.map(describeRestriction).join('; ')}.` : 'Nenhuma restrição alimentar ativa.'}`,
          );
        }

        case DIET_CHECK: {
          const saved = await this.diet.list(ctx.userId);
          if (saved.length === 0) {
            throw new GroupOrderError(
              `Nenhuma restrição alimentar salva: não há o que conferir. Só use ${DIET_SAVE} se o usuário declarar uma restrição.`,
            );
          }
          const verdicts = checkItems(saved, parseItems(input));
          this.verdicts.remember(ctx.userId, verdicts);
          const strict = saved.some(
            (r) => r.category === 'alergia' || r.category === 'intolerancia',
          );
          return ok(
            formatVerdicts(saved, verdicts),
            strict ? { appendix: DIET_LIMIT_APPENDIX } : {},
          );
        }

        default:
          return { text: `Ferramenta desconhecida: ${name}`, isError: true };
      }
    } catch (err) {
      if (err instanceof GroupOrderError) {
        return { text: err.message, isError: true };
      }
      this.logger.error(
        `[diet] erro inesperado em ${name}: ${String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      return {
        text: 'Erro interno ao executar a ferramenta. Tente novamente.',
        isError: true,
      };
    }
  }

  isGuardedTool(name: string): boolean {
    return appConfig().mcp.dietGuardedToolPattern.test(name);
  }

  // Trava do carrinho para quem tem restrição: item nunca verificado é recusado; item cortado só
  // entra com /confirmar do usuário (mostrando o motivo do corte).
  async prepareMcpCall(
    ctx: ToolContext,
    name: string,
    input: unknown,
  ): Promise<Preparation> {
    if (!this.isGuardedTool(name)) return { kind: 'run' };
    if ((await this.diet.list(ctx.userId)).length === 0) return { kind: 'run' };

    const hits = leafValues(input)
      .map((v) => this.verdicts.get(ctx.userId, v))
      .filter((v): v is ItemVerdict => v !== undefined);
    if (hits.length === 0) {
      return {
        kind: 'reject',
        error: `Restrição alimentar ativa: confira este item com ${DIET_CHECK} (o mesmo item_id usado aqui, nome e descrição do getItem) antes de adicioná-lo ao carrinho.`,
      };
    }
    const cut = hits.find((v) => v.verdict === 'cortado');
    if (!cut) return { kind: 'run' };
    return {
      kind: 'confirm',
      summary: [
        `🚫 **${cut.item.label}** foi cortado pelo filtro de restrição alimentar:`,
        ...cut.reasons.map((r) => `• ${r}`),
        'Só confirme se quiser adicionar mesmo assim (ex.: é para outra pessoa).',
      ].join('\n'),
    };
  }
}
