export async function retry(operation, {
  attempts = 3,
  shouldRetry = () => true,
  delay = () => {},
} = {}) {
  let lastError;
  for (let attempt = 0; attempt <= attempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      await delay(attempt, error);
    }
  }
  throw lastError;
}
