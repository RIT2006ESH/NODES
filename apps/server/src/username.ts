const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;

export function normalizeUsername(value: string): string {
  return (value ?? '').normalize('NFKC').trim();
}

export function canonicalUsername(value: string): string {
  return normalizeUsername(value).toLowerCase();
}

export function validateUsername(value: string): string | null {
  const username = normalizeUsername(value);
  return USERNAME_PATTERN.test(username) ? username : null;
}

export function generateFallbackUsername(
  hint: string,
  isTaken: (username: string) => boolean,
): string {
  const cleaned = (hint ?? '').normalize('NFKC').replace(/[^A-Za-z0-9_]/g, '_');
  let base = cleaned.slice(0, 15);
  if (base.length < 3) {
    base = `Player_${base}`.slice(0, 15);
  }
  if (!isTaken(base)) return base;

  let counter = 1;
  while (true) {
    const candidate = `${base.slice(0, 14)}_${counter}`.slice(0, 20);
    if (!isTaken(candidate)) return candidate;
    counter++;
  }
}
