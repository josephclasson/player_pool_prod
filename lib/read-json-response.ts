/**
 * Read a fetch Response as JSON, with a clear error when the body is HTML
 * (e.g. 404 page, Next.js error overlay, auth redirect) instead of JSON.
 */
export async function readJsonResponse<T>(res: Response, context: string): Promise<T> {
  const text = await res.text();
  const trimmed = text.trimStart();
  if (
    trimmed.startsWith("<!DOCTYPE") ||
    trimmed.startsWith("<!doctype") ||
    trimmed.startsWith("<html") ||
    trimmed.startsWith("<HTML")
  ) {
    throw new Error(
      `${context}: server returned a web page instead of JSON (HTTP ${res.status}). Check that the API route exists and the dev server is running.`
    );
  }
  if (!trimmed) {
    if (!res.ok) throw new Error(`${context}: empty response (HTTP ${res.status})`);
    return {} as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `${context}: response was not valid JSON (HTTP ${res.status}): ${trimmed.slice(0, 120)}`
    );
  }
}
