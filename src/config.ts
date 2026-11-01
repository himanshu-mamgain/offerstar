import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';

export const ConfigSchema = z.object({
  version: z.literal(1),
  role: z.string().default(''),
  locations: z.array(z.string()).default([]),
  // Used for screening answers; never NopeRi's sample values.
  experienceYears: z.number().nonnegative().optional(),
  noticePeriodDays: z.number().int().nonnegative().optional(),
  currentCtcLpa: z.number().nonnegative().optional(),
  expectedCtcLpa: z.number().nonnegative().optional(),
  dealBreakers: z.array(z.string()).default([]),
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

# Used to answer screening questions. Leave a field out rather than guess.
# experienceYears: 3
# noticePeriodDays: 30
# currentCtcLpa: 12
# expectedCtcLpa: 18

# Jobs matching any of these are dropped, e.g. "night shift", "bond".
dealBreakers: []

schedule:
  morning: "08:30"
`;

export async function loadConfig(path: string): Promise<Config> {
  const text = await readFile(path, 'utf8');
  return ConfigSchema.parse(parse(text) ?? {});
}
