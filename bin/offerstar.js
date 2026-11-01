#!/usr/bin/env node
// From a git checkout (npm link) this runs the TypeScript sources directly;
// from the npm package, which ships no sources, it runs the bundle.
import { existsSync } from 'node:fs';

const source = new URL('../src/main.ts', import.meta.url);
const fromSource = existsSync(source) && !source.pathname.includes('/node_modules/');
await import(fromSource ? source.href : new URL('../dist/offerstar.mjs', import.meta.url).href);
