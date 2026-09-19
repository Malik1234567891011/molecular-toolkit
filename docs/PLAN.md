# Orbital — build plan and progress log

Source spec: `orbital-final-spec.md` (kept in `docs/SPEC.md`). This file tracks how each
section of the spec is realised and where the code lives. Update it as work lands.

## Architecture (as built)

| Layer | Where | Notes |
|---|---|---|
| Canonical graph, SMILES/molfile IO, rings, aromaticity, CIP, validation, functional groups | `packages/chem/src` | Pure TypeScript, no WASM needed; runs in browser, worker and Node tests |
| Course-rule naming engine + structured trace | `packages/chem/src/naming` | Deterministic; emits trace JSON with stable atom ids (§9.4) |
| Client chemistry worker | `apps/web/worker` → `public/workers/chem.worker.js` | RDKit.js (validation, InChI/InChIKey, canonical SMILES, descriptors, CoordGen 2D) + OpenChemLib (3D conformers, MMFF94s+ relax, single-point energies) |
| Studio UI | `apps/web/src` | Next.js 16 + React 19 + R3F Kit Canvas + custom SVG 2D editor on the same graph |
| Chemistry API | `services/api` | FastAPI + RDKit (authority), OPSIN bridge, PubChem adapter + cache, naming adapter (course engine verify, PubChem, STOUT slot), conformer ensembles, quantum jobs, shares, accounts, analytics, tutor |
| OPSIN | `services/opsin` | Long-lived JVM process speaking a line protocol (`OpsinBridge.java`) |
| Study rooms | `services/rooms` | Yjs WebSocket relay |

### Deliberate deviations from the spec (and why)

- **2D editor is custom SVG on the canonical graph, not Ketcher.** Ketcher keeps its own
  internal atom ids and round-trips through molfiles, which breaks the stable-id contract that
  name-token ↔ atom highlighting depends on (§8 split view, §9.4). A graph-native editor keeps
  one source of truth.
- **In-browser 3D uses OpenChemLib (BSD-3) MMFF94s+**, because RDKit.js MinimalLib ships no
  ETKDG/MMFF. The server still runs RDKit ETKDGv3 + MMFF94 for ensembles and is labelled as such.
- **xtb-wasm is GPL-3.0** (checked on npm, 2026-09-18) so it cannot ship in the bundle (§17).
  In-browser orbitals use our own extended-Hückel implementation (qualitative, labelled);
  quantitative orbitals/ESP run server-side with PySCF (Apache-2.0) as queued jobs.

## Phase status

All seven phases are built (see the commit history for each feature). Remaining work is
verification and polish, tracked in the log below.

- [x] Phase 1 — core: graph + undo/redo, 2D editor, 3D Kit Canvas with ports, validation, facts, autosave, import/export
- [x] Phase 2 — naming: OPSIN, PubChem, course engine + trace, round-trip verification, provenance, grading, gold corpus
- [x] Phase 3 — trace pedagogy: parent candidates, numbering comparison, token ↔ atom sync, why-not
- [x] Phase 4 — projection lab + practice
- [x] Phase 5 — tutor, NL edits, scan, voice, mechanisms
- [x] Phase 6 — AR, render/export, orbitals, study rooms, sharing, streaks
- [x] Phase 7 — polish: motion, a11y, offline, mobile, error states

## Log

### 2026-09-18 — chemistry core + naming engine v1
- `packages/chem`: SMILES/molfile IO, rings (SSSR), aromaticity, CIP (rules 1–2, agrees with RDKit on 32 test molecules),
  stereo from wedges / 3D, validation copy, functional groups, edit commands with stereo repair.
- Naming engine (`src/naming`): chains, carbocycles, benzene, Hantzsch–Widman + retained heterocycles, fused templates,
  von Baeyer, spiro, esters/anhydrides/salts, R/S, E/Z, ring cis/trans, three course profiles.
- Round-trip verification (engine name → OPSIN → RDKit canonical): **3,549 structures, 99.2 % verified, 0 wrong** in
  every profile; 28 honestly declined (carbamates/ureas, diol diesters, thioacids, one tricycle).
  Run: `node --experimental-strip-types packages/chem/scripts/verify-corpus.ts all`.

### 2026-09-19 — hands-on verification pass (live browser, as a student)
Checked against the spec by using the app in Chrome, fixing what fell short:
- Measure mode explains itself (§10): distance vs typical length, angle vs VSEPR ideal with
  reasons, dihedral + conformation. Atom angle notes judge the spread, not the average.
- Conformer mode (§7): the rotation ring is easy to grab and no longer orbits the camera;
  Relax minimizes in place; a low-energy conformer filmstrip (OCL torsion enumeration +
  MMFF94s+) was missing and now exists.
- Newman labels are textbook groups (CH₃, OH) and stay apart when eclipsed.
- Selection halo is a thin Fresnel rim (§15), not a translucent disc.
- Invalid-valence copy offers O⁺/N⁺ only when that charge makes the bond count valid (§7).
- Naming honesty (§9.3): PubChem synonyms that break the taught rules (alphabetical order,
  hyphen before the parent, CAS inverted) are listed apart and never offered as answers.
- Chair drawing redrawn from an oblique view so axial bonds never overlap; side view
  survives canvas remounts; lost WebGL contexts recover automatically.
- Verified names persist per InChIKey so reopened molecules are verified instantly (§18).
- Production timings (headless, warm): molecule restored ~0.5 s, analysis ~0.2–0.75 s,
  verification ~0.6 s before caching.
- E2E: `apps/web/e2e/run.mjs`, 15 user tasks, all passing.
