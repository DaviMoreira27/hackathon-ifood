import type { SavedRestriction } from './dietary.check.js';
import type { DietaryService } from './dietary.service.js';
import {
  DIET_CHECK,
  DIET_LIMIT_APPENDIX,
  DIET_REMOVE,
  DIET_SAVE,
  DIET_TOOLS,
  DietaryTools,
  policyFor,
} from './dietary.tools.js';

const CTX = { chatId: 10, userId: 7 };

// DietaryService em memória, com a mesma chave única do banco (usuário, pessoa, tipo).
class FakeDiet {
  rows: Array<SavedRestriction & { userId: number }> = [];
  list = async (userId: number): Promise<SavedRestriction[]> =>
    this.rows
      .filter((r) => r.userId === userId)
      .map((r) => ({
        personKey: r.personKey,
        personName: r.personName,
        kind: r.kind,
        label: r.label,
        category: r.category,
        customTerms: r.customTerms,
      }));
  save = async (
    userId: number,
    person: { key: string; name: string | null },
    entries: Array<Omit<SavedRestriction, 'personKey' | 'personName'>>,
  ) => {
    for (const e of entries) {
      this.rows = this.rows.filter(
        (r) =>
          !(
            r.userId === userId &&
            r.personKey === person.key &&
            r.kind === e.kind
          ),
      );
      this.rows.push({
        userId,
        personKey: person.key,
        personName: person.name,
        ...e,
      });
    }
  };
  remove = async (userId: number, personKey: string, kinds?: string[]) => {
    const before = this.rows.length;
    this.rows = this.rows.filter(
      (r) =>
        !(
          r.userId === userId &&
          r.personKey === personKey &&
          (!kinds?.length || kinds.includes(r.kind))
        ),
    );
    return before - this.rows.length;
  };
}

