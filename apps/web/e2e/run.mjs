#!/usr/bin/env node
/**
 * End-to-end checks for the studio (spec §21 "tasks, not tours"). Drives the system Chrome through
 * playwright-core — nothing is downloaded — and asserts on application state (window.__orbital),
 * not pixels.
 *
 *   E2E_BASE=http://localhost:3100 npm run e2e            # all tests
 *   E2E_BASE=http://localhost:3100 npm run e2e -- stereo  # tests whose name matches "stereo"
 *
 * Needs the web app, the API (for naming verification) and, for the rooms test, the relay.
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const BASE = process.env.E2E_BASE ?? 'http://localhost:3100';
const CHROME = process.env.CHROME_PATH ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
const filter = process.argv[2] ? new RegExp(process.argv[2], 'i') : null;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Poll a state predicate inside the page. */
async function waitState(page, fn, arg, timeout = 20000) {
  await page.waitForFunction(fn, arg, { timeout, polling: 150 });
}

const state = (page) => page.evaluate(() => {
  const s = window.__orbital.getState();
  return {
    atoms: s.doc.atoms.length,
    bonds: s.doc.bonds.length,
    name: s.verification?.primary?.name ?? null,
    provenance: s.verification?.primary?.provenance ?? null,
    formula: s.analysis?.formula ? Object.entries(s.analysis.formula.counts).map(([k, v]) => k + (v > 1 ? v : '')).join('') : null,
    centres: s.analysis?.stereo.centres.map((c) => c.descriptor) ?? [],
    panel: s.panel,
    view: s.view,
    selection: s.selection,
  };
});

async function openStudio(page, { fresh = true } = {}) {
  if (fresh) {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(async () => {
      localStorage.clear();
      sessionStorage.clear();
      const dbs = (await indexedDB.databases?.()) ?? [];
      await Promise.all(dbs.map((d) => new Promise((r) => { const q = indexedDB.deleteDatabase(d.name); q.onsuccess = q.onerror = q.onblocked = r; })));
    });
  }
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__orbital && window.__orbitalActions, null, { timeout: 30000 });
}

async function resolve(page, query) {
  await page.evaluate((q) => window.__orbitalActions.resolveQuery(q), query);
}

async function waitVerified(page, timeout = 30000) {
  await waitState(page, () => {
    const s = window.__orbital.getState();
    return s.verification?.status === 'done' || s.verification?.status === 'offline';
  }, null, timeout);
}

// ---------------------------------------------------------------------------------------------

test('landing: first paint offers the four ways in', async (page) => {
  await openStudio(page);
  await page.waitForSelector('[data-testid=landing]');
  for (const id of ['action-type', 'action-build', 'action-draw', 'action-scan']) assert(await page.isVisible(`[data-testid=${id}]`), `${id} missing`);
  assert((await page.title()).includes('Orbital'), 'title');
});

test('name → structure: search box resolves and verifies a name', async (page) => {
  await openStudio(page);
  await page.click('[data-testid=action-type]');
  const input = page.locator('[data-testid=landing] input').first();
  await input.fill('2-methylbutan-2-ol');
  await input.press('Enter');
  await waitState(page, () => window.__orbital.getState().doc.atoms.length === 6);
  await waitVerified(page);
  const s = await state(page);
  assert(s.name === '2-methylbutan-2-ol', `name was ${s.name}`);
  assert(s.provenance === 'verified_systematic', `provenance ${s.provenance}`);
  assert(s.formula === 'C5H12O', `formula ${s.formula}`);
});

test('build: one carbon, Enter bonds a second → ethane', async (page) => {
  await openStudio(page);
  await page.click('[data-testid=action-build]');
  await waitState(page, () => window.__orbital.getState().doc.atoms.length === 1);
  await page.focus('[data-testid=canvas-area]');
  await page.keyboard.press('Enter');
  await waitState(page, () => window.__orbital.getState().doc.atoms.length === 2);
  await waitVerified(page);
  const s = await state(page);
  assert(s.name === 'ethane', `name ${s.name}`);
  assert(s.bonds === 1, 'one bond');
});

