"""Grounded tutor (spec §12): a tool-calling Claude loop that sees the molecule as structured data.

The model never writes the canonical molecular record. It can only *propose* graph edits (the
client previews them and applies after confirmation), highlight atoms/bonds, and call tools that
return computed chemistry. Every chemical name it wraps in <name> tags is independently parsed by
OPSIN and graph-compared before the student sees a badge. Conversations are not stored.
"""
from __future__ import annotations

import json
import math
import re
from typing import Any, AsyncIterator

import anthropic
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from . import chemistry, config
from .opsin import opsin

router = APIRouter()

_client: anthropic.AsyncAnthropic | None = None


def available() -> bool:
    return bool(config.ANTHROPIC_API_KEY)


def client() -> anthropic.AsyncAnthropic:
    global _client
    if _client is None:
        headers = {"anthropic-workspace-id": config.ANTHROPIC_WORKSPACE_ID} if config.ANTHROPIC_WORKSPACE_ID else None
        _client = anthropic.AsyncAnthropic(api_key=config.ANTHROPIC_API_KEY, max_retries=2, timeout=120.0, default_headers=headers)
    return _client


SYSTEM = """You are Orbital's organic-chemistry tutor. A student is looking at a molecule in a 3D/2D studio. \
You receive the molecule as structured, machine-computed data (graph, CIP priorities, naming trace, facts). \
That data — plus the results of your tools — is your only evidence.

Ground rules (these protect students from confident mistakes):
- Every claim about atoms, bonds, groups, geometry, stereochemistry or names must come from the snapshot or a tool \
result. If the evidence does not cover something, say so plainly instead of guessing.
- If two sources disagree (for example the course engine and the database name), say so and show both.
- Refer to atoms with their ids in double brackets, e.g. [[a3]] or [[a3,a4|the C3–C4 bond]], so the studio can \
highlight them. Use highlight_atoms / highlight_bonds when pointing at something visually helps.
- Wrap every chemical name you write in <name>…</name> tags; the studio verifies each one independently. Add \
ref="current" when the name is meant to describe the molecule on screen: <name ref="current">butan-2-ol</name>.
- Never invent a structure change. To change the molecule, call propose_graph_edit; the student confirms it.
- Be Socratic by default: ask one guiding question or give one hint, then stop. Give the direct answer only when \
the student asks for it ("just tell me", "give me the answer") or has already tried.
- Keep answers short (2–6 sentences). Prefer showing (highlights, naming steps, measurements) to long prose.
- Units and models: geometry is a force-field model, energies are relative force-field energies — never present \
them as experimental measurements.
"""

