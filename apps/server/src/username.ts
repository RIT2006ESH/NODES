const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;

export function normalizeUsername(value: string): string {
  return value.trim();
}

export function validateUsername(value: string): string | null {
  const username = normalizeUsername(value);
  return USERNAME_PATTERN.test(username) ? username : null;
}
