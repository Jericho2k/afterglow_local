/**
 * Browser-side JSON fetch helper.
 *
 * Every API route answers with `{ error }` on failure, so the rejection
 * carries the server's own message instead of a bare status code.
 */
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data as { error?: string }).error || `Request failed (${response.status})`);
  return data as T;
}
