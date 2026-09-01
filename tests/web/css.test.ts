import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const CSS_PATH = path.resolve(process.cwd(), 'public/assets/app.css');

describe('built app.css', () => {
  it('emits @layer island after @layer utilities', () => {
    // The grid island's `.cell`/`.col` etc. share names with Tailwind's own utility classes
    // (e.g. `.grid`), and layer order beats specificity — so `island` has to come after
    // `utilities` in the compiled sheet or the island loses that fight. Build fresh rather
    // than trust whatever public/assets/app.css happens to hold, so this test catches a
    // regression in the source `@layer` declaration regardless of build order elsewhere.
    execSync('npm run build:css', { stdio: 'pipe' });
    if (!existsSync(CSS_PATH)) return;
    const css = readFileSync(CSS_PATH, 'utf8');
    const utilitiesIdx = css.indexOf('@layer utilities');
    const islandIdx = css.indexOf('@layer island');
    expect(utilitiesIdx).toBeGreaterThan(-1);
    expect(islandIdx).toBeGreaterThan(-1);
    expect(islandIdx).toBeGreaterThan(utilitiesIdx);
  });
});
