import { readFile, writeFile } from 'node:fs/promises';
import { parse, parseDocument } from 'yaml';
import { z } from 'zod';

export const ConfigSchema = z.object({
  version: z.literal(1),
  role: z.string().default(''),
  locations: z.array(z.string()).default([]),
  // Printed at the top of every resume.
  contact: z
    .object({
      name: z.string().default(''),
      email: z.union([z.email(), z.literal('')]).default(''),
      phone: z.string().default(''),
      location: z.string().default(''),
      links: z.array(z.url()).default([]),
    })
    .default({ name: '', email: '', phone: '', location: '', links: [] }),
  // Used for screening answers; never NopeRi's sample values.
  experienceYears: z.number().nonnegative().optional(),
  noticePeriodDays: z.number().int().nonnegative().optional(),
  currentCtcLpa: z.number().nonnegative().optional(),
  expectedCtcLpa: z.number().nonnegative().optional(),
  dealBreakers: z.array(z.string()).default([]),
  resume: z.object({ paper: z.enum(['a4', 'us-letter']).default('a4') }).default({ paper: 'a4' }),
  schedule: z
    .object({ morning: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM') })
    .default({ morning: '08:30' }),
});

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG_YAML = `# Offerstar settings. Personal values stay on this machine.
version: 1

# The role you are searching for, e.g. "Full-stack Node.js developer".
role: ""
locations: []

# Printed at the top of every resume.
contact:
  name: ""
  email: ""
  phone: ""
  location: ""
  links: []

# Used to answer screening questions. Leave a field out rather than guess.
# experienceYears: 3
# noticePeriodDays: 30
# currentCtcLpa: 12
# expectedCtcLpa: 18

# Jobs matching any of these are dropped, e.g. "night shift", "bond".
dealBreakers: []

resume:
  paper: a4

schedule:
  morning: "08:30"
`;

export async function loadConfig(path: string): Promise<Config> {
  const text = await readFile(path, 'utf8');
  return ConfigSchema.parse(parse(text) ?? {});
}

// Sets values by key path, keeping the file's comments and layout, and
// refuses a change that would make the config invalid.
export async function updateConfig(path: string, updates: [key: string[], value: unknown][]): Promise<Config> {
  const doc = parseDocument(await readFile(path, 'utf8'));
  for (const [key, value] of updates) doc.setIn(key, value);
  const config = ConfigSchema.parse(doc.toJS() ?? {});
  await writeFile(path, doc.toString());
  return config;
}
