import { slugify, type EvidenceBlockInput } from '../profile.ts';
import { getJson, today, unique, type Fetch } from './http.ts';

interface SearchResult {
  objects: {
    package: {
      name: string;
      description?: string;
      keywords?: string[];
      links: { npm: string; repository?: string; homepage?: string };
    };
  }[];
}

// One project block per package the user maintains on npm.
export async function importNpm(user: string, opts: { fetch?: Fetch } = {}): Promise<EvidenceBlockInput[]> {
  const url = `https://registry.npmjs.org/-/v1/search?text=maintainer:${encodeURIComponent(user)}&size=250`;
  const { objects } = await getJson<SearchResult>(url, opts);

  return objects.map(({ package: p }) => ({
    id: `npm-${slugify(p.name)}`,
    type: 'project' as const,
    title: p.name,
    summary: p.description ?? '',
    skills: unique(['npm', ...(p.keywords ?? []).slice(0, 8)]),
    evidence: [
      { kind: 'package' as const, url: p.links.npm },
      ...(p.links.repository ? [{ kind: 'repo' as const, url: p.links.repository }] : []),
    ],
    verified: 'linked' as const,
    updated: today(),
  }));
}