TOOLS: list[dict[str, Any]] = [
    {
        "name": "get_molecule_snapshot",
        "description": "Return the current molecule: atoms (id, element, charge, implicit H, hybridization, CIP label), bonds, formula, functional groups, validation issues, the verified name with provenance, and the naming trace.",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "highlight_atoms",
        "description": "Highlight atoms in the student's 2D and 3D views, with a short on-screen reason.",
        "input_schema": {
            "type": "object",
            "properties": {"atomIds": {"type": "array", "items": {"type": "string"}}, "reason": {"type": "string"}},
            "required": ["atomIds", "reason"],
            "additionalProperties": False,
        },
    },
    {
        "name": "highlight_bonds",
        "description": "Highlight bonds in the student's views, with a short reason.",
        "input_schema": {
            "type": "object",
            "properties": {"bondIds": {"type": "array", "items": {"type": "string"}}, "reason": {"type": "string"}},
            "required": ["bondIds", "reason"],
            "additionalProperties": False,
        },
    },
    {
        "name": "explain_naming_step",
        "description": "Open one step of the visual naming explanation for the student and return that step's data. Steps: principal_group, parent, numbering, substituents, stereo, assembly.",
        "input_schema": {
            "type": "object",
            "properties": {"stepId": {"type": "string", "enum": ["principal_group", "parent", "numbering", "substituents", "stereo", "assembly"]}},
            "required": ["stepId"],
            "additionalProperties": False,
        },
    },
    {
        "name": "compare_parent_candidates",
        "description": "Compare the chosen parent chain/ring with rejected alternatives: returns each alternative's atoms and the rule that eliminated it. Also shows the comparison to the student.",
        "input_schema": {
            "type": "object",
            "properties": {"candidateIndexes": {"type": "array", "items": {"type": "integer"}, "description": "Indexes into the trace's parent alternatives; empty for all."}},
            "required": ["candidateIndexes"],
            "additionalProperties": False,
        },
    },
    {
        "name": "measure_angle",
        "description": "Measure a distance (2 atoms), bond angle (3 atoms) or dihedral (4 atoms) in the current 3D model geometry. Hydrogens can be referenced as '<atomId>.h1'.",
        "input_schema": {
            "type": "object",
            "properties": {"atomIds": {"type": "array", "items": {"type": "string"}, "minItems": 2, "maxItems": 4}},
            "required": ["atomIds"],
            "additionalProperties": False,
        },
    },
    {
        "name": "propose_graph_edit",
        "description": "Propose a structural change. The studio previews it and applies it only if the student confirms. Actions: load_name (replace the molecule by a named compound — the name is parsed by OPSIN, never by you), set_element, add_substituent, remove_atoms, set_bond_order, mirror, set_descriptor.",
        "input_schema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["load_name", "set_element", "add_substituent", "remove_atoms", "set_bond_order", "mirror", "set_descriptor"]},
                "name": {"type": "string", "description": "For load_name: a systematic or common name."},
                "atomIds": {"type": "array", "items": {"type": "string"}},
                "bondId": {"type": "string"},
                "element": {"type": "string"},
                "substituent": {"type": "string", "description": "SMILES of the group to attach, first atom bonds to the target atom (e.g. 'O', 'Br', 'C(=O)O')."},
                "order": {"type": "integer", "enum": [1, 2, 3]},
                "descriptor": {"type": "string", "enum": ["R", "S", "E", "Z"]},
                "summary": {"type": "string", "description": "One sentence shown on the confirmation card."},
            },
            "required": ["action", "summary"],
            "additionalProperties": False,
        },
    },
    {
        "name": "generate_practice_problem",
        "description": "Turn a concept into a practice problem in the studio's Practice mode.",
        "input_schema": {
            "type": "object",
            "properties": {
                "concept": {"type": "string", "enum": ["name_structure", "build_from_name", "parent_chain", "numbering", "principal_group", "rs", "ez", "mirror_image", "functional_groups", "valence_repair", "bond_angle"]},
                "difficulty": {"type": "integer", "minimum": 1, "maximum": 5},
            },
            "required": ["concept", "difficulty"],
            "additionalProperties": False,
        },
    },
    {
        "name": "check_student_name",
        "description": "Check a name the student proposed: parses it with OPSIN and compares the structure to the molecule on screen (stereo-aware). Never grade names by string comparison.",
        "input_schema": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"], "additionalProperties": False},
    },
    {
        "name": "play_mechanism",
        "description": "Play a curated, human-reviewed mechanism animation. You narrate; you never invent arrows.",
        "input_schema": {
            "type": "object",
            "properties": {"mechanismId": {"type": "string", "enum": ["sn2", "sn1", "e2", "e1", "hbr-addition", "carbonyl-addition", "diels-alder", "eas-bromination", "acid-base"]}},
            "required": ["mechanismId"],
            "additionalProperties": False,
        },
    },
]
for _t in TOOLS:
    _t["eager_input_streaming"] = True

CLIENT_ACTIONS = {"highlight_atoms", "highlight_bonds", "explain_naming_step", "compare_parent_candidates", "propose_graph_edit", "generate_practice_problem", "play_mechanism"}


class ChatIn(BaseModel):
    messages: list[dict[str, Any]]
    snapshot: dict[str, Any]


def _sse(event: dict[str, Any]) -> str:
    return f"data: {json.dumps(event)}\n\n"


def _vec(snapshot: dict[str, Any], aid: str) -> list[float] | None:
    coords = (snapshot.get("conformer") or {}).get("coordinates") or {}
    return coords.get(aid)


