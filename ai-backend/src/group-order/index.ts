// API pública do pedido em grupo. Quem está fora de group-order/ importa daqui (ou do
// group-order.module.ts), nunca dos arquivos internos.
export { GroupOrderError } from './group-order.errors.js';
export { GroupOrderService } from './group-order.service.js';
export {
  GroupOrderTools,
  type LocalToolResult,
  type Preparation,
  type ToolContext,
} from './group-order.tools.js';
export { GROUP_TOOLS } from './group-order.tool-defs.js';
export type {
  AssignPayerInput,
  CartSummary,
  OrderView,
  PaymentLink,
  SyncCartInput,
  SyncCartResult,
} from './group-order.types.js';
export { formatBRL, fromCents, toCents } from './money.js';
