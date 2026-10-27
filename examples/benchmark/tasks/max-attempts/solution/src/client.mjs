export async function withRetries(config, operation) {
  let lastError;
  for (let attempt = 0; attempt < config.maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
