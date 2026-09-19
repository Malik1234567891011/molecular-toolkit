"""RDKit: the authoritative standardisation profile (spec §16 'Engine authority')."""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import rdkit
from rdkit import Chem, RDLogger
from rdkit.Chem import AllChem, Crippen, Descriptors, Lipinski, rdCIPLabeler, rdDepictor, rdMolDescriptors
from rdkit.Chem.MolStandardize import rdMolStandardize  # noqa: F401  (kept for future tautomer work)

RDLogger.DisableLog("rdApp.*")

RDKIT_VERSION = rdkit.__version__
STANDARDIZATION_PROFILE = "orbital-std-1 (RDKit sanitize, keep charges/stereo/tautomer as drawn)"


class ChemError(Exception):
    """Human-safe chemistry error with a pedagogical message."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


PEDAGOGICAL = {
    "valence": "An atom has more bonds than its valence allows (for example a carbon with five bonds).",
    "kekulize": "An aromatic ring could not be drawn with alternating double bonds — check ring hydrogens such as [nH] in pyrrole-type rings.",
    "parse": "The structure text could not be read.",
}


def mol_from_text(text: str) -> Chem.Mol:
    text = text.strip()
    if not text:
        raise ChemError("parse", "Nothing to read.")
    mol = None
    if "M  END" in text or "V2000" in text or "V3000" in text:
        mol = Chem.MolFromMolBlock(text, sanitize=False, removeHs=False)
    elif text.startswith("InChI="):
        mol = Chem.MolFromInchi(text, sanitize=False)
    else:
        mol = Chem.MolFromSmiles(text, sanitize=False)
    if mol is None:
        raise ChemError("parse", PEDAGOGICAL["parse"])
    try:
        Chem.SanitizeMol(mol)
    except Chem.AtomValenceException as exc:  # type: ignore[attr-defined]
        raise ChemError("valence", PEDAGOGICAL["valence"]) from exc
    except Chem.KekulizeException as exc:  # type: ignore[attr-defined]
        raise ChemError("kekulize", PEDAGOGICAL["kekulize"]) from exc
    except Exception as exc:  # noqa: BLE001
        raise ChemError("parse", PEDAGOGICAL["parse"]) from exc
    Chem.AssignStereochemistry(mol, cleanIt=True, force=True)
    return mol


def try_mol(text: str) -> Chem.Mol | None:
    try:
        return mol_from_text(text)
    except ChemError:
        return None


def identifiers(mol: Chem.Mol) -> dict[str, str]:
    m = Chem.Mol(mol)
    for a in m.GetAtoms():
        a.SetAtomMapNum(0)
    inchi = Chem.MolToInchi(m) or ""
    return {
        "canonicalSmiles": Chem.MolToSmiles(m),
        "inchi": inchi,
        "inchiKey": Chem.InchiToInchiKey(inchi) if inchi else "",
        "formula": rdMolDescriptors.CalcMolFormula(m),
    }


def stereo_report(mol: Chem.Mol) -> dict[str, Any]:
    centres = Chem.FindMolChiralCenters(mol, includeUnassigned=True, useLegacyImplementation=False)
    unspecified = [i for i, lab in centres if lab == "?"]
    info = Chem.FindPotentialStereo(mol)
    bonds_unspec = [
        si.centeredOn for si in info
        if si.type == Chem.StereoType.Bond_Double and si.specified == Chem.StereoSpecified.Unspecified
    ]
    return {
        "centres": len(centres),
        "unspecifiedCentres": unspecified,
        "unspecifiedDoubleBonds": bonds_unspec,
        "complete": not unspecified and not bonds_unspec,
    }


def cip_labels(mol: Chem.Mol) -> dict[str, Any]:
    m = Chem.Mol(mol)
    rdCIPLabeler.AssignCIPLabels(m)
    atoms = {a.GetIdx(): a.GetProp("_CIPCode") for a in m.GetAtoms() if a.HasProp("_CIPCode")}
    bonds = {b.GetIdx(): b.GetProp("_CIPCode") for b in m.GetBonds() if b.HasProp("_CIPCode")}
    return {"atoms": atoms, "bonds": bonds}


def properties(mol: Chem.Mol) -> dict[str, Any]:
    return {
        "molarMass": Descriptors.MolWt(mol),
        "exactMass": Descriptors.ExactMolWt(mol),
        "formula": rdMolDescriptors.CalcMolFormula(mol),
        "formalCharge": Chem.GetFormalCharge(mol),
        "logP": Crippen.MolLogP(mol),
        "tpsa": rdMolDescriptors.CalcTPSA(mol),
        "hbd": Lipinski.NumHDonors(mol),
        "hba": Lipinski.NumHAcceptors(mol),
        "rotatableBonds": rdMolDescriptors.CalcNumRotatableBonds(mol),
        "rings": rdMolDescriptors.CalcNumRings(mol),
        "heavyAtoms": mol.GetNumHeavyAtoms(),
    }


def depict_2d(mol: Chem.Mol) -> str:
    m = Chem.Mol(mol)
    rdDepictor.SetPreferCoordGen(True)
    rdDepictor.Compute2DCoords(m)
    return Chem.MolToMolBlock(m)


def same_structure(a: Chem.Mol, b: Chem.Mol) -> dict[str, Any]:
    ia = identifiers(a)
    ib = identifiers(b)
    same = ia["inchiKey"] == ib["inchiKey"] and ia["canonicalSmiles"] == ib["canonicalSmiles"]
    same_connectivity = ia["inchiKey"][:14] == ib["inchiKey"][:14]
    return {
        "identical": same,
        "sameConnectivity": same_connectivity,
        "sameFormula": ia["formula"] == ib["formula"],
        "a": ia,
        "b": ib,
    }


# ---------------------------------------------------------------------------------------------
# 3D: ETKDGv3 + MMFF94 (with UFF fallback)


@dataclass
class ConformerOut:
    coords: dict[str, list[float]]
    energy: float | None
    converged: bool
    method: str


def _mapped_mol(smiles_with_maps: str) -> tuple[Chem.Mol, dict[int, int]]:
    mol = mol_from_text(smiles_with_maps)
    idx_to_map = {}
    for a in mol.GetAtoms():
        idx_to_map[a.GetIdx()] = a.GetAtomMapNum()
        a.SetAtomMapNum(0)
    return mol, idx_to_map


def conformers(smiles_with_maps: str, count: int = 1, seed: int = 0xF00D, prune_rms: float = 0.5, max_iters: int = 2000) -> dict[str, Any]:
    """Embed conformers. Atom maps (1-based document order) key the returned coordinates;
    hydrogens are keyed '<map>.h<k>'."""
    mol, idx_to_map = _mapped_mol(smiles_with_maps)
    mh = Chem.AddHs(mol)
    params = AllChem.ETKDGv3()
    params.randomSeed = seed
    params.pruneRmsThresh = prune_rms
    params.numThreads = 0
    n = max(1, min(count, 200))
    cids = list(AllChem.EmbedMultipleConfs(mh, numConfs=n, params=params))
    method_embed = "ETKDGv3"
    if not cids:
        params.useRandomCoords = True
        cids = list(AllChem.EmbedMultipleConfs(mh, numConfs=n, params=params))
        method_embed = "ETKDGv3 (random coordinates)"
    if not cids:
        raise ChemError("embed", "RDKit could not generate 3D coordinates for this structure.")
    results: list[ConformerOut] = []
    ff_name = "MMFF94"
    if AllChem.MMFFHasAllMoleculeParams(mh):
        opt = AllChem.MMFFOptimizeMoleculeConfs(mh, maxIters=max_iters)
    else:
        ff_name = "UFF"
        opt = AllChem.UFFOptimizeMoleculeConfs(mh, maxIters=max_iters)
    for cid, (not_conv, energy) in zip(cids, opt):
        conf = mh.GetConformer(cid)
        coords: dict[str, list[float]] = {}
        h_counter: dict[int, int] = {}
        for atom in mh.GetAtoms():
            p = conf.GetAtomPosition(atom.GetIdx())
            xyz = [round(p.x, 4), round(p.y, 4), round(p.z, 4)]
            if atom.GetIdx() < mol.GetNumAtoms():
                coords[str(idx_to_map.get(atom.GetIdx(), atom.GetIdx() + 1))] = xyz
            else:
                parent = atom.GetNeighbors()[0].GetIdx()
                pm = idx_to_map.get(parent, parent + 1)
                h_counter[pm] = h_counter.get(pm, 0) + 1
                coords[f"{pm}.h{h_counter[pm]}"] = xyz
        results.append(ConformerOut(coords, float(energy) if energy is not None and math.isfinite(energy) else None, not_conv == 0, f"{method_embed} + {ff_name}"))
    results.sort(key=lambda r: (r.energy is None, r.energy or 0))
    e0 = results[0].energy
    return {
        "method": f"RDKit {RDKIT_VERSION}: {method_embed} embedding, {ff_name} optimisation",
        "caveat": "Force-field model geometry (gas phase, no solvent). Quick conformer searches can miss the global minimum.",
        "conformers": [
            {
                "coordinates": r.coords,
                "energy": r.energy,
                "relativeEnergy": (r.energy - e0) if (r.energy is not None and e0 is not None) else None,
                "converged": r.converged,
                "method": r.method,
            }
            for r in results
        ],
    }


def mmff_energy_scan(smiles_with_maps: str, coords: dict[str, list[float]], dihedral_maps: list[int], angles: list[float], relax: bool = False) -> dict[str, Any]:
    """Single-point (or constrained-relaxed) MMFF energies while rotating one dihedral."""
    from rdkit.Chem import rdMolTransforms
    from rdkit.Geometry import Point3D

    mol, idx_to_map = _mapped_mol(smiles_with_maps)
    map_to_idx = {v: k for k, v in idx_to_map.items()}
    mh = Chem.AddHs(mol)
    AllChem.EmbedMolecule(mh, randomSeed=7)
    conf = mh.GetConformer()
    h_seen: dict[int, int] = {}
    for atom in mh.GetAtoms():
        i = atom.GetIdx()
        if i < mol.GetNumAtoms():
            key = str(idx_to_map[i])
        else:
            parent = atom.GetNeighbors()[0].GetIdx()
            pm = idx_to_map[parent]
            h_seen[pm] = h_seen.get(pm, 0) + 1
            key = f"{pm}.h{h_seen[pm]}"
        if key in coords:
            x, y, z = coords[key]
            conf.SetAtomPosition(i, Point3D(x, y, z))
    props = AllChem.MMFFGetMoleculeProperties(mh)
    if props is None:
        raise ChemError("mmff", "MMFF94 has no parameters for this structure.")
    a, b, c, d = (map_to_idx[m] for m in dihedral_maps)
    energies = []
    for ang in angles:
        work = Chem.Mol(mh)
        wc = work.GetConformer()
        rdMolTransforms.SetDihedralDeg(wc, a, b, c, d, float(ang))
        ff = AllChem.MMFFGetMoleculeForceField(work, AllChem.MMFFGetMoleculeProperties(work))
        if relax:
            ff.MMFFAddTorsionConstraint(a, b, c, d, False, float(ang), float(ang), 1e4)
            ff.Minimize(maxIts=500)
        energies.append(ff.CalcEnergy())
    e0 = min(energies)
    return {"angles": angles, "energies": [e - e0 for e in energies], "unit": "kcal/mol", "method": "MMFF94 " + ("relaxed scan" if relax else "single points (rigid rotation)")}
