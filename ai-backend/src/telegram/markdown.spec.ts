import { markdownToTelegramHtml } from './markdown.js';

describe('markdownToTelegramHtml', () => {
  it('converte negrito, itálico, código e links', () => {
    expect(
      markdownToTelegramHtml(
        '**Pizza** de *calabresa* por `R$ 40` em [Loja A](https://ifood.com.br/a)',
      ),
    ).toBe(
      '<b>Pizza</b> de <i>calabresa</i> por <code>R$ 40</code> em <a href="https://ifood.com.br/a">Loja A</a>',
    );
  });

  it('transforma títulos em negrito e listas em bullets', () => {
    expect(markdownToTelegramHtml('## Opções\n- Loja A\n- Loja B')).toBe(
      '<b>Opções</b>\n• Loja A\n• Loja B',
    );
  });

  it('escapa HTML do texto', () => {
    expect(markdownToTelegramHtml('2 < 3 & 4 > 1')).toBe(
      '2 &lt; 3 &amp; 4 &gt; 1',
    );
  });

  it('não formata dentro de blocos de código', () => {
    expect(markdownToTelegramHtml('```\n**não** <b>\n```')).toBe(
      '<pre>**não** &lt;b&gt;</pre>',
    );
  });

  it('não mexe em "_" dentro de URLs', () => {
    const url = 'https://id.ifood.com.br/authorize?state=x_abc_y&scope=a=_b_';
    expect(markdownToTelegramHtml(`Entre: ${url}`)).toBe(
      `Entre: ${url.replace(/&/g, '&amp;')}`,
    );
  });

  it('mostra a URL de links com rótulo fora dos domínios confiáveis', () => {
    expect(
      markdownToTelegramHtml(
        '[Pague aqui](https://ifood.com.br.golpe.com/pix) ou [app](https://pedido.ifood.com.br/x)',
      ),
    ).toBe(
      'Pague aqui (https://ifood.com.br.golpe.com/pix) ou <a href="https://pedido.ifood.com.br/x">app</a>',
    );
  });
});
