export const I128_MAX = (1n << 127n) - 1n;
export class MierkhatError extends Error {
  constructor(
    public code: string,
    public copyKey: string,
    public retryable = false,
  ) {
    super(code);
  }
}
export function rawAmount(value: string, positive = true): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || value.length > 39)
    throw new MierkhatError("BadAmount", "input.invalid");
  const n = BigInt(value);
  if (n > I128_MAX) throw new MierkhatError("Overflow", "input.too_large");
  if (positive && n === 0n) throw new MierkhatError("Zero", "input.positive");
  return n;
}
export function parseAmount(text: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38)
    throw new MierkhatError("Decimals", "input.invalid");
  const value = text.trim();
  if(value.length>80)throw new MierkhatError("Overflow","input.too_large");
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value))
    throw new MierkhatError("BadAmount", "input.invalid");
  const [whole = "", fraction = ""] = value.split(".");
  if (fraction.length > decimals)
    throw new MierkhatError("Precision", "input.precision");
  const raw =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0");
  rawAmount(raw.toString());
  return raw.toString();
}
export function formatAmount(value: string, decimals: number): string {
  rawAmount(value, false);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38)
    throw new Error("Decimals");
  if (!decimals) return value;
  const digits = value.padStart(decimals + 1, "0");
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return digits.slice(0, -decimals) + (fraction ? "." + fraction : "");
}
