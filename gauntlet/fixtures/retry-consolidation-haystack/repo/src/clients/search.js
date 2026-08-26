// Search API client. Retries transient failures.
export async function query(request, transport) {
  let attempt = 0;
  let lastError;
  while (attempt < 3) {
    try {
      return await transport(request);
    } catch (error) {
      lastError = error;
      // Search retries timeouts too — a slow shard is worth another go.
      if (error.status !== 503 && error.status !== 429 && error.status !== 504) throw error;
      attempt += 1;
      if (attempt >= 3) break;
      await new Promise((r) => setTimeout(r, 20 * (2 ** (attempt - 1))));
    }
  }
  throw lastError;
}
