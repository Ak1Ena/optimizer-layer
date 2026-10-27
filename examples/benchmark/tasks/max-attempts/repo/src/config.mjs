const defaults = { retries: 2, timeoutMs: 1000 };

export function loadConfig(raw = {}) {
  const config = { ...defaults, ...raw };
  if (!Number.isInteger(config.retries) || config.retries < 0) throw new RangeError('retries must be a non-negative integer');
  return config;
}
