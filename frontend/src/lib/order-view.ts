import type { CartItem, PayerOrderView, RestaurantInfo, SubOrder } from "./types";

// O backend não tem foto nem categoria: o emoji/gradiente sai de palavras-chave do nome.
const KINDS: { match: RegExp; emoji: string; accent: string }[] = [
  { match: /pizz/i, emoji: "🍕", accent: "from-red-500 via-orange-500 to-yellow-400" },
  { match: /burg|lanche|smash|sandu|mc ?donald|bk\b|king/i, emoji: "🍔", accent: "from-fuchsia-500 via-orange-400 to-amber-300" },
  { match: /doce|bolo|confeit|sobremesa|cheesecake|brownie|torta|a[çc]a[ií]|sorvete/i, emoji: "🍰", accent: "from-pink-400 via-rose-400 to-orange-300" },
  { match: /sushi|japon|temaki|poke/i, emoji: "🍣", accent: "from-rose-500 via-red-400 to-orange-300" },
  { match: /salad|vegan|vegetar|natural|fit/i, emoji: "🥗", accent: "from-lime-500 via-green-400 to-emerald-300" },
  { match: /frango|chicken/i, emoji: "🍗", accent: "from-amber-500 via-orange-400 to-yellow-300" },
  { match: /batata|fritas/i, emoji: "🍟", accent: "from-yellow-500 via-amber-400 to-orange-300" },
  { match: /refri|suco|bebida|coca|guaran|[áa]gua|cerveja/i, emoji: "🥤", accent: "from-sky-500 via-cyan-400 to-teal-300" },
  { match: /caf[ée]|padaria/i, emoji: "☕", accent: "from-amber-700 via-amber-500 to-yellow-300" },
  { match: /taco|mexic|burrito/i, emoji: "🌮", accent: "from-orange-500 via-amber-400 to-lime-300" },
];
const FALLBACK = { emoji: "🍽️", accent: "from-slate-500 via-slate-400 to-slate-300" };
const kindOf = (name: string) => KINDS.find((k) => k.match.test(name)) ?? FALLBACK;

const slug = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-");

const ETA = "Hoje, 30 - 45min"; // quando o MCP não informou o prazo

// Um subpedido por cobrança. Só o do dono do link fica "open"; os outros pendentes aparecem como
// aguardando pagamento (cada pessoa paga pelo próprio link).
export function toSubOrders(view: PayerOrderView): SubOrder[] {
  return view.subOrders.map((p, index) => {
    const kind = kindOf(p.restaurant.name);
    const name = p.restaurant.name;
    const restaurant: RestaurantInfo = { id: slug(name), name, emoji: kind.emoji, accent: kind.accent };
    const items: CartItem[] = p.items.map((i) => ({
      id: String(i.id),
      name: i.name,
      description: i.description ?? "",
      emoji: kindOf(i.name) === FALLBACK ? kind.emoji : kindOf(i.name).emoji,
      price: i.unitPriceCents / 100,
      qty: i.quantity,
      options: i.options.length ? i.options.map((o) => ({ qty: o.quantity, name: o.name })) : undefined,
    }));
    const itemsCents = p.items.reduce((s, i) => s + i.unitPriceCents * i.quantity, 0);
    const own = p.chargeReference === view.ownChargeReference;
    return {
      id: p.chargeReference,
      label: `Subpedido ${index + 1} — ${own ? "você" : p.participant}`,
      restaurant,
      items,
      // taxas e descontos já rateados pelo backend: o que sobra do valor da cobrança
      fee: (p.amountCents - itemsCents) / 100,
      eta: p.eta ?? ETA,
      // só o próprio subpedido pendente pode ser pago neste link
      status: p.status === "paid" ? "paid" : own && p.status === "pending" ? "open" : "awaiting_payment",
      paidBy: p.status === "paid" ? (own ? "Você" : p.participant) : undefined,
    };
  });
}
