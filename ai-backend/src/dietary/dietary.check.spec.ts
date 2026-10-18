import {
  checkItems,
  formatVerdicts,
  personKeyOf,
  type SavedRestriction,
} from './dietary.check.js';
import { RESTRICTIONS } from './catalog/index.js';

const known = (
  kind: string,
  person: string | null = null,
): SavedRestriction => ({
  personKey: personKeyOf(person),
  personName: person,
  kind,
  label: RESTRICTIONS[kind].label,
  category: RESTRICTIONS[kind].category,
  customTerms: [],
});

const one = (
  saved: SavedRestriction[],
  label: string,
  description?: string,
  person?: string,
) => checkItems(saved, [{ itemId: 'i1', label, description, person }])[0];

describe('checkItems', () => {
  it('corta item que cita o ingrediente, sem depender de acento ou caixa', () => {
    const v = one(
      [known('lactose')],
      'Pizza Margherita',
      'Molho de tomate, MUÇARELA e manjericão',
    );
    expect(v.verdict).toBe('cortado');
    expect(v.reasons[0]).toContain('"muçarela"');
    expect(v.reasons[0]).toContain('lactose — você');
  });

  it('casa o plural e não casa pedaço de palavra', () => {
    expect(
      one([known('ovo')], 'Salada', 'Alface, tomate e ovos cozidos').verdict,
    ).toBe('cortado');
    expect(
      one([known('ovo')], 'Prato novo da casa', 'Arroz, feijão e salada verde')
        .verdict,
    ).toBe('passou');
  });

  it('passa item com descrição que não cita o ingrediente, explicando o porquê', () => {
    const v = one(
      [known('lactose')],
      'Moqueca',
      'Peixe, leite de coco, dendê, pimentão e coentro',
    );
    expect(v.verdict).toBe('passou');
    expect(v.reasons[0]).toContain('a descrição não menciona lactose');
  });

  it('marker da loja vira incerto (nunca passa direto) quando o ingrediente é citado', () => {
    const v = one(
      [known('lactose')],
      'Pizza',
      'Mussarela zero lactose e tomate',
    );
    expect(v.verdict).toBe('incerto');
    expect(v.reasons[0]).toContain('"zero lactose"');
  });

  it('"sem lactose" não serve para alergia à proteína do leite', () => {
    const v = one([known('leite')], 'Iogurte', 'Iogurte natural sem lactose');
    expect(v.verdict).toBe('cortado');
  });

  it('prato que costuma levar o ingrediente: corta em alergia, incerto nas demais', () => {
    expect(
      one([known('gluten')], 'Coxinha', 'Frango desfiado e catupiry').verdict,
    ).toBe('cortado');
    expect(
      one(
        [known('vegetariano')],
        'Hambúrguer da casa',
        'Pão brioche, alface e tomate',
      ).verdict,
    ).toBe('incerto');
  });

  it('a loja declarando "sem glúten" libera o prato, mas não o ingrediente', () => {
    expect(
      one(
        [known('gluten')],
        'Pão sem glúten',
        'Pão de fermentação natural feito com farinha de arroz',
      ).verdict,
    ).toBe('passou');
    expect(
      one(
        [known('gluten')],
        'Pão sem glúten',
        'Contém farinha de trigo integral',
      ).verdict,
    ).toBe('incerto');
  });

  it('sem descrição é incerto e repete o limite da restrição', () => {
    const v = one([known('amendoim')], 'Sorvete', '');
    expect(v.verdict).toBe('incerto');
    expect(v.reasons[0]).toContain('não descreve os ingredientes');
    expect(v.reasons[0]).toContain('Traços de amendoim');
  });

  it('kosher corta a mistura de carne com laticínio', () => {
    const v = one(
      [known('kosher')],
      'Filé à parmegiana',
      'Contrafilé empanado com queijo e molho',
    );
    expect(v.verdict).toBe('cortado');
    expect(v.reasons[0]).toContain('mistura carne e laticínio');
  });

  it('restrição livre usa os termos que o usuário informou', () => {
    const kiwi: SavedRestriction = {
      personKey: '',
      personName: null,
      kind: 'outro:kiwi',
      label: 'kiwi',
      category: 'alergia',
      customTerms: ['kiwi'],
    };
    expect(
      one([kiwi], 'Salada de frutas', 'Manga, kiwi e morango').verdict,
    ).toBe('cortado');
  });

  it('em grupo, cada item é conferido contra as restrições de quem vai comer', () => {
    const saved = [known('vegetariano', 'Ana'), known('lactose')];
    const pizza = 'Calabresa, mussarela e cebola';

    expect(one(saved, 'Pizza calabresa', pizza, 'Ana').reasons[0]).toContain(
      'Ana',
    );
    expect(one(saved, 'Pizza calabresa', pizza, 'eu').reasons[0]).toContain(
      'você',
    );
    const bruno = one(saved, 'Pizza calabresa', pizza, 'Bruno');
    expect(bruno.verdict).toBe('passou');
    expect(bruno.reasons[0]).toContain('Bruno não tem restrição');
    // Sem pessoa: vale tudo o que está salvo.
    expect(one(saved, 'Pizza calabresa', pizza).reasons).toHaveLength(2);
  });

  it('o pior veredito vence e só os motivos dele aparecem', () => {
    const v = one(
      [known('lactose'), known('gluten')],
      'Salada',
      'Folhas verdes, tomate e croutons de pão com queijo',
    );
    expect(v.verdict).toBe('cortado');
    expect(v.reasons.every((r) => !r.includes('não menciona'))).toBe(true);
  });
});

describe('formatVerdicts', () => {
  it('lista restrições, vereditos com item_id e o limite do filtro', () => {
    const saved = [known('amendoim')];
    const out = formatVerdicts(
      saved,
      checkItems(saved, [
        {
          itemId: 'abc',
          label: 'Paçoca',
          restaurant: 'Doceria',
          description: 'Doce de amendoim',
        },
      ]),
    );
    expect(out).toContain('Restrições consideradas: você: amendoim (alergia)');
    expect(out).toContain('❌ CORTADO — Paçoca (Doceria) [item_id abc]');
    expect(out).toContain('nunca diga que um item é seguro');
  });
});