test('stereo: (R)-2-bromobutane mirrors to (S) and undo restores it', async (page) => {
  await openStudio(page);
  await resolve(page, '(R)-2-bromobutane');
  await waitVerified(page);
  let s = await state(page);
  assert(s.centres.includes('R'), `centres ${s.centres}`);
  assert(s.name === '(2R)-2-bromobutane' || s.name === '(R)-2-bromobutane', `name ${s.name}`);
  await page.evaluate(() => window.__orbital.getState().apply({ type: 'mirror' }, { label: 'Mirror' }));
  await waitState(page, () => window.__orbital.getState().analysis?.stereo.centres[0]?.descriptor === 'S');
  await page.evaluate(() => window.__orbital.getState().undo());
  await waitState(page, () => window.__orbital.getState().analysis?.stereo.centres[0]?.descriptor === 'R');
});

test('explain: the numbering step shows both directions for 2,3- vs 4,5-', async (page) => {
  await openStudio(page);
  await resolve(page, 'CC(C)C(C)CCC');
  await waitVerified(page);
  await page.evaluate(() => window.__orbital.setState({ panel: 'explain', explainStep: 2 }));
  await page.waitForSelector('text=/opposite end|lower|first point of difference/i', { timeout: 15000 });
});

test('practice: a stereo problem grades the right answer correct', async (page) => {
  await openStudio(page);
  const answer = await page.evaluate(async () => {
    const P = await window.__orbitalActions.practice();
    await P.loadProgress();
    await P.startProblem({ type: 'stereo', concept: 'rs', smiles: 'C[C@@H](Br)CC', source: 'set' });
    return P.usePractice.getState().problem?.answer?.[0];
  });
  assert(answer === 'R' || answer === 'S', `answer ${answer}`);
  await page.click(`[data-testid=choice-${answer}]`);
  await page.click('[data-testid=check-answer]');
  await page.waitForSelector('[data-testid=next-problem]');
  const verdict = await page.evaluate(() => window.__orbitalActions.practice().then((P) => P.usePractice.getState().feedback?.verdict));
  assert(verdict === 'correct', `verdict ${verdict}`);
});

test('conformations: Newman problem answer matches the dihedral', async (page) => {
  await openStudio(page);
  const r = await page.evaluate(async () => {
    const P = await window.__orbitalActions.practice();
    await P.loadProgress();
    await P.startProblem({ type: 'newman', concept: 'conformation', seed: 4242 });
    const p = P.usePractice.getState().problem;
    return { type: p?.type, dih: p?.dihedral, answer: p?.answer?.[0] };
  });
  assert(r.type === 'newman', `type ${r.type}`);
  const d = Math.abs((((r.dih + 540) % 360)) - 180);
  const expected = d > 150 ? 'anti' : d > 90 ? 'eclipsed' : d > 30 ? 'gauche' : 'syn';
  assert(r.answer === expected, `answer ${r.answer} for ${d}°`);
});

test('resonance: acetate has two equivalent contributors with arrows', async (page) => {
  await openStudio(page);
  await resolve(page, 'CC(=O)[O-]');
  await waitState(page, () => window.__orbital.getState().doc.atoms.length === 4);
  await page.evaluate(() => window.__orbital.setState({ panel: 'resonance', landing: false }));
  await page.waitForSelector('[data-testid=resonance-panel]');
  const text = await page.textContent('[data-testid=resonance-panel]');
  assert(/2 contributors, all equivalent/.test(text), text.slice(0, 120));
  assert((await page.locator('[data-testid=resonance-arrow]').count()) === 2, 'two arrows');
});

