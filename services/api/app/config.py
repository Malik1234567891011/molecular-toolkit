"""Runtime configuration for the Orbital chemistry API."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _load_dotenv() -> None:
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


_load_dotenv()

DATA_DIR = Path(os.environ.get("ORBITAL_DATA_DIR", ROOT / "data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "orbital.sqlite3"

OPSIN_DIR = Path(os.environ.get("OPSIN_DIR", ROOT / "opsin"))
OPSIN_JAR = OPSIN_DIR / "opsin-core-2.9.0-jar-with-dependencies.jar"
OPSIN_CLASSES = OPSIN_DIR / "classes"

# Set this and the metrics dashboard needs ?key=… ; leave it unset and the dashboard is open.
METRICS_KEY = os.environ.get("ORBITAL_METRICS_KEY", "")

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
# Org-level keys that are not scoped to a workspace need this header on every request.
ANTHROPIC_WORKSPACE_ID = os.environ.get("ANTHROPIC_WORKSPACE_ID", "")
TUTOR_MODEL = os.environ.get("ORBITAL_TUTOR_MODEL", "claude-opus-5")
TUTOR_MODEL_LARGE = os.environ.get("ORBITAL_TUTOR_MODEL_LARGE", "claude-opus-5")

# Optional STOUT V2 service (structure → name ML candidates). Unset = tier unavailable.
STOUT_URL = os.environ.get("STOUT_URL", "")

PUBCHEM_BASE = "https://pubchem.ncbi.nlm.nih.gov/rest"
PUBCHEM_TIMEOUT = float(os.environ.get("PUBCHEM_TIMEOUT", "8"))
OFFLINE = os.environ.get("ORBITAL_OFFLINE", "") == "1"

SESSION_SECRET = os.environ.get("ORBITAL_SESSION_SECRET", "dev-only-orbital-secret-change-me")
