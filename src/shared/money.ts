// SimpleFIN sends amounts as decimal strings ("-33293.43"). Parsing them through
// parseFloat and multiplying by 100 produces off-by-a-cent errors (0.29 * 100 = 28.999…),
// so this parses the digits directly.

const AMOUNT_RE = /^([+-])?(\d*)(?:\.(\d*))?$/;

export function parseCents(input: string | number): number {
  const raw = String(input).trim().replace(/[,\s$]/g, '');
  const m = AMOUNT_RE.exec(raw);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) {
    throw new Error(`Not a money amount: ${String(input)}`);
  }
  const sign = m[1] === '-' ? -1 : 1;
  const whole = m[2] === '' ? 0 : Number(m[2]);
  const frac = m[3] ?? '';
  // Round half away from zero on the third decimal (rare: some institutions send 3+ places).
  let cents = Number((frac + '00').slice(0, 2));
  if (frac.length > 2 && Number(frac[2]) >= 5) cents += 1;
  return sign * (whole * 100 + cents);
}

export function tryParseCents(input: unknown): number | null {
  if (input === null || input === undefined || input === '') return null;
  try {
    return parseCents(input as string);
  } catch {
    return null;
  }
}
