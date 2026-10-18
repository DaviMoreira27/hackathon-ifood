// Pix copia e cola (BR Code / EMV do Banco Central) com o valor embutido. Mock: a chave é fictícia
// e o pagamento de verdade é confirmado pelo mock do iFood.
const field = (id: string, value: string) => `${id}${value.length.toString().padStart(2, "0")}${value}`;

function crc16(payload: string) {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

export function buildPixCode(amount: number, txid: string) {
  const payload =
    field("00", "01") +
    field("26", field("00", "br.gov.bcb.pix") + field("01", "pagamentos@ifood.example")) +
    field("52", "0000") +
    field("53", "986") +
    field("54", amount.toFixed(2)) +
    field("58", "BR") +
    field("59", "IFOOD PEDIDO EM GRUPO") +
    field("60", "SAO PAULO") +
    field("62", field("05", txid.replace(/[^A-Za-z0-9]/g, "").slice(0, 25))) +
    "6304";
  return payload + crc16(payload);
}
