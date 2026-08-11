export const BUSINESS_TYPES = ["CLINIC", "RESTAURANT"] as const;

export type BusinessType = (typeof BUSINESS_TYPES)[number];

export function isBusinessType(value: unknown): value is BusinessType {
  return typeof value === "string" && (BUSINESS_TYPES as readonly string[]).includes(value);
}
