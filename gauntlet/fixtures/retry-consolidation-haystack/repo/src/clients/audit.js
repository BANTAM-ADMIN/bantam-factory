// Audit log client. Retries transient failures.
export async function append(request, transport) {
  let attempt = 0;
  let lastError;
  while (attempt < 5) {
    try {
      return await transport(request);
    } catch (error) {
      lastError = error;
      if (error.status !== 503 && error.status !== 429) throw error;
      attempt += 1;
      if (attempt >= 5) break;
      // Audit writes are idempotent and cheap; back off flat, not exponentially.
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  throw lastError;
}
