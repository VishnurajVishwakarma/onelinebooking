/** ISO 4217 minor-unit exponents. Keep aligned with src/domain/validation.ts. */
const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = {
  AED: 2, ARS: 2, AUD: 2, BDT: 2, BHD: 3, BRL: 2, CAD: 2, CHF: 2,
  CLP: 0, CNY: 2, COP: 2, CZK: 2, DKK: 2, EGP: 2, EUR: 2, GBP: 2,
  HKD: 2, HUF: 2, IDR: 2, ILS: 2, INR: 2, ISK: 0, JOD: 3, JPY: 0,
  KES: 2, KRW: 0, KWD: 3, LKR: 2, MAD: 2, MXN: 2, MYR: 2, NGN: 2,
  NOK: 2, NZD: 2, OMR: 3, PEN: 2, PHP: 2, PKR: 2, PLN: 2, QAR: 2,
  RON: 2, RUB: 2, SAR: 2, SEK: 2, SGD: 2, THB: 2, TND: 3, TRY: 2,
  TWD: 2, USD: 2, VND: 0, ZAR: 2,
};

export function minorUnitExponent(currency: string): number {
  const exponent = CURRENCY_EXPONENTS[currency];
  if (exponent === undefined) {
    throw new Error(`Unsupported ISO currency code: ${currency}`);
  }
  return exponent;
}

/** Format an integer minor-unit amount for display. The engine keeps storing minor units. */
export function formatMinorCurrency(amountMinor: number, currency: string, locale = "en-IN"): string {
  const major = amountMinor / 10 ** minorUnitExponent(currency);
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(major);
}
