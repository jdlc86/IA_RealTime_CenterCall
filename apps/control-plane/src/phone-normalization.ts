export type PhoneNormalizationOptions = { defaultCountryCallingCode?: string };

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

function validateE164(value: string): string {
  if (!/^\+[1-9]\d{7,14}$/.test(value)) throw new Error("Invalid E.164 phone number");
  return value;
}

export function normalizePhoneToE164(raw: string, options: PhoneNormalizationOptions = {}): string {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("Phone number is required");
  const value = raw.trim();

  if (value.startsWith("+") || value.startsWith("00")) {
    const digits = digitsOnly(value.startsWith("00") ? value.slice(2) : value.slice(1));
    return validateE164(`+${digits}`);
  }

  const country = options.defaultCountryCallingCode?.trim().replace(/^00/, "+").replace(/[^+0-9]/g, "");
  if (!country || !/^\+[1-9]\d{0,3}$/.test(country)) {
    throw new Error("National-format phone number requires an explicit country calling code");
  }

  const national = digitsOnly(value);
  if (country === "+34" && !/^[6789]\d{8}$/.test(national)) {
    throw new Error("Invalid Spanish national phone number");
  }
  if (country !== "+34" && (national.length < 4 || national.length > 12)) {
    throw new Error("Invalid national phone number");
  }
  return validateE164(`${country}${national}`);
}

export function phonesEquivalent(a: string, b: string, options: PhoneNormalizationOptions = {}): boolean {
  try {
    return normalizePhoneToE164(a, options) === normalizePhoneToE164(b, options);
  } catch {
    return false;
  }
}