def _measure(snapshot: dict[str, Any], ids: list[str]) -> dict[str, Any]:
    pts = [_vec(snapshot, a) for a in ids]
    if any(p is None for p in pts):
        return {"error": "No 3D coordinates for one of these atoms."}
    def sub(a, b):
        return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
    def dot(a, b):
        return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    def cross(a, b):
        return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
    def norm(a):
        return math.sqrt(dot(a, a))
    note = "Model geometry from " + str((snapshot.get("conformer") or {}).get("method", "the current conformer")) + "; not an experimental measurement."
    if len(pts) == 2:
        return {"distance_angstrom": round(norm(sub(pts[0], pts[1])), 3), "note": note}
    if len(pts) == 3:
        u, v = sub(pts[0], pts[1]), sub(pts[2], pts[1])
        ang = math.degrees(math.acos(max(-1, min(1, dot(u, v) / (norm(u) * norm(v))))))
        return {"angle_degrees": round(ang, 1), "note": note}
    b0, b1, b2 = sub(pts[0], pts[1]), sub(pts[2], pts[1]), sub(pts[3], pts[2])
    n1 = norm(b1)
    b1n = [x / n1 for x in b1]
    v = sub(b0, [x * dot(b0, b1n) for x in b1n])
    w = sub(b2, [x * dot(b2, b1n) for x in b1n])
    ang = math.degrees(math.atan2(dot(cross(b1n, v), w), dot(v, w)))
    return {"dihedral_degrees": round(ang, 1), "note": note}


async def _check_name(snapshot: dict[str, Any], name: str) -> dict[str, Any]:
    r = await opsin.parse(name)
    if not r.ok:
        return {"parsed": False, "message": r.message}
    target_smiles = snapshot.get("smiles")
    mol = chemistry.try_mol(r.smiles)
    if not target_smiles or mol is None:
        return {"parsed": True, "smiles": r.smiles}
    target = chemistry.try_mol(target_smiles)
    if target is None:
        return {"parsed": True, "smiles": r.smiles}
    cmp = chemistry.same_structure(target, mol)
    verdict = "same structure (stereo included)" if cmp["identical"] else "same connectivity, different stereochemistry" if cmp["sameConnectivity"] else "constitutional isomer (same formula)" if cmp["sameFormula"] else "a different compound"
    return {"parsed": True, "describes": verdict, "identical": cmp["identical"], "answerFormula": cmp["b"]["formula"], "targetFormula": cmp["a"]["formula"]}


