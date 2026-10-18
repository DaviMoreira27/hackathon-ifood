// API pública das restrições alimentares. Quem está fora de dietary/ importa daqui (ou do
// dietary.module.ts), nunca dos arquivos internos.
export type { SavedRestriction } from './dietary.check.js';
export { DIET_LIMIT_APPENDIX, policyFor } from './dietary.policy.js';
export { DIET_TOOLS } from './dietary.tool-defs.js';
export { DietaryTools } from './dietary.tools.js';
