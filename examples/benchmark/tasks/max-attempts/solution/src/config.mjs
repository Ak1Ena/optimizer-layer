const defaults = { maxAttempts: 3, timeoutMs: 1000 };

export function loadConfig(raw = {}) {
  const { retries, ...rest } = raw;
  // Legacy key: retries did not count the first try.
  const legacy = retries !== undefined && rest.maxAttempts === undefined ? { maxAttempts: retries + 1 } : {};
  const config = { ...defaults, ...legacy, ...rest };
  if (!Number.isInteger(config.maxAttempts) || config.maxAttempts < 1) throw new RangeError('maxAttempts must be a positive integer');
  return config;
}
