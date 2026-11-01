import { homedir } from 'node:os';
import { join } from 'node:path';

// Folder name under profile/ for each evidence block type.
export const PROFILE_FOLDERS = {
  experience: 'experience',
  project: 'projects',
  skill: 'skills',
  achievement: 'achievements',
  certification: 'certifications',
  education: 'education',
} as const;

export interface Paths {
  home: string;
  config: string;
  env: string;
  profile: string;
  db: string;
  applications: string;
  learnings: string;
}

// OFFERSTAR_HOME overrides the default ~/.offerstar, mainly for tests.
export function resolvePaths(home = process.env.OFFERSTAR_HOME || join(homedir(), '.offerstar')): Paths {
  return {
    home,
    config: join(home, 'config.yaml'),
    env: join(home, '.env'),
    profile: join(home, 'profile'),
    db: join(home, 'offerstar.db'),
    applications: join(home, 'applications'),
    learnings: join(home, 'learnings.md'),
  };
}
