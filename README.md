# Orbital — molecular studio

A free, web-first molecular modelling studio and organic-chemistry naming tutor. Type a name,
draw a structure, scan one from a photo, or build it atom by atom in 3D, then move in both
directions between structure and IUPAC name, with every naming decision explained on the
molecule itself.

The product spec is [`docs/SPEC.md`](docs/SPEC.md); how each part of it is built, and the
running verification log, is in [`docs/PLAN.md`](docs/PLAN.md).

## What it does

- **Build in 3D** with valence-aware connection ports: drag from a port, pick an element, and
  the atom snaps in and the model relaxes. Impossible bonds are refused with an explanation,
  never a bare error.
- **Draw in 2D** on the same molecular graph. Split view keeps 2D, 3D and the name in sync, so
  selecting an atom anywhere lights it everywhere.
- **Name → structure** through OPSIN and PubChem in parallel. Ambiguous input shows candidate
  cards, and typos get "did you mean…?".
- **Structure → name** through a course-rule engine that emits a full naming trace. Every name is
  round-tripped through OPSIN and carries an honest provenance label (Verified systematic,
  Database name, …).
- **Explain the name** in six steps: principal group, parent chain (with "why not this one?"
  comparisons), numbering in both directions, substituents, stereo, assembly. Click any part of
  the name to light up the atoms it describes.
- **Conformer mode**: rotate bonds with a live Newman projection and energy curve, relax to the
  nearest minimum, and browse a filmstrip of low-energy conformers.
- **Projection lab**: Newman ↔ sawhorse ↔ wedge/dash ↔ Fischer ↔ chair, with an animated
  ring flip.
- **Measure** distances, angles and dihedrals, compared with ideal values and explained.
- **Practice**: name, build, parent, numbering, R/S, E/Z, conformations, projections, acidity and
  more. Grading compares structures, not strings; feedback says exactly which rule slipped; a
  hint ladder, spaced repetition and Anki export are included.
- **Grounded tutor** that sees the computed molecule, highlights atoms on it, and has its names
  checked before you see them.
- **Scan a structure** from a photo, with a verification overlay. The reader cross-checks itself
  (ring counts, an independent SMILES, the compound's name) and says when its readings disagree.
- **Orbitals & ESP** (PySCF), resonance contributors, most-acidic-proton, SN2 and other curated
  mechanisms, isomer comparison (including meso detection), study rooms, share links and embeds,
  WebXR AR, and exports (PNG, GIF, video, SVG, molfile, SDF, glTF/GLB, STL, USDZ).
- **How Orbital works**: an in-app guide to every feature in plain words, each with where to
  find it and a "Try it" that does it for real (start screen, the Guide button, ⌘K, or `/guide`).
- Installable PWA, offline for recent molecules; light and dark themes, reduced motion,
  colour-vision-safe atoms, keyboard building and screen-reader narration.

## Layout

| Path | What |
|---|---|
| `packages/chem` | Canonical molecular graph, SMILES/molfile IO, rings, aromaticity, CIP, validation, the course-rule naming engine and its trace (TypeScript, runs in browser, worker and Node) |
| `apps/web` | The Next.js studio: R3F Kit Canvas, SVG 2D editor, panels, chemistry worker (RDKit.js + OpenChemLib) |
| `services/api` | FastAPI + RDKit: name resolution, verification, PubChem, conformers, quantum jobs, tutor, OCSR, shares, analytics |
| `services/api/opsin` | Long-lived OPSIN JVM process behind a line protocol |
| `services/rooms` | Yjs WebSocket relay for study rooms |

## Run it locally

Needs Node 22+, Python 3.12 ([uv](https://docs.astral.sh/uv/) is used when present) and a Java
JDK.

```sh
npm run setup   # npm install, Python venv + requirements, OPSIN download + bridge, web assets
npm run dev     # api :8710 · rooms :8720 · web http://localhost:3100
```

The tutor and photo recognition need an Anthropic API key in `services/api/.env` (see
`services/api/.env.example`). Without one, everything else works and those two features say
they are unavailable.

## Hosting (Vercel)

One Vercel project, three services (`vercel.json`): the Next.js app at `/`, the chemistry API
as a container (`services/api/Dockerfile.vercel`, which carries RDKit, PySCF and a JVM for OPSIN)
at `/api/v1/*`, and the rooms relay as a Node function at `/rooms/*`. Pushing `main` deploys.

Functions are stateless and scale to zero, so hosted state lives in Redis (the Upstash
integration supplies `REDIS_URL`): shares, accounts, synced documents, practice progress, caches,
quantum results, AR files, and study-room documents (kept an hour after a room goes quiet). Every
key is under `orbital:`. Without `REDIS_URL` — local dev — the API uses SQLite in
`services/api/data` and rooms stay in memory. Quantum jobs run inside the submit request when
hosted, so they must finish within the function limit (5 minutes on Hobby).

Every deployment stores its own copy of every service, and the free tier counts the total
(10 GB). The API container is the whole story — 206 MB a build, against under 1 MB for the web
and rooms functions — and Vercel's services beta ignores the per-service `ignoreCommand`, so
each push rebuilds it. Run `npm run prune` after a run of deploys: it keeps the newest three
images and the deployment the live domain points at, and deletes the rest.

Hobby includes 4 Active-CPU hours, 360 GB-hours of memory and 1M requests a month. A quantum
job is the only heavy thing here: about 7 s of CPU for HF/STO-3G on a 33-atom molecule, ~75 s
for B3LYP/6-31G*. A study room holds a function instance open while anyone is connected.

The API also needs `ANTHROPIC_API_KEY` (and `ANTHROPIC_WORKSPACE_ID` for org-level keys) set
in the project's environment variables.

## Tests

```sh
npm test          # chemistry package unit tests
npm run typecheck
npm run corpus    # naming engine round-trip over the gold corpus (engine → OPSIN → same InChIKey)
npm run e2e       # 15 user tasks in system Chrome against the running dev servers
```