test('acidity: acetic acid O–H is the most acidic proton', async (page) => {
  await openStudio(page);
  await resolve(page, 'acetic acid');
  await page.evaluate(() => window.__orbital.setState({ panel: 'facts', landing: false }));
  await page.waitForSelector('[data-testid=acid-top]', { timeout: 20000 });
  const t = await page.textContent('[data-testid=acid-top]');
  assert(/carboxylic acid/.test(t) && /4\.8/.test(t), t);
});

test('keyboard + screen reader: arrows select atoms and are narrated', async (page) => {
  await openStudio(page);
  await resolve(page, 'butan-2-ol');
  await waitVerified(page);
  await page.evaluate(() => window.__orbital.setState({ view: '2d', landing: false }));
  await page.focus('[data-testid=canvas-area]');
  await page.keyboard.press('ArrowRight');
  await waitState(page, () => window.__orbital.getState().selection.atoms.length === 1);
  await page.waitForFunction(() => /Selected (carbon|oxygen), atom \d/.test(document.querySelector('[data-testid=narrator]')?.textContent ?? ''));
});

test('share: a shared link renders the molecule read-only', async (page) => {
  await openStudio(page);
  await resolve(page, 'caffeine');
  await waitVerified(page);
  const url = await page.evaluate(async () => {
    const S = await window.__orbitalActions.share();
    const r = await S.createShare();
    return r.url;
  }).catch((e) => String(e));
  assert(typeof url === 'string' && /\/s\//.test(url), `share url ${url}`);
  await page.goto(url.startsWith('http') ? url : BASE + url);
  await page.waitForSelector('text=/caffeine|trimethylpurine/i', { timeout: 20000 });
});

test('mobile: dock and three-height sheet, no sideways scroll', async (page) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openStudio(page);
  await resolve(page, 'caffeine');
  await page.evaluate(() => window.__orbital.setState({ landing: false }));
  await page.waitForSelector('[data-testid=bottom-sheet]');
  assert(await page.isVisible('[data-testid=mobile-dock]'), 'dock');
  assert(!(await page.isVisible('[data-testid=side-panel]')), 'side panel hidden');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert(overflow <= 0, `overflow ${overflow}px`);
  await page.click('[data-testid=sheet-handle]');
  await waitState(page, () => document.querySelector('[data-testid=bottom-sheet]')?.getAttribute('data-snap') === 'half');
});

test('guide: opens from the start screen, every Try it does its thing', async (page) => {
  await openStudio(page);
  await page.click('[data-testid=open-guide]');
  await page.waitForSelector('[data-testid=guide]');
  assert(new URL(page.url()).searchParams.has('guide'), 'guide is linkable (?guide)');
  const items = await page.$$eval('[data-testid^=guide-item-]', (els) => els.length);
  assert(items >= 20, `only ${items} guide items`);
  // Explain: loads the example and opens the explain panel.
  await page.click('[data-testid=guide-try-explain]');
  await waitState(page, () => !document.querySelector('[data-testid=guide]'));
  await waitState(page, () => window.__orbital.getState().panel === 'explain' && window.__orbital.getState().doc.atoms.length === 9);
  assert(!new URL(page.url()).searchParams.has('guide'), 'closing drops ?guide');
  // Reopen from the top bar; the chair example lands in the projection lab.
  await page.click('[data-testid=topbar-guide]');
  await page.click('[data-testid=guide-try-projections]');
  await waitState(page, () => window.__orbital.getState().panel === 'projection' && window.__orbital.getState().doc.atoms.length === 6);
  // Conformer mode on butane.
  await page.click('[data-testid=topbar-guide]');
  await page.click('[data-testid=guide-try-toolbar]');
  await waitState(page, () => window.__orbital.getState().mode3d === 'conformer' && window.__orbital.getState().doc.atoms.length === 4);
  // Panels without a molecule change: practice and rooms.
  for (const [id, panel] of [['problems', 'practice'], ['room', 'room'], ['settings', 'settings']]) {
    await page.click('[data-testid=topbar-guide]');
    await page.click(`[data-testid=guide-try-${id}]`);
    await waitState(page, (p) => window.__orbital.getState().panel === p, panel);
  }
  // A /guide link opens straight into it, and Escape closes it.
  await page.goto(BASE + '/guide');
  await page.waitForSelector('[data-testid=guide]');
  await page.keyboard.press('Escape');
  await waitState(page, () => !document.querySelector('[data-testid=guide]'));
});

