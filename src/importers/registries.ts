import { slugify, type EvidenceBlockInput } from '../profile.ts';
import { getJson, today, unique, type Fetch } from './http.ts';

// Importers for roles beyond JavaScript: Python, Java, iOS, DevOps, and
// certifications. Each makes one evidence block per thing the user built or
// earned, with a public link as the evidence.

type Opts = { fetch?: Fetch };

const firstSentence = (text: string | undefined, max = 220) => {
  const s = (text ?? '').replace(/\s+/g, ' ').trim();
  const end = s.search(/[.!?](\s|$)/);
  return (end > 0 && end < max ? s.slice(0, end + 1) : s.slice(0, max)).trim();
};

// PyPI hides user pages behind a browser check, so packages are named.
export async function importPypi(packages: string[], opts: Opts = {}): Promise<EvidenceBlockInput[]> {
  const blocks: EvidenceBlockInput[] = [];
  for (const name of packages) {
    const { info } = await getJson<{ info: { name: string; summary: string | null; keywords: string | null; project_urls: Record<string, string> | null } }>(
      `https://pypi.org/pypi/${encodeURIComponent(name)}/json`,
      opts,
    );
    const source = Object.entries(info.project_urls ?? {}).find(([k, v]) => /source|repository|code|github/i.test(k) || /github\.com|gitlab\.com/.test(v))?.[1];
    blocks.push({
      id: `pypi-${slugify(info.name)}`,
      type: 'project',
      title: info.name,
      summary: info.summary ?? '',
      skills: unique(['python', ...(info.keywords ?? '').split(/[,\s]+/).slice(0, 6)]),
      evidence: [{ kind: 'package', url: `https://pypi.org/project/${info.name}/` }, ...(source ? [{ kind: 'repo' as const, url: source }] : [])],
      verified: 'linked',
      updated: today(),
    });
  }
  return blocks;
}

// Every artifact published under a Maven groupId the user owns.
export async function importMaven(groupId: string, opts: Opts = {}): Promise<EvidenceBlockInput[]> {
  const { response } = await getJson<{ response: { docs: { g: string; a: string; latestVersion: string }[] } }>(
    `https://search.maven.org/solrsearch/select?q=g:${encodeURIComponent(groupId)}&rows=100&wt=json`,
    opts,
  );
  return response.docs.map((d) => ({
    id: `maven-${slugify(d.a)}`,
    type: 'project' as const,
    title: `${d.g}:${d.a}`,
    summary: '',
    skills: ['java', 'maven'],
    evidence: [{ kind: 'package' as const, url: `https://central.sonatype.com/artifact/${d.g}/${d.a}` }],
    verified: 'linked' as const,
    updated: today(),
  }));
}

// Apps by an App Store developer id (the number in the developer's page URL).
export async function importAppStore(developerId: string, opts: Opts = {}): Promise<EvidenceBlockInput[]> {
  const { results } = await getJson<{ results: { wrapperType: string; trackName?: string; trackViewUrl?: string; description?: string; primaryGenreName?: string }[] }>(
    `https://itunes.apple.com/lookup?id=${encodeURIComponent(developerId)}&entity=software&limit=200`,
    opts,
  );
  return results
    .filter((r) => r.wrapperType === 'software' && r.trackName && r.trackViewUrl)
    .map((r) => ({
      id: `app-${slugify(r.trackName!)}`,
      type: 'project' as const,
      title: r.trackName!,
      summary: firstSentence(r.description),
      skills: ['ios'],
      evidence: [{ kind: 'app' as const, url: r.trackViewUrl! }],
      verified: 'linked' as const,
      updated: today(),
    }));
}

// Public images a Docker Hub user or organisation publishes.
export async function importDocker(user: string, opts: Opts = {}): Promise<EvidenceBlockInput[]> {
  const { results } = await getJson<{ results: { name: string; namespace: string; description: string | null }[] }>(
    `https://hub.docker.com/v2/repositories/${encodeURIComponent(user)}/?page_size=100`,
    opts,
  );
  return results.map((r) => ({
    id: `docker-${slugify(r.name)}`,
    type: 'project' as const,
    title: `${r.namespace}/${r.name}`,
    summary: r.description ?? '',
    skills: ['docker'],
    evidence: [{ kind: 'link' as const, url: `https://hub.docker.com/r/${r.namespace}/${r.name}` }],
    verified: 'linked' as const,
    updated: today(),
  }));
}

// Pods the user maintains, by name.
export async function importCocoapods(pods: string[], opts: Opts = {}): Promise<EvidenceBlockInput[]> {
  const blocks: EvidenceBlockInput[] = [];
  for (const name of pods) {
    await getJson(`https://trunk.cocoapods.org/api/v1/pods/${encodeURIComponent(name)}`, opts);
    blocks.push({
      id: `pod-${slugify(name)}`,
      type: 'project',
      title: name,
      summary: '',
      skills: ['ios', 'cocoapods'],
      evidence: [{ kind: 'package', url: `https://cocoapods.org/pods/${name}` }],
      verified: 'linked',
      updated: today(),
    });
  }
  return blocks;
}

interface CredlyBadge {
  id: string;
  issued_at_date: string | null;
  expires_at_date: string | null;
  badge_template: { name: string; skills?: { name: string }[] };
  issuer?: { entities?: { entity?: { name?: string } }[] };
}

// Credly badges: certifications signed by their issuer.
export async function importCredly(user: string, opts: Opts = {}): Promise<EvidenceBlockInput[]> {
  const { data } = await getJson<{ data: CredlyBadge[] }>(`https://www.credly.com/users/${encodeURIComponent(user)}/badges.json`, opts);
  const month = (d: string | null) => (d ? d.slice(0, 7) : undefined);
  return data.map((b) => ({
    id: `cert-${slugify(b.badge_template.name)}`,
    type: 'certification' as const,
    title: b.badge_template.name,
    organization: b.issuer?.entities?.[0]?.entity?.name,
    start: month(b.issued_at_date),
    end: month(b.expires_at_date),
    skills: unique((b.badge_template.skills ?? []).map((s) => s.name.toLowerCase()).slice(0, 8)),
    evidence: [{ kind: 'certificate' as const, url: `https://www.credly.com/badges/${b.id}` }],
    verified: 'issuer-signed' as const,
    updated: today(),
  }));
}
