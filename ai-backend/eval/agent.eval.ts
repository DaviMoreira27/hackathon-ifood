import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { Logger } from '@nestjs/common';
import { loadAgentConfig } from '../src/agent/agent.config.js';
import { globalChecks, runScenario, type Check, type Run } from './harness.js';
import { SCENARIOS } from './scenarios.js';

// Eval do agente com o modelo real. Custa API: roda só sob demanda (npm run eval), nunca no npm test.
//   EVAL_ONLY=e1,c2      roda só esses cenários (prefixo do id)
//   EVAL_CONCURRENCY=4   conversas em paralelo
//   EVAL_DRY=1           sem API: o "modelo" só responde "ok" (testa o harness, não o agente)
// Modelo, effort e limites vêm do .env (AGENT_*), como no bot. O resultado vai para
// eval/results/<data>.json e .md.

// US$ por milhão de tokens, prompts até 100K tokens no Haiku. Escrita de cache = 1,25x a entrada.
const PRICES: Record<
  string,
  { input: number; output: number; cacheRead: number }
> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
};

interface Result {
  id: string;
  category: string;
  checks: Check[];
  passed: boolean;
  run: Run;
}

async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
) {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

describe('eval do agente (modelo real)', () => {
  it(
    'roda os cenários',
    async () => {
      const dry = process.env.EVAL_DRY === '1';
      const config = loadAgentConfig();
      if (!dry && !config.apiKey) {
        throw new Error('ANTHROPIC_API_KEY ausente no .env');
      }
      Logger.overrideLogger(['error']);
      const anthropic = dry
        ? ({
            messages: {
              create: async () => ({
                stop_reason: 'end_turn',
                content: [{ type: 'text', text: 'ok' }],
                usage: { input_tokens: 0, output_tokens: 0 },
              }),
            },
          } as unknown as Anthropic)
        : new Anthropic({ apiKey: config.apiKey });
      const only = process.env.EVAL_ONLY?.split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const scenarios = only
        ? SCENARIOS.filter((s) => only.some((o) => s.id.startsWith(o)))
        : SCENARIOS;
      const startedAt = Date.now();

      const results = await pool(
        scenarios,
        Number(process.env.EVAL_CONCURRENCY ?? 4),
        async (scenario, i): Promise<Result> => {
          const run = await runScenario(anthropic, config, scenario, 1000 + i);
          let checks: Check[];
          try {
            checks = [...scenario.checks(run), ...globalChecks(run)];
          } catch (err) {
            checks = [
              { name: 'checks rodaram', pass: false, detail: String(err) },
            ];
          }
          const passed = checks.every((c) => c.pass);
          console.log(`${passed ? 'PASSOU' : 'FALHOU'}  ${scenario.id}`);
          return {
            id: scenario.id,
            category: scenario.category,
            checks,
            passed,
            run,
          };
        },
      );

      const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      for (const r of results) {
        for (const t of r.run.ctx.traces.turns) {
          usage.input += t.inputTokens ?? 0;
          usage.output += t.outputTokens ?? 0;
          usage.cacheRead += t.cacheReadTokens ?? 0;
          usage.cacheWrite += t.cacheWriteTokens ?? 0;
        }
      }
      const price = PRICES[config.model];
      const cost = price
        ? (usage.input * price.input +
            usage.output * price.output +
            usage.cacheRead * price.cacheRead +
            usage.cacheWrite * price.input * 1.25) /
          1e6
        : null;

      const allChecks = results.flatMap((r) => r.checks);
      const byCategory = new Map<string, { ok: number; total: number }>();
      for (const r of results) {
        const c = byCategory.get(r.category) ?? { ok: 0, total: 0 };
        c.total += 1;
        if (r.passed) c.ok += 1;
        byCategory.set(r.category, c);
      }
      const validatorHits = results.flatMap((r) =>
        r.run.ctx.traces.turns.flatMap((t) =>
          (t.validatorHits ?? []).map((h) => `${r.id}: ${h}`),
        ),
      );

      const md = [
        `# Eval do agente — ${new Date(startedAt).toISOString()}`,
        '',
        `Modelo: ${config.model} · effort: ${config.effort} · max_tokens: ${config.maxTokens} · rodadas: ${config.maxToolRounds} · ${Math.round((Date.now() - startedAt) / 1000)}s`,
        '',
        `**Conversas: ${results.filter((r) => r.passed).length}/${results.length} · checks: ${allChecks.filter((c) => c.pass).length}/${allChecks.length}**`,
        '',
        `Tokens: in ${usage.input} · out ${usage.output} · cache read ${usage.cacheRead} · cache write ${usage.cacheWrite} · custo ≈ ${cost === null ? `desconhecido (sem preço para ${config.model})` : `US$ ${cost.toFixed(4)}`}`,
        '',
        '| Categoria | Conversas OK |',
        '|---|---|',
        ...[...byCategory].map(([k, v]) => `| ${k} | ${v.ok}/${v.total} |`),
        '',
        '## Falhas',
        '',
        ...results
          .filter((r) => !r.passed)
          .flatMap((r) => [
            `### ${r.id}`,
            ...r.checks
              .filter((c) => !c.pass)
              .map(
                (c) =>
                  `- ✗ ${c.name}${c.detail ? ` — ${c.detail.replace(/\n/g, ' ')}` : ''}`,
              ),
            '',
            ...r.run.turns.flatMap((t) => [
              `> **usuário:** ${t.user}`,
              '>',
              `> **bot:** ${t.reply.replace(/\n/g, '\n> ')}`,
              '',
            ]),
            `Ferramentas pedidas: ${r.run.requested.map((q) => q.name).join(', ') || 'nenhuma'}`,
            '',
          ]),
        '## Disparos dos validadores',
        '',
        ...(validatorHits.length
          ? validatorHits.map((h) => `- ${h}`)
          : ['nenhum']),
        '',
      ].join('\n');

      mkdirSync('eval/results', { recursive: true });
      const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-');
      writeFileSync(`eval/results/${stamp}.md`, md);
      writeFileSync(
        `eval/results/${stamp}.json`,
        JSON.stringify(
          {
            startedAt: new Date(startedAt).toISOString(),
            usage,
            config: { ...config, apiKey: undefined },
            cost,
            results: results.map((r) => ({
              id: r.id,
              category: r.category,
              passed: r.passed,
              checks: r.checks,
              error: r.run.error,
              turns: r.run.turns,
              requested: r.run.requested,
              mcpCalls: r.run.ctx.ifood.calls,
              traces: r.run.ctx.traces.turns,
            })),
          },
          null,
          2,
        ),
      );
      console.log(
        `\n${md.split('## Falhas')[0]}\nRelatório: eval/results/${stamp}.md`,
      );
    },
    60 * 60 * 1000,
  );
});
