import { markdownToWhatsapp } from './markdown.js';

describe('markdownToWhatsapp', () => {
  it('converte negrito, itálico, tachado e mantém código', () => {
    expect(
      markdownToWhatsapp(
        '**Pizza** de *calabresa* ou _mussarela_, ~~R$ 50~~ por `R$ 40`',
      ),
    ).toBe('*Pizza* de _calabresa_ ou _mussarela_, ~R$ 50~ por `R$ 40`');
  });

  it('__negrito__ também vira negrito', () => {
    expect(markdownToWhatsapp('__Total__: R$ 40')).toBe('*Total*: R$ 40');
  });

  it('transforma títulos em negrito e listas em "-"', () => {
    expect(markdownToWhatsapp('## Opções\n* Loja A\n+ Loja B\n- Loja C')).toBe(
      '*Opções*\n- Loja A\n- Loja B\n- Loja C',
    );
  });

  it('título com negrito dentro não duplica os asteriscos', () => {
    expect(markdownToWhatsapp('# Pedido **pronto**')).toBe('*Pedido pronto*');
  });

  it('link com rótulo mostra a URL', () => {
    expect(
      markdownToWhatsapp('[Pague aqui](https://pay.example.com/x_y)'),
    ).toBe('Pague aqui: https://pay.example.com/x_y');
  });

  it('não mexe em "_" nem "*" dentro de URLs', () => {
    const url = 'https://id.ifood.com.br/authorize?state=x_abc_y&scope=a*b*';
    expect(markdownToWhatsapp(`Entre: ${url}`)).toBe(`Entre: ${url}`);
  });

  it('não formata dentro de blocos de código e fecha bloco aberto', () => {
    expect(markdownToWhatsapp('```js\n**não**\n```')).toBe('```\n**não**\n```');
    expect(markdownToWhatsapp('```\n**aberto**')).toBe('```\n**aberto**\n```');
  });
});
