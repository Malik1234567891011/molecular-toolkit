'use client';
import { useMemo, useState } from 'react';
import {
  CipRanker, MolView, acidSites, angleDeg, element, explainAngle, isRotatable, perceiveRings, prettyFormula, v3,
  type AtomId, type BondId, type StereoNeighbour, type Vec3,
} from '@orbital/chem';
import { useStudio, studio } from '@/lib/store';
import { cycleBondOrder, setBondOrder, setElement } from '@/lib/edit';
import { computeScan, currentDihedral, rotateBond } from '@/lib/conformer';
import { scheduleAnalysis } from '@/lib/pipeline';
import { I } from '../ui/icons';
import { Newman, conformationName } from './Newman';
import { EnergyCurve } from './EnergyCurve';
import { ProvenanceBadge } from '../naming/ProvenanceBadge';

function Row({ k, v, mono, title }: { k: string; v: React.ReactNode; mono?: boolean; title?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px] text-[13px]" title={title}>
      <span className="text-text-2">{k}</span>
      <span className={`text-right ${mono ? 'mono' : ''}`}>{v}</span>
    </div>
  );
}

export function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="border-b border-border px-4 py-3">
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-3">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

function coords() {
  const d = studio().doc;
  return (d.conformers.find((c) => c.id === d.selectedConformerId) ?? d.conformers[0])?.coordinates ?? {};
}

// ---------------------------------------------------------------------------------------------

