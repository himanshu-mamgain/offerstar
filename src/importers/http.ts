import pkg from '../../package.json' with { type: 'json' };

export type Fetch = typeof fetch;

export async function getJson<T>(url: string, { fetch: f = fetch, headers = {} }: { fetch?: Fetch; headers?: Record<string, string> } = {}): Promise<T> {
  const res = await f(url, { headers: { 'user-agent': `offerstar/${pkg.version}`, accept: 'application/json', ...headers } });
  if (!res.ok) {
    throw new Error(`${new URL(url).host} answered ${res.status} ${res.statusText}`.trim());
  }
  return (await res.json()) as T;
}

export const today = () => new Date().toISOString().slice(0, 10);

export const unique = (items: (string | null | undefined)[]) => [...new Set(items.filter((s): s is string => !!s))];
