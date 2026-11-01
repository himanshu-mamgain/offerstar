import { slugify, type EvidenceBlockInput } from '../profile.ts';
import { getJson, today, unique, type Fetch } from './http.ts';

interface Repo {
  name: string;
  description: string | null;
  html_url: string;
  homepage: string | null;
  language: string | null;
  topics?: string[];
  fork: boolean;
  archived: boolean;
}

export interface GithubImportOptions {
  includeForks?: boolean;
  includeArchived?: boolean;
  token?: string;
  fetch?: Fetch;
}

// One project block per public repository the user owns. The repo link is
// the evidence; the description is the user's own words.
export async function importGithub(user: string, opts: GithubImportOptions = {}): Promise<EvidenceBlockInput[]> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;

  const repos: Repo[] = [];
  for (let page = 1; ; page++) {
    const url = `https://api.github.com/users/${encodeURIComponent(user)}/repos?type=owner&sort=pushed&per_page=100&page=${page}`;
    const batch = await getJson<Repo[]>(url, { fetch: opts.fetch, headers });
    repos.push(...batch);
    if (batch.length < 100) break;
  }

  return repos
    .filter((r) => (opts.includeForks || !r.fork) && (opts.includeArchived || !r.archived))
    .map((r) => ({
      id: `gh-${slugify(r.name)}`,
      type: 'project' as const,
      title: r.name,
      summary: r.description ?? '',
      skills: unique([r.language?.toLowerCase(), ...(r.topics ?? [])]),
      evidence: [
        { kind: 'repo' as const, url: r.html_url },
        ...(r.homepage && /^https?:\/\//.test(r.homepage) ? [{ kind: 'link' as const, url: r.homepage }] : []),
      ],
      verified: 'linked' as const,
      updated: today(),
    }));
}