function InvalidCard() {
  const invalid = useStudio((s) => s.invalid);
  if (!invalid) return null;
  return (
    <div className="fade-up m-3 rounded-2xl border border-danger/40 bg-danger-soft p-3" role="alert" data-testid="invalid-card">
      <div className="flex items-start gap-2">
        <I.Alert size={18} className="mt-0.5 shrink-0 text-danger" />
        <div className="min-w-0">
          <div className="text-[14px] font-semibold">{invalid.title}</div>
          <p className="mt-1 text-[13px] leading-relaxed text-text-2">{invalid.message}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {invalid.fixes.map((f) => (
              <button key={f.label} onClick={() => { f.run(); useStudio.setState({ invalid: null }); }} className="rounded-lg border border-border-strong bg-panel-solid px-2 py-1 text-[12px] font-medium hover:border-accent">
                {f.label}
              </button>
            ))}
            <button onClick={() => useStudio.setState({ invalid: null })} className="rounded-lg px-2 py-1 text-[12px] text-text-2 hover:text-text">
              Dismiss
            </button>
          </div>
          <p className="mt-2 text-[11px] text-text-3">Nothing was changed; your undo history is intact.</p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

/** Most acidic proton: textbook pKa classes with the conjugate-base reason (spec §14). */
function AcidityCard() {
  const doc = useStudio((s) => s.doc);
  const setHighlight = useStudio((s) => s.setHighlight);
  const [more, setMore] = useState(false);
  const sites = useMemo(() => {
    // One entry per kind: the list reads as a ranking, not an atom dump.
    const seen = new Set<string>();
    return acidSites(doc).filter((x) => (seen.has(x.kind) ? false : (seen.add(x.kind), true)));
  }, [doc]);
  if (!sites.length) return null;
  const hl = (atomId: AtomId) => {
    const hs = Object.keys(coords()).filter((k) => k.startsWith(`${atomId}.h`));
    setHighlight('acid', { id: 'acid', atoms: [atomId, ...hs], bonds: [], tone: 'accent', label: 'acidic H' });
  };
  const top = sites[0];
  const atomsOf = (kind: string) => acidSites(doc).filter((x) => x.kind === kind).map((x) => x.atomId);
  return (
    <Section title="Most acidic proton" right={<span className="text-[11px] text-text-3" title="Approximate aqueous pKa from textbook tables — a teaching estimate, not a prediction">≈ pKa</span>}>
      <button
        className="w-full rounded-xl border border-border bg-panel-raised px-3 py-2 text-left hover:border-accent"
        onMouseEnter={() => hl(top.atomId)}
        onMouseLeave={() => setHighlight('acid', null)}
        onFocus={() => hl(top.atomId)}
        onBlur={() => setHighlight('acid', null)}
        onClick={() => studio().select(atomsOf(top.kind))}
        data-testid="acid-top"
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[13.5px] font-semibold">{/(^|[\s-])H\b|–H$|^hydrogen/.test(top.kind) ? top.kind.replace(/^[a-z]/, (c) => c.toUpperCase()) : `${top.element}–H of the ${top.kind}`}</span>
          <span className="mono text-[15px] font-semibold text-accent">{top.pKa < 0 ? '−' + Math.abs(top.pKa) : top.pKa}</span>
        </div>
        <p className="mt-0.5 text-[12.5px] leading-snug text-text-2">{top.reason}</p>
      </button>
      {sites.length > 1 && (
        <>
          <button className="mt-1.5 text-[11.5px] text-text-3 hover:text-text" onClick={() => setMore((x) => !x)} aria-expanded={more}>
            {more ? 'Hide ranking' : `Compare ${sites.length - 1} other H${sites.length > 2 ? ' types' : ' type'}`}
          </button>
          {more && (
            <ol className="mt-1 space-y-0.5">
              {sites.slice(1).map((x) => (
                <li key={x.kind}>
                  <button className="flex w-full items-baseline justify-between gap-2 rounded-md px-1 py-0.5 text-left text-[12.5px] hover:bg-panel-raised" onMouseEnter={() => hl(x.atomId)} onMouseLeave={() => setHighlight('acid', null)} onClick={() => studio().select(atomsOf(x.kind))} title={x.reason}>
                    <span className="text-text-2">{x.kind}</span>
                    <span className="mono">{x.pKa}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </Section>
  );
}

function FactsCard() {
  const a = useStudio((s) => s.analysis);
  const doc = useStudio((s) => s.doc);
  const verification = useStudio((s) => s.verification);
  const geometry = useStudio((s) => s.geometry);
  const setHighlight = useStudio((s) => s.setHighlight);
  const [adv, setAdv] = useState(false);
  if (!doc.atoms.length) return <p className="p-4 text-[13px] text-text-2">Try typing <b>caffeine</b>, or draw a hexagon.</p>;
  if (!a) return <div className="p-4 text-[13px] text-text-3">Analysing…</div>;
  const f = a.formula;
  const d = a.identifiers?.descriptors;
  const centres = a.stereo.centres.filter((c) => !c.needsHigherRules);
  const unspecified = centres.filter((c) => !c.specified).length + a.stereo.bonds.filter((b) => !b.specified).length;
  const conf = doc.conformers.find((c) => c.id === doc.selectedConformerId) ?? doc.conformers[0];
  return (
    <>
      <Section title="Molecular facts">
        <div className="mb-1 text-[22px] font-semibold tracking-tight" data-testid="formula">{prettyFormula(f.counts, f.charge)}</div>
        <Row k="Molar mass" v={`${f.molarMass.toFixed(2)} g/mol`} mono />
        <Row k="Exact mass" v={`${f.exactMass.toFixed(4)} Da`} mono />
        <Row k="Formal charge" v={f.charge > 0 ? `+${f.charge}` : String(f.charge)} mono />
        <Row k="Degree of unsaturation" v={f.degreeOfUnsaturation} mono title="Rings + π bonds, counted on the graph" />
        {d && (
          <>
            <Row k="H-bond donors / acceptors" v={`${d.hbd} / ${d.hba}`} mono />
            <Row k="logP (Crippen)" v={d.logP.toFixed(2)} mono />
            <Row k="TPSA" v={`${d.tpsa.toFixed(1)} Å²`} mono />
            <Row k="Rotatable bonds" v={d.rotatableBonds} mono />
          </>
        )}
        <Row
          k="Stereo"
          v={
            centres.length || a.stereo.bonds.length ? (
              <span>
                {centres.length} centre{centres.length === 1 ? '' : 's'}
                {a.stereo.bonds.length ? `, ${a.stereo.bonds.length} E/Z bond${a.stereo.bonds.length > 1 ? 's' : ''}` : ''}
                {unspecified ? <span className="ml-1 text-amber">· {unspecified} not specified</span> : null}
              </span>
            ) : (
              'none'
            )
          }
        />
      </Section>
      {a.groupSummary.length > 0 && (
        <Section title="Functional groups">
          <div className="flex flex-wrap gap-1.5">
            {a.groupSummary.map((g) => {
              const atoms = a.groups.filter((x) => (x.kind as string) === g.kind).flatMap((x) => x.atomIds);
              return (
                <button
                  key={g.kind + g.label}
                  onMouseEnter={() => setHighlight('fg', { id: 'fg', atoms, bonds: [], tone: 'amber' })}
                  onMouseLeave={() => setHighlight('fg', null)}
                  onClick={() => studio().select(atoms.filter((x) => !x.includes('.')))}
                  className="rounded-full border border-border bg-panel-raised px-2.5 py-1 text-[12px] hover:border-amber"
                >
                  {g.label}
                  {g.count > 1 ? ` ×${g.count}` : ''}
                </button>
              );
            })}
          </div>
        </Section>
      )}
      <AcidityCard />
      <Section title="Validation">
        {a.validation.filter((v) => v.code !== 'unspecified-stereo').length === 0 && <div className="flex items-center gap-1.5 text-[13px] text-good"><I.Check size={15} /> Valid structure</div>}
        <ul className="space-y-2">
          {a.validation.map((v) => (
            <li key={v.code + v.atomIds.join()} className="text-[12.5px] leading-snug" onMouseEnter={() => setHighlight('val', { id: 'val', atoms: v.atomIds, bonds: v.bondIds ?? [], tone: v.severity === 'error' ? 'danger' : 'amber' })} onMouseLeave={() => setHighlight('val', null)}>
              <div className={`font-medium ${v.severity === 'error' ? 'text-danger' : v.severity === 'warning' ? 'text-amber' : 'text-text'}`}>{v.title}</div>
              <div className="text-text-2">{v.message}</div>
              {v.fixes.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {v.fixes.map((fx) => (
                    <button key={fx.label} onClick={() => studio().apply(fx.command)} className="rounded-md border border-border-strong px-1.5 py-0.5 text-[11.5px] hover:border-accent">
                      {fx.label}
                    </button>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      </Section>
      <Section title="3D model">
        <Row k="Geometry" v={geometry === 'relaxing' ? 'relaxing…' : geometry === 'idealized' ? 'idealized (relaxing soon)' : geometry === 'failed' ? 'failed' : 'optimized'} />
        {conf && <p className="mt-1 text-[11.5px] leading-snug text-text-3">{conf.method}{conf.converged === false ? ' · not converged' : ''}. Model geometry, gas phase — not an experimental structure.</p>}
      </Section>
      <Section title="Identifiers" right={<button className="text-[11px] text-text-3 hover:text-text" onClick={() => setAdv((x) => !x)}>{adv ? 'hide' : 'advanced'}</button>}>
        {adv ? (
          <div className="space-y-1.5 text-[11.5px]">
            {(['canonicalSmiles', 'inchi', 'inchiKey'] as const).map((k) => (
              <div key={k}>
                <div className="text-text-3">{k === 'canonicalSmiles' ? 'Canonical SMILES' : k === 'inchi' ? 'InChI' : 'InChIKey'}</div>
                <button className="mono w-full break-all rounded bg-panel-raised p-1 text-left hover:bg-accent-soft" title="Copy" onClick={() => navigator.clipboard?.writeText(a.identifiers?.[k] ?? '')}>
                  {a.identifiers?.[k] ?? '—'}
                </button>
              </div>
            ))}
            <div className="pt-1 text-text-3">Engines: RDKit.js {a.engine.rdkit} · {a.engine.naming}{verification?.database?.cid ? ` · PubChem CID ${verification.database.cid}` : ''}</div>
          </div>
        ) : (
          <div className="mono truncate text-[12px] text-text-2">{a.identifiers?.inchiKey ?? '—'}</div>
        )}
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------------------------

function AtomInspector({ id }: { id: AtomId }) {
  const doc = useStudio((s) => s.doc);
  const a = useStudio((s) => s.analysis);
  const atom = doc.atoms.find((x) => x.id === id);
  const view = useMemo(() => new MolView(doc), [doc]);
  if (!atom) return null;
  const i = view.idx(id);
  const g = a?.geometry[id];
  const el = element(atom.element);
  const centre = a?.stereo.centres.find((c) => c.atomId === id);
  const c = coords();
  const nbrKeys = [...view.nbrs[i].map((j) => doc.atoms[j].id), ...Array.from({ length: view.implicitH(i) }, (_, k) => `${id}.h${k + 1}`)];
  const angles: Array<{ a: string; b: string; v: number }> = [];
  if (c[id]) {
    for (let x = 0; x < nbrKeys.length; x++) for (let y = x + 1; y < nbrKeys.length; y++) {
      const p = c[nbrKeys[x]];
      const q = c[nbrKeys[y]];
      if (p && q) angles.push({ a: nbrKeys[x], b: nbrKeys[y], v: angleDeg(p as Vec3, c[id] as Vec3, q as Vec3) });
    }
  }
  const label = (k: string) => (k.includes('.h') ? 'H' : doc.atoms.find((x) => x.id === k)?.element ?? '?');
  const ringSize = perceiveRings(view).smallestRing(i);
  const avg = angles.length ? angles.reduce((s, x) => s + x.v, 0) / angles.length : null;
  const why = avg !== null && g?.idealAngle ? explainAngle(doc, id, avg, ringSize) : [];
  const cip = centre && centre.specified ? explainCip(doc, id, centre.priorities) : null;
  const narration = `Selected ${el.name}, atom ${id.slice(1)}, ${view.nbrs[i].length} bonds, formal charge ${atom.formalCharge}`;
  return (
    <>
      <div className="sr-only" aria-live="polite">{narration}</div>
      <Section title="Atom">
        <div className="flex items-center gap-3">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-panel-raised text-[20px] font-bold">{atom.element}</div>
          <div>
            <div className="text-[15px] font-semibold capitalize">{el.name}{atom.formalCharge ? ` (${atom.formalCharge > 0 ? '+' : ''}${atom.formalCharge})` : ''}</div>
            <div className="text-[12px] text-text-2">
              {g?.hybridization} · {g?.molecularGeometry}
              {g?.lonePairs ? ` · ${g.lonePairs} lone pair${g.lonePairs > 1 ? 's' : ''}` : ''}
            </div>
          </div>
        </div>
        <div className="mt-2">
          <Row k="Bonded neighbours" v={view.nbrs[i].length} mono />
          <Row k="Implicit hydrogens" v={view.implicitH(i)} mono />
          {g?.idealAngle && <Row k="Idealized angle (VSEPR)" v={`${g.idealAngle}°`} mono />}
          {avg !== null && <Row k="Model angles (avg)" v={`${avg.toFixed(1)}°`} mono />}
        </div>
        {g && (
          <p className="mt-2 text-[12px] leading-snug text-text-2">
            {g.hybridization === 'sp2' && 'sp² — three electron domains around this atom (a π bond or a conjugated lone pair uses the remaining p orbital), so it is trigonal planar.'}
            {g.hybridization === 'sp3' && `sp³ — four electron domains (${g.sigma} bonds${g.lonePairs ? ` + ${g.lonePairs} lone pair${g.lonePairs > 1 ? 's' : ''}` : ''}) point to the corners of a tetrahedron.`}
            {g.hybridization === 'sp' && 'sp — two electron domains (two π bonds remain), so the atom is linear.'}
          </p>
        )}
        <div className="mt-2 flex flex-wrap gap-1">
          {['C', 'N', 'O', 'S', 'F', 'Cl', 'Br'].filter((e) => e !== atom.element).map((e) => (
            <button key={e} onClick={() => setElement(id, e)} className="rounded-md border border-border px-2 py-0.5 text-[12px] hover:border-accent">
              {e}
            </button>
          ))}
          <button onClick={() => studio().apply({ type: 'setCharge', atomId: id, charge: atom.formalCharge + 1 })} className="rounded-md border border-border px-2 py-0.5 text-[12px] hover:border-accent" title="Increase formal charge">+</button>
          <button onClick={() => studio().apply({ type: 'setCharge', atomId: id, charge: atom.formalCharge - 1 })} className="rounded-md border border-border px-2 py-0.5 text-[12px] hover:border-accent" title="Decrease formal charge">−</button>
          <button onClick={() => studio().apply({ type: 'removeAtoms', atomIds: [id] }, { select: 'none' })} className="ml-auto rounded-md px-2 py-0.5 text-[12px] text-danger hover:bg-danger-soft">Delete</button>
        </div>
      </Section>
      {centre && !centre.needsHigherRules && (
        <Section title="Stereocentre">
          <div className="flex items-center justify-between">
            <span className="text-[13px]">
              {centre.specified && centre.descriptor ? (
                <>Configuration <b className="italic">{centre.descriptor}</b></>
              ) : (
                <span className="text-amber">Stereochemistry not specified</span>
              )}
            </span>
            <div className="flex gap-1">
              {(['R', 'S'] as const).map((d) => (
                <button key={d} onClick={() => studio().apply({ type: 'setDescriptor', atomId: id, descriptor: d })} className={`rounded-md px-2.5 py-0.5 text-[12px] font-semibold italic ${centre.descriptor === d && centre.specified ? 'bg-accent text-accent-ink' : 'border border-border hover:border-accent'}`}>
                  {d}
                </button>
              ))}
              {centre.specified && (
                <button onClick={() => studio().apply({ type: 'setDescriptor', atomId: id, descriptor: null })} className="rounded-md border border-border px-2 py-0.5 text-[12px] hover:border-accent" title="Leave unspecified">?</button>
              )}
            </div>
          </div>
          {cip && (
            <ol className="mt-2 space-y-1 text-[12px]">
              {cip.map((p) => (
                <li key={p.rank} className="flex items-start gap-2">
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10.5px] font-bold text-[#0b0e14]" style={{ background: ['#ffd43b', '#ffa94d', '#74c0fc', '#ced4da'][p.rank - 1] }}>
                    {p.rank}
                  </span>
                  <span className="text-text-2"><b className="text-text">{p.label}</b> {p.why}</span>
                </li>
              ))}
            </ol>
          )}
          {!centre.specified && <p className="mt-1 text-[12px] text-text-3">The 3D model shows one arbitrary arrangement. Choose R or S (or draw a wedge in 2D) to specify it — Orbital never assigns it for you.</p>}
        </Section>
      )}
      {angles.length > 0 && (
        <Section title="Bond angles (model)">
          <div className="grid grid-cols-2 gap-x-3">
            {angles.slice(0, 8).map((x) => (
              <Row key={x.a + x.b} k={`${label(x.a)}–${atom.element}–${label(x.b)}`} v={`${x.v.toFixed(1)}°`} mono />
            ))}
          </div>
          {why.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[11.5px] text-text-2">
              {why.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </Section>
      )}
    </>
  );
}

function explainCip(doc: ReturnType<typeof studio>['doc'], id: AtomId, priorities: StereoNeighbour[]) {
  const view = new MolView(doc);
  const cip = new CipRanker(view);
  const i = view.idx(id);
  return priorities.map((p, k) => {
    const label = p === 'H' ? 'H' : p === 'LP' ? 'lone pair' : doc.atoms.find((a) => a.id === p)?.element ?? '?';
    let why = '';
    if (k < priorities.length - 1) {
      const d = cip.explain(i, p, priorities[k + 1]);
      if (d.sphere === 1) why = `outranks the next group directly (higher atomic number).`;
      else if (d.sphere > 1) why = `ties at first, then wins at sphere ${d.sphere}: {${d.setA.join(', ')}} beats {${d.setB.join(', ')}}.`;
    } else why = 'lowest priority — point it away to read R/S.';
    return { rank: k + 1, label, why };
  });
}

// ---------------------------------------------------------------------------------------------

function BondInspector({ id }: { id: BondId }) {
  const doc = useStudio((s) => s.doc);
  const a = useStudio((s) => s.analysis);
  const b = doc.bonds.find((x) => x.id === id);
  if (!b) return null;
  const c = coords();
  const len = c[b.a1] && c[b.a2] ? v3.dist(c[b.a1] as Vec3, c[b.a2] as Vec3) : null;
  const e1 = doc.atoms.find((x) => x.id === b.a1)!.element;
  const e2 = doc.atoms.find((x) => x.id === b.a2)!.element;
  const sb = a?.stereo.bonds.find((x) => x.bondId === id);
  const rot = isRotatable(doc, id);
  return (
    <Section title="Bond">
      <div className="text-[15px] font-semibold">{e1}{b.order === 1 ? '–' : b.order === 2 ? '=' : '≡'}{e2} · {b.order === 1 ? 'single' : b.order === 2 ? 'double' : 'triple'}{b.aromatic ? ' (aromatic)' : ''}</div>
      {len !== null && <Row k="Model length" v={`${len.toFixed(3)} Å`} mono />}
      <Row k="Rotates freely" v={rot ? 'yes' : 'no'} />
      <div className="mt-2 flex gap-1">
        {([1, 2, 3] as const).map((o) => (
          <button key={o} onClick={() => setBondOrder(id, o)} className={`rounded-md px-2.5 py-1 text-[12px] ${b.order === o ? 'bg-accent text-accent-ink' : 'border border-border hover:border-accent'}`}>
            {o === 1 ? 'single' : o === 2 ? 'double' : 'triple'}
          </button>
        ))}
        <button onClick={() => cycleBondOrder(id)} className="rounded-md border border-border px-2 py-1 text-[12px] hover:border-accent" title="Cycle through valence-compatible orders">cycle</button>
      </div>
      {sb && (
        <div className="mt-3 flex items-center justify-between text-[13px]">
          <span>{sb.specified && sb.descriptor ? <>Configuration <b className="italic">{sb.descriptor}</b></> : <span className="text-amber">E/Z not specified</span>}</span>
          <div className="flex gap-1">
            {(['E', 'Z'] as const).map((d) => (
              <button key={d} onClick={() => studio().apply({ type: 'setDoubleBondDescriptor', bondId: id, descriptor: d })} className={`rounded-md px-2.5 py-0.5 text-[12px] font-semibold italic ${sb.descriptor === d && sb.specified ? 'bg-accent text-accent-ink' : 'border border-border hover:border-accent'}`}>
                {d}
              </button>
            ))}
          </div>
        </div>
      )}
      {rot && (
        <button onClick={() => useStudio.setState({ mode3d: 'conformer', activeBond: id, view: studio().view === '2d' ? 'split' : studio().view })} className="mt-3 flex items-center gap-1.5 rounded-lg bg-accent-soft px-2.5 py-1.5 text-[12.5px] font-medium text-accent-strong">
          <I.Rotate size={14} /> Rotate this bond (Newman + energy)
        </button>
      )}
      <button onClick={() => studio().apply({ type: 'removeBonds', bondIds: [id] }, { select: 'none' })} className="mt-2 block text-[12px] text-danger">Delete bond</button>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------

export function ConformerPanel() {
  const bondId = useStudio((s) => s.activeBond);
  const scan = useStudio((s) => s.scan);
  const doc = useStudio((s) => s.doc);
  const live = useStudio((s) => s.liveEnergy);
  if (!bondId) {
    return (
      <Section title="Conformer mode">
        <p className="text-[12.5px] leading-snug text-text-2">Click a single (non-ring) bond to rotate it. Drag the ring handle; the Newman projection and the energy curve follow live. Identity and name never change when you rotate.</p>
      </Section>
    );
  }
  const dih = scan && scan.bondId === bondId ? currentDihedral(scan.dihedral) : null;
  const rel = live !== null && scan ? live - scan.e0 : null;
  void doc;
  return (
    <>
      <Section title="Newman projection" right={<span className="mono text-[12px] text-text-2">{dih !== null ? `${dih.toFixed(0)}°` : ''}</span>}>
        <div className="flex items-center gap-3">
          <Newman bondId={bondId} size={150} />
          <div className="text-[12.5px] leading-snug">
            <div className="font-semibold">{dih !== null ? conformationName(dih) : '—'}</div>
            <div className="mt-1 text-text-2">Front carbon: the dot. Back carbon: the circle.</div>
            <div className="mt-2 flex gap-1">
              {[-60, 60].map((d) => (
                <button key={d} onClick={() => rotateBond(bondId, d)} className="rounded-md border border-border px-2 py-0.5 text-[12px] hover:border-accent">
                  {d > 0 ? '+60°' : '−60°'}
                </button>
              ))}
            </div>
          </div>
        </div>
      </Section>
      <Section title="Energy vs dihedral">
        {scan && scan.bondId === bondId ? (
          <>
            <EnergyCurve xs={scan.angles} ys={scan.energies} current={dih} onSeek={(x) => dih !== null && rotateBond(bondId, x - dih)} caption="Rigid-rotation MMFF energy" />
            <p className="mt-1 text-[11.5px] text-text-3">{scan.method}. Current: <span className="mono">{rel !== null ? `${rel.toFixed(2)} kcal/mol` : '—'}</span> above the scan minimum. Relative force-field energy, not an experimental value.</p>
          </>
        ) : (
          <button onClick={() => void computeScan(bondId)} className="text-[12.5px] text-accent-strong">Compute energy curve</button>
        )}
      </Section>
      <Section title="Identity">
        <p className="text-[12.5px] text-text-2">Rotating a single bond changes the <i>conformer</i>, not the molecule — the graph, stereodescriptors and name stay the same.</p>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------------------------

export function Inspector() {
  const selection = useStudio((s) => s.selection);
  const mode = useStudio((s) => s.mode3d);
  const invalid = useStudio((s) => s.invalid);
  const verification = useStudio((s) => s.verification);
  const doc = useStudio((s) => s.doc);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scroll-thin" data-testid="inspector">
      {invalid && <InvalidCard />}
      {mode === 'conformer' && <ConformerPanel />}
      {selection.atoms.length === 1 && <AtomInspector id={selection.atoms[0]} />}
      {selection.bonds.length === 1 && selection.atoms.length === 0 && mode !== 'conformer' && <BondInspector id={selection.bonds[0]} />}
      {selection.atoms.length > 1 && (
        <Section title="Selection">
          <p className="text-[13px] text-text-2">{selection.atoms.length} atoms selected. Press Delete to remove them, or drag them in 2D.</p>
        </Section>
      )}
      {doc.atoms.length > 0 && verification?.message && !verification.primary && (
        <Section title="Name">
          <div className="flex items-start gap-2 text-[12.5px] text-text-2">
            <ProvenanceBadge p="unsupported" /> <span>{verification.message}</span>
          </div>
          <button onClick={() => scheduleAnalysis(0)} className="mt-1 text-[12px] text-accent-strong">Retry</button>
        </Section>
      )}
      <FactsCard />
    </div>
  );
}