async def _run_tool(name: str, args: dict[str, Any], snapshot: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    """Returns (tool_result_text, client_action_or_None)."""
    trace = snapshot.get("trace") or {}
    if name == "get_molecule_snapshot":
        slim = {k: v for k, v in snapshot.items() if k not in ("conformer",)}
        return json.dumps(slim)[:60000], None
    if name == "measure_angle":
        ids = args.get("atomIds")
        if not isinstance(ids, list) or not 2 <= len(ids) <= 4 or not all(isinstance(x, str) for x in ids):
            return json.dumps({"error": "atomIds must be 2–4 atom ids"}), None
        return json.dumps(_measure(snapshot, ids)), {"name": "measure", "input": {"atomIds": ids}}
    if name == "check_student_name":
        n = args.get("name")
        if not isinstance(n, str) or not n.strip():
            return json.dumps({"error": "name required"}), None
        return json.dumps(await _check_name(snapshot, n)), None
    if name == "explain_naming_step":
        step = args.get("stepId")
        key = {"principal_group": "principalGroup", "parent": "parent", "numbering": "numbering", "substituents": "substituents", "stereo": "stereo", "assembly": "assembly"}.get(str(step))
        data = trace.get(key) if key else None
        return json.dumps({"step": step, "data": data} if data is not None else {"error": "No naming trace for this molecule (it may be outside verified scope)."})[:20000], {"name": name, "input": args}
    if name == "compare_parent_candidates":
        alts = (trace.get("parent") or {}).get("alternatives") or []
        idx = args.get("candidateIndexes") or []
        chosen = [alts[i] for i in idx if isinstance(i, int) and 0 <= i < len(alts)] if idx else alts
        return json.dumps({"chosen": (trace.get("parent") or {}).get("atomIds"), "alternatives": chosen}), {"name": name, "input": args}
    if name == "propose_graph_edit":
        action = args.get("action")
        if action == "load_name":
            n = args.get("name")
            if not isinstance(n, str) or not n.strip():
                return json.dumps({"error": "load_name needs a name"}), None
            r = await opsin.parse(n)
            if not r.ok:
                return json.dumps({"error": f"OPSIN could not parse '{n}': {r.message}. Do not propose it."}), None
            return json.dumps({"status": "Preview shown; waiting for the student to confirm.", "parsedSmiles": r.smiles}), {"name": name, "input": {**args, "smiles": r.smiles}}
        return json.dumps({"status": "Preview shown; waiting for the student to confirm. The studio validates the edit like any manual edit."}), {"name": name, "input": args}
    if name in CLIENT_ACTIONS:
        return json.dumps({"status": "shown to the student"}), {"name": name, "input": args}
    return json.dumps({"error": f"unknown tool {name}"}), None


NAME_TAG = re.compile(r"<name(?:\s+ref=\"(current)\")?>(.*?)</name>", re.S)


async def _verify_names(text: str, snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for m in NAME_TAG.finditer(text):
        ref, name = m.group(1), m.group(2).strip()
        res = await _check_name(snapshot, name)
        entry: dict[str, Any] = {"name": name, "ref": ref, "parsed": res.get("parsed", False)}
        if ref == "current":
            entry["matchesCurrent"] = bool(res.get("identical"))
            entry["describes"] = res.get("describes")
        out.append(entry)
    return out


async def _chat_stream(body: ChatIn) -> AsyncIterator[str]:
    if not available():
        yield _sse({"type": "error", "message": "The AI tutor is not configured on this server (no ANTHROPIC_API_KEY). The step-by-step naming explanation still works without it."})
        return
    snapshot = body.snapshot
    messages: list[dict[str, Any]] = []
    for m in body.messages[-24:]:
        role = m.get("role")
        content = m.get("content")
        if role in ("user", "assistant") and isinstance(content, str) and content.strip():
            messages.append({"role": role, "content": content[:6000]})
    if not messages or messages[-1]["role"] != "user":
        yield _sse({"type": "error", "message": "Ask a question to start."})
        return
    # Fresh snapshot context rides with the latest user turn (keeps the system prompt + tools cacheable).
    brief = {k: snapshot.get(k) for k in ("name", "provenance", "formula", "smiles", "selection") if snapshot.get(k) is not None}
    messages[-1] = {"role": "user", "content": f"[Studio state: {json.dumps(brief)}]\n\n{messages[-1]['content']}"}
    full_text = ""
    for _turn in range(8):
        try:
            async with client().beta.messages.stream(
                model=config.TUTOR_MODEL_LARGE,
                max_tokens=16000,
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                thinking={"type": "adaptive"},
                system=[{"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}],
                tools=TOOLS,
                messages=messages,
            ) as stream:
                async for event in stream:
                    if event.type == "text":
                        full_text += event.text
                        yield _sse({"type": "text", "delta": event.text})
                response = await stream.get_final_message()
        except ValueError:
            yield _sse({"type": "error", "message": "The tutor produced a malformed tool call; please ask again."})
            return
        except anthropic.RateLimitError:
            yield _sse({"type": "error", "message": "The tutor is busy (rate limited). Try again in a minute."})
            return
        except anthropic.APIStatusError as exc:
            detail = "the API key needs a workspace (set ANTHROPIC_WORKSPACE_ID)" if "workspace" in str(exc.message) else f"status {exc.status_code}"
            yield _sse({"type": "error", "message": f"The AI tutor service is not reachable: {detail}. The computed explanations still work.", "code": "tutor_unavailable"})
            return
        except anthropic.APIConnectionError:
            yield _sse({"type": "error", "message": "Could not reach the tutor service (network)."})
            return
        if response.stop_reason == "refusal":
            yield _sse({"type": "error", "message": "The tutor declined this request."})
            return
        messages.append({"role": "assistant", "content": response.content})
        tool_uses = [b for b in response.content if b.type == "tool_use"]
        if response.stop_reason == "pause_turn":
            continue
        if not tool_uses:
            break
        if response.stop_reason == "max_tokens":
            yield _sse({"type": "error", "message": "The tutor's answer was cut off."})
            break
        results = []
        for tu in tool_uses:
            args = tu.input if isinstance(tu.input, dict) else {}
            text, action = await _run_tool(tu.name, args, snapshot)
            if action:
                yield _sse({"type": "action", **action})
            results.append({"type": "tool_result", "tool_use_id": tu.id, "content": text})
        messages.append({"role": "user", "content": results})
        yield _sse({"type": "text", "delta": ""})
    checks = await _verify_names(full_text, snapshot)
    if checks:
        yield _sse({"type": "names", "checks": checks})
    yield _sse({"type": "done", "model": config.TUTOR_MODEL_LARGE})


@router.post("/v1/tutor/chat")
async def tutor_chat(body: ChatIn) -> StreamingResponse:
    return StreamingResponse(_chat_stream(body), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/v1/tutor/status")
async def tutor_status() -> dict[str, Any]:
    return {"available": available(), "model": config.TUTOR_MODEL_LARGE}
