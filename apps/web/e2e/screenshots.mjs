/**
 * Screenshot tour of the main screens at 1440×900 @2x (and one phone), rendered with the GPU.
 * Run against a production build with the API and rooms relay up:
 *
 *   npx next build && npx next start -p 3101 &
 *   node e2e/screenshots.mjs ~/Desktop/orbital            # all scenes
 *   node e2e/screenshots.mjs ~/Desktop/orbital '' 'chair' # scenes matching a pattern
 *
 * The scan scene reads e2e/fixtures/ibuprofen.png (and needs the tutor key for recognition).
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:3101';
const OUT = process.argv[2];
const IMG = process.argv[3] || new URL('./fixtures/ibuprofen.png', import.meta.url).pathname;
const only = process.argv[4] ? new RegExp(process.argv[4]) : null;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});

async function fresh({ width = 1440, height = 900, scale = 2, theme = 'dark' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, colorScheme: theme });
  const page = await ctx.newPage();
  await page.goto(BASE + '/');
  await page.waitForFunction(() => window.__orbitalActions, null, { timeout: 30000 });
  // Skip first-run coaching so every scene shows the studio itself.
  await page.evaluate(() => window.__orbital.getState().setSettings({ tourSeen: true }));
  return { ctx, page };
}
const S = (page, patch) => page.evaluate((p) => window.__orbital.setState(p), patch);
async function load(page, q) {
  await page.evaluate((x) => window.__orbitalActions.resolveQuery(x), q);
  await page.waitForFunction(() => window.__orbital.getState().verification?.status === 'done' && window.__orbital.getState().doc.conformers.length > 0, null, { timeout: 30000 });
  await page.evaluate(() => window.__orbital.getState().clearSelection?.());
  await page.waitForTimeout(1200);
}
async function shot(page, name) {
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('  ✓', name);
}

const scenes = {
  async '01-landing'() {
    const { ctx, page } = await fresh();
    await page.evaluate(async () => {
      localStorage.clear();
      const dbs = (await indexedDB.databases?.()) ?? [];
      await Promise.all(dbs.map((d) => new Promise((r) => { const q = indexedDB.deleteDatabase(d.name); q.onsuccess = q.onerror = q.onblocked = r; })));
    });
    await page.goto(BASE + '/');
    await page.waitForSelector('[data-testid=landing]');
    await page.waitForTimeout(3500);
    await shot(page, '01-landing');
    await ctx.close();
  },
  async '01b-guide'() {
    const { ctx, page } = await fresh();
    await page.goto(BASE + '/?guide');
    await page.waitForSelector('[data-testid=guide]');
    await page.waitForTimeout(600);
    await shot(page, '01b-guide');
    await ctx.close();
  },
  async '02-first-build'() {
    const { ctx, page } = await fresh();
    await page.evaluate(async () => { localStorage.clear(); });
    await page.goto(BASE + '/');
    await page.waitForFunction(() => window.__orbitalActions);
    await page.evaluate(() => window.__orbital.getState().setSettings({ tourSeen: false }));
    await page.click('[data-testid=action-build]');
    await page.waitForFunction(() => window.__orbital.getState().doc.atoms.length === 1);
    await page.focus('[data-testid=canvas-area]');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__orbital.getState().verification?.status === 'done');
    await page.waitForSelector('[data-testid=coach-success]');
    await page.waitForTimeout(1500);
    await shot(page, '02-first-build');
    await ctx.close();
  },
  async '03-name-to-3d'() {
    const { ctx, page } = await fresh();
    await load(page, '2-methylbutan-2-ol');
    await S(page, { panel: 'facts' });
    await shot(page, '03-name-to-3d');
    await ctx.close();
  },
  async '04-split-view'() {
    const { ctx, page } = await fresh();
    await load(page, '3-ethyl-2-methylhexane');
    await S(page, { view: 'split', panel: 'explain', explainStep: 2 });
    await page.waitForTimeout(2500);
    await shot(page, '04-split-view-numbering');
    await ctx.close();
  },
  async '05-why-not-this-chain'() {
    const { ctx, page } = await fresh();
    await load(page, '3-ethyl-2-methylhexane');
    await S(page, { view: 'split', panel: 'explain', explainStep: 1 });
    await page.waitForSelector('[data-testid=parent-alternatives] button');
    await page.click('[data-testid=parent-alternatives] button >> nth=0');
    await page.waitForSelector('[data-testid=parent-comparison]');
    await page.waitForTimeout(1500);
    await shot(page, '05-why-not-this-chain');
    await ctx.close();
  },
  async '06-numbering-other-end'() {
    const { ctx, page } = await fresh();
    await load(page, '3-ethyl-2-methylhexane');
    await S(page, { panel: 'explain', explainStep: 2 });
    await page.click('[data-testid=why-not-other-end]');
    await page.waitForTimeout(2200);
    await shot(page, '06-numbering-other-end');
    await ctx.close();
  },
  async '07-measure'() {
    const { ctx, page } = await fresh();
    await load(page, '2-methylbutan-2-ol');
    await page.evaluate(() => {
      const s = window.__orbital.getState();
      const d = s.doc;
      const deg = (id) => d.bonds.filter((b) => b.a1 === id || b.a2 === id).length;
      const centre = d.atoms.find((a) => a.element === 'C' && deg(a.id) === 4);
      const nb = d.bonds.filter((b) => b.a1 === centre.id || b.a2 === centre.id).map((b) => (b.a1 === centre.id ? b.a2 : b.a1));
      const o = nb.find((id) => d.atoms.find((a) => a.id === id).element === 'O');
      const c = nb.find((id) => d.atoms.find((a) => a.id === id).element === 'C');
      window.__orbital.setState({ mode3d: 'measure', measure: [c, centre.id, o], panel: 'facts' });
    });
    await shot(page, '07-measure-angle');
    await ctx.close();
  },
  async '08-conformers'() {
    const { ctx, page } = await fresh();
    await load(page, 'butane');
    await page.evaluate(() => {
      const d = window.__orbital.getState().doc;
      const deg = (id) => d.bonds.filter((b) => b.a1 === id || b.a2 === id).length;
      const mid = d.bonds.find((b) => deg(b.a1) === 2 && deg(b.a2) === 2);
      window.__orbital.setState({ mode3d: 'conformer', activeBond: mid.id, panel: 'facts' });
    });
    await page.waitForSelector('[data-testid=inspector] >> text=Energy vs dihedral');
    await page.waitForTimeout(2500);
    await page.click('[data-testid=conformer-search]').catch(() => {});
    await page.waitForSelector('[data-testid=conformer-strip]', { timeout: 15000 }).catch(() => {});
    await shot(page, '08-conformer-newman-energy');
    await ctx.close();
  },
  async '09-chair'() {
    const { ctx, page } = await fresh();
    await load(page, 'methylcyclohexane');
    await S(page, { panel: 'projection' });
    await page.click('[data-testid=projection-lab] button:has-text("Chair")');
    await page.waitForSelector('[data-testid=chair-svg]');
    await page.waitForTimeout(2000);
    await shot(page, '09-chair');
    await ctx.close();
  },
  async '10-fischer'() {
    const { ctx, page } = await fresh();
    await load(page, '(R)-2-bromobutane');
    await S(page, { panel: 'projection' });
    await page.click('[data-testid=projection-lab] button:has-text("Wedge")');
    await page.waitForSelector('[data-testid=fischer-svg]');
    await shot(page, '10-wedge-and-fischer');
    await ctx.close();
  },
  async '11-practice'() {
    const { ctx, page } = await fresh();
    await S(page, { panel: 'practice', landing: false });
    await page.evaluate(async () => {
      const P = await window.__orbitalActions.practice();
      await P.loadProgress();
      await P.startProblem({ type: 'name', smiles: 'CCCC(CC)C(C)C' });
    });
    await page.waitForTimeout(2500);
    await page.fill('[data-testid=practice-panel] input', '2-methyl-3-ethylhexane').catch(() => {});
    await page.evaluate(async () => { const P = await window.__orbitalActions.practice(); await P.checkAnswer('2-methyl-3-ethylhexane'); });
    await page.waitForSelector('[data-testid=feedback]');
    await shot(page, '11-practice-feedback');
    await ctx.close();
  },
  async '12-tutor'() {
    const { ctx, page } = await fresh();
    await load(page, '(R)-butan-2-ol');
    await S(page, { panel: 'tutor' });
    await page.click('[data-testid=tutor-suggestion] >> text=Why is this R and not S?');
    await page.waitForFunction(() => !document.querySelector('[data-testid=tutor-panel]')?.textContent?.includes('Looking at the molecule') && document.querySelectorAll('[data-testid=tutor-reply]').length > 0, null, { timeout: 120000 });
    await page.waitForTimeout(8000);
    await shot(page, '12-tutor');
    await ctx.close();
  },
  async '13-orbitals'() {
    const { ctx, page } = await fresh();
    await load(page, 'formaldehyde');
    await S(page, { panel: 'orbitals' });
    await page.click('[data-testid=orb-compute]');
    await page.waitForSelector('[data-testid=orb-levels]', { timeout: 60000 });
    await page.waitForTimeout(2500);
    await shot(page, '13-orbitals-homo');
    await page.click('[data-testid=orbitals-panel] button:has-text("ESP")');
    await page.waitForTimeout(3500);
    await shot(page, '14-electrostatic-potential');
    await ctx.close();
  },
  async '15-mechanism'() {
    const { ctx, page } = await fresh();
    await load(page, '(R)-2-bromobutane');
    await S(page, { panel: 'mechanism' });
    await page.click('[data-testid=mechanism-list] button >> nth=0');
    await page.waitForSelector('[data-testid=mechanism-player]');
    await page.waitForTimeout(2000);
    await shot(page, '15-mechanism-sn2');
    await ctx.close();
  },
  async '16-scan'() {
    if (!IMG) return;
    const { ctx, page } = await fresh();
    await load(page, 'ethanol');
    await page.goto(BASE + '/?scan=1');
    await page.waitForSelector('input[type=file]', { state: 'attached' });
    await page.setInputFiles('input[type=file]', IMG);
    await page.click('button:has-text("Recognize")');
    await page.waitForSelector('[data-testid=scan-status]', { timeout: 180000 });
    await page.waitForTimeout(1500);
    await shot(page, '16-scan-a-structure');
    await ctx.close();
  },
  async '17-compare'() {
    const { ctx, page } = await fresh();
    await load(page, '2,3-dibromobutane');
    await S(page, { panel: 'library' });
    await page.click('button:has-text("Compare Isomers")');
    await page.click('button:has-text("C[C@@H](Br)[C@@H](C)Br vs")');
    await page.waitForSelector('[data-testid=compare-result]', { timeout: 30000 });
    await page.waitForTimeout(1500);
    await shot(page, '17-compare-isomers');
    await ctx.close();
  },
  async '18-light'() {
    const { ctx, page } = await fresh({ theme: 'light' });
    await page.evaluate(() => window.__orbital.getState().setSettings({ theme: 'light' }));
    await load(page, 'caffeine');
    await S(page, { view: 'split', panel: 'facts' });
    await page.waitForTimeout(2500);
    await shot(page, '18-light-theme-split');
    await ctx.close();
  },
  async '19-phone'() {
    const { ctx, page } = await fresh({ width: 390, height: 844, scale: 3 });
    await load(page, 'caffeine');
    await page.waitForTimeout(2000);
    await shot(page, '19-phone');
    await ctx.close();
  },
  async '20-share'() {
    const { ctx, page } = await fresh();
    await load(page, 'caffeine');
    await page.click('[aria-label="Share, export or view in AR"]');
    await page.waitForSelector('[data-testid=share-pane]', { timeout: 20000 });
    await page.waitForTimeout(1500);
    await shot(page, '20-share-link-and-qr');
    await ctx.close();
  },
  async '21-room'() {
    const { ctx, page } = await fresh();
    await load(page, 'benzene');
    await S(page, { panel: 'room' });
    const room = `demo-${Date.now().toString(36)}`;
    await page.fill('[data-testid=room-code]', room);
    await page.click('[data-testid=room-panel] button[type=submit]');
    await page.waitForSelector('[data-testid=room-status]:has-text("connected")', { timeout: 15000 });
    const other = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const p2 = await other.newPage();
    await p2.goto(`${BASE}/?room=${room}`);
    await p2.waitForFunction(() => window.__orbital?.getState().doc.atoms.length === 6, null, { timeout: 20000 });
    await p2.fill('[data-testid=room-input]', 'Why are all the C–C bonds the same length?');
    await p2.press('[data-testid=room-input]', 'Enter');
    await page.waitForSelector('[data-testid=room-chat] >> text=same length', { timeout: 10000 });
    await page.fill('[data-testid=room-input]', 'Resonance — each bond is between single and double');
    await page.press('[data-testid=room-input]', 'Enter');
    await page.waitForTimeout(1500);
    await shot(page, '21-study-room');
    await other.close();
    await ctx.close();
  },
  async '22-metrics'() {
    const { ctx, page } = await fresh();
    await page.goto(BASE + '/metrics');
    await page.waitForSelector('text=Median time to first molecule');
    await page.waitForTimeout(1200);
    await shot(page, '22-metrics');
    await ctx.close();
  },
};

for (const [name, fn] of Object.entries(scenes)) {
  if (only && !only.test(name)) continue;
  try {
    await fn();
  } catch (e) {
    console.log('  ✗', name, String(e.message ?? e).split('\n')[0]);
  }
}
await browser.close();
