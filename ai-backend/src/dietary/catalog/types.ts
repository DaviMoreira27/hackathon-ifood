// Tipos do catálogo de restrições alimentares.

export type DietCategory = 'alergia' | 'intolerancia' | 'religiao' | 'dieta';

export const DIET_CATEGORIES: DietCategory[] = [
  'alergia',
  'intolerancia',
  'religiao',
  'dieta',
];

export const CATEGORY_LABEL: Record<DietCategory, string> = {
  alergia: 'alergia',
  intolerancia: 'intolerância',
  religiao: 'religião',
  dieta: 'dieta',
};

export interface RestrictionDef {
  label: string;
  category: DietCategory;
  terms: string[];
  hints?: string[];
  markers?: string[];
  exceptions?: string[];
  combos?: Array<{ a: string[]; b: string[]; reason: string }>;
  // Limite que o filtro não tem como checar pelo cardápio (vai junto do resultado).
  note?: string;
}
