import { SYSTEM_PROMPT } from './system-prompt.js';

// O prompt fixo é o prefixo do prompt cache: qualquer byte diferente invalida o cache de todo
// mundo. Mudou de propósito? Atualize o snapshot (vitest -u) no mesmo commit.
describe('SYSTEM_PROMPT', () => {
  it('continua byte a byte igual ao snapshot', () => {
    expect(SYSTEM_PROMPT).toMatchSnapshot();
  });
});