test('tour: completes step by step', async (page) => {
  await openStudio(page);
  await page.click('[data-testid=start-tour]');
  await page.waitForSelector('[data-testid=tour-card]');
  await page.waitForSelector('[data-testid=canvas-2d] svg');
  await page.waitForTimeout(400);
  const box = await page.locator('[data-testid=canvas-2d]').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForSelector('text=Draw a bond').catch(async (e) => {
    const dbg = await page.evaluate(() => ({ atoms: window.__orbital.getState().doc.atoms.length, view: window.__orbital.getState().view, tool: window.__orbital.getState().tool2d, landing: window.__orbital.getState().landing, card: document.querySelector('[data-testid=tour-card]')?.textContent?.slice(0, 60) }));
    throw new Error(`${e.message.split('\n')[0]} ${JSON.stringify(dbg)} box=${JSON.stringify(box)}`);
  });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 - 40, { steps: 6 });
  await page.mouse.up();
  await page.waitForSelector('text=Toggle 3D');
  await page.click('[data-tour=view-3d]');
  await page.waitForSelector('text=Name it');
  await page.click('[data-tour=panel-explain]');
  await page.waitForSelector('[data-testid=tour-done]');
});

test('rooms: a second student joins and sees the molecule and chat', async (page) => {
  await openStudio(page);
  await resolve(page, 'benzene');
  await waitState(page, () => window.__orbital.getState().doc.atoms.length === 6);
  const roomId = `e2e-${Date.now().toString(36)}`;
  await page.evaluate(() => window.__orbital.setState({ panel: 'room', landing: false }));
  await page.fill('[data-testid=room-code]', roomId);
  await page.click('[data-testid=room-panel] button[type=submit]');
  await page.waitForSelector('[data-testid=room-status]:has-text("connected")', { timeout: 15000 });
  const other = await page.context().browser().newContext({ viewport: { width: 1200, height: 800 } });
  const p2 = await other.newPage();
  try {
    await p2.goto(`${BASE}/?room=${roomId}`);
    await p2.waitForFunction(() => window.__orbital?.getState().doc.atoms.length === 6, null, { timeout: 20000 });
    await p2.fill('[data-testid=room-input]', 'hello from the second browser');
    await p2.press('[data-testid=room-input]', 'Enter');
    await page.waitForSelector('[data-testid=room-chat] >> text=hello from the second browser', { timeout: 10000 });
    await page.waitForSelector('[data-testid=room-peers] li:nth-child(2)', { timeout: 10000 });
  } finally {
    await other.close();
  }
});

test('metrics: dashboard loads headline numbers', async (page) => {
  await page.goto(BASE + '/metrics');
  await page.waitForSelector('text=Median time to first molecule', { timeout: 20000 });
  assert(await page.isVisible('text=Where sessions get to'), 'funnel');
});

// ---------------------------------------------------------------------------------------------

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
let failed = 0;
const selected = tests.filter((t) => !filter || filter.test(t.name));
for (const t of selected) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const t0 = Date.now();
  try {
    await t.fn(page);
    if (errors.length) throw new Error(`uncaught page error: ${errors[0]}`);
    console.log(`  ✓ ${t.name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${t.name}\n      ${String(e.message ?? e).split('\n')[0]}`);
  } finally {
    await context.close();
  }
}
await browser.close();
console.log(`\n${selected.length - failed}/${selected.length} passed`);
process.exit(failed ? 1 : 0);
