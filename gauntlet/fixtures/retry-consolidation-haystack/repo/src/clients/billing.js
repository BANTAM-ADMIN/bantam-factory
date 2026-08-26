// Billing API client. Retries transient failures.
export async function chargeCard(request, transport) {
  let attempt = 0;
  let lastError;
  while (attempt < 4) {
    try {
      return await transport(request);
    } catch (error) {
      lastError = error;
      // Billing must never retry a declined card — only infrastructure faults.
      if (error.status !== 503 && error.status !== 429) throw error;
      attempt += 1;
      if (attempt >= 4) break;
      await new Promise((r) => setTimeout(r, 50 * (2 ** (attempt - 1))));
    }
  }
  throw lastError;
}