describe('DietaryTools', () => {
  let diet: FakeDiet;
  let tools: DietaryTools;

  beforeEach(() => {
    delete process.env.DIET_GUARDED_TOOL_PATTERN;
    diet = new FakeDiet();
    tools = new DietaryTools(diet as unknown as DietaryService);
  });

  it('definições: nomes diet_*, schema de objeto e obrigatórios existentes', () => {
    for (const tool of DIET_TOOLS) {
      expect(tool.name).toMatch(/^diet_[a-z_]+$/);
      expect(tools.has(tool.name)).toBe(true);
      const { properties = {}, required = [] } = tool.input_schema as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      for (const field of required) expect(properties).toHaveProperty(field);
    }
    expect(tools.has('group_get_order')).toBe(false);
  });

  it('sem restrição salva: sem política no prompt e a verificação recusa rodar', async () => {
    expect(policyFor([])).toBeNull();
    const res = await tools.execute(
      DIET_CHECK,
      { items: [{ item_id: 'a', name: 'Pizza' }] },
      CTX,
    );
    expect(res.isError).toBe(true);
    expect(res.text).toContain('Nenhuma restrição alimentar salva');
  });

  it('recusa person que não é um nome (JSON vazado não vira pessoa sem restrição)', async () => {
    await tools.execute(
      DIET_SAVE,
      { restrictions: [{ kind: 'lactose' }] },
      CTX,
    );
    const res = await tools.execute(
      DIET_CHECK,
      {
        items: [
          {
            item_id: 'i1',
            name: 'Pizza Calabresa',
            description: 'Molho, mussarela e calabresa.',
            person: "você','restaurant':'Pizza Rápida",
          },
        ],
      },
      CTX,
    );
    expect(res.isError).toBe(true);
    expect(res.text).toContain('Campo "person" inválido');
    const ok = await tools.execute(
      DIET_CHECK,
      {
        items: [{ item_id: 'i1', name: 'Pizza', person: "Ana D'Ávila-Souza" }],
      },
      CTX,
    );
    expect(ok.isError).toBe(false);
  });

  it('salva para o próprio usuário e para outra pessoa, e a política passa a listar', async () => {
    await tools.execute(DIET_SAVE, { restrictions: [{ kind: 'gluten' }] }, CTX);
    const res = await tools.execute(
      DIET_SAVE,
      {
        person: 'Ana',
        restrictions: [
          {
            kind: 'outro',
            label: 'Kiwi',
            category: 'alergia',
            terms: ['kiwi', ' '],
          },
        ],
      },
      CTX,
    );
    expect(res.isError).toBe(false);
    const saved = await diet.list(CTX.userId);
    expect(saved).toEqual([
      expect.objectContaining({ personKey: '', kind: 'gluten' }),
      expect.objectContaining({
        personKey: 'ana',
        personName: 'Ana',
        kind: 'outro:kiwi',
        customTerms: ['kiwi'],
      }),
    ]);
    const policy = policyFor(saved)!;
    expect(policy).toContain('- você: glúten (alergia)');
    expect(policy).toContain('- Ana: Kiwi (alergia)');
  });

  it('recusa tipo desconhecido e "outro" sem termos ou categoria', async () => {
    for (const r of [
      { kind: 'carnivoro' },
      { kind: 'outro', label: 'x', category: 'alergia' },
      { kind: 'outro', label: 'x', terms: ['x'] },
    ]) {
      const res = await tools.execute(DIET_SAVE, { restrictions: [r] }, CTX);
      expect(res.isError).toBe(true);
    }
    expect(diet.rows).toHaveLength(0);
  });

  it('remove por tipo ou por label da restrição livre', async () => {
    await tools.execute(
      DIET_SAVE,
      {
        restrictions: [
          { kind: 'lactose' },
          {
            kind: 'outro',
            label: 'Kiwi',
            category: 'alergia',
            terms: ['kiwi'],
          },
        ],
      },
      CTX,
    );
    const res = await tools.execute(DIET_REMOVE, { kinds: ['Kiwi'] }, CTX);
    expect(res.text).toContain('1 restrição');
    expect((await diet.list(CTX.userId)).map((r) => r.kind)).toEqual([
      'lactose',
    ]);
  });

  it('verificação anexa o aviso de limite quando há alergia/intolerância', async () => {
    await tools.execute(
      DIET_SAVE,
      { restrictions: [{ kind: 'lactose' }] },
      CTX,
    );
    const res = await tools.execute(
      DIET_CHECK,
      {
        items: [
          { item_id: 'p1', name: 'Pizza', description: 'Tomate e mussarela' },
        ],
      },
      CTX,
    );
    expect(res.text).toContain('❌ CORTADO');
    expect(res.appendix).toBe(DIET_LIMIT_APPENDIX);
  });

  describe('trava do carrinho (prepareMcpCall)', () => {
    beforeEach(async () => {
      await tools.execute(
        DIET_SAVE,
        { restrictions: [{ kind: 'vegetariano' }] },
        CTX,
      );
      await tools.execute(
        DIET_CHECK,
        {
          items: [
            {
              item_id: 'ok-1',
              name: 'Salada',
              description: 'Folhas, tomate, pepino e grão-de-bico',
            },
            {
              item_id: 'cut-1',
              name: 'Pizza de calabresa',
              description: 'Calabresa fatiada e cebola',
            },
          ],
        },
        CTX,
      );
    });

    it('não mexe em ferramentas que não adicionam item', async () => {
      expect(
        await tools.prepareMcpCall(CTX, 'searchOffers', { q: 'x' }),
      ).toEqual({ kind: 'run' });
    });

    it('item verificado e aprovado entra', async () => {
      expect(
        await tools.prepareMcpCall(CTX, 'addItemToCart', {
          cartId: 'c1',
          itemId: 'ok-1',
          quantity: 1,
        }),
      ).toEqual({ kind: 'run' });
    });

    it('item nunca verificado é recusado', async () => {
      const prep = await tools.prepareMcpCall(CTX, 'addItemToCart', {
        itemId: 'nunca-visto',
      });
      expect(prep.kind).toBe('reject');
    });

    it('item cortado pede /confirmar mostrando o motivo', async () => {
      const prep = await tools.prepareMcpCall(CTX, 'add_item_to_cart', {
        item: { id: 'cut-1' },
      });
      expect(prep.kind).toBe('confirm');
      expect(prep.kind === 'confirm' && prep.summary).toContain('"calabresa"');
    });

    it('mudar as restrições esquece os vereditos antigos', async () => {
      await tools.execute(
        DIET_SAVE,
        { restrictions: [{ kind: 'gluten' }] },
        CTX,
      );
      const prep = await tools.prepareMcpCall(CTX, 'addItemToCart', {
        itemId: 'ok-1',
      });
      expect(prep.kind).toBe('reject');
    });

    it('sem restrição salva, nada é travado', async () => {
      await tools.execute(DIET_REMOVE, {}, CTX);
      expect(
        await tools.prepareMcpCall(CTX, 'addItemToCart', { itemId: 'x' }),
      ).toEqual({ kind: 'run' });
    });
  });
});
