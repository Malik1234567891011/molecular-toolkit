#!/usr/bin/env bash
# One-time setup for a fresh clone: Node workspaces, the Python chemistry API, and OPSIN.
# Needs Node 22+, Python 3.12 (uv is used when present), and a Java runtime (JDK for javac).
set -euo pipefail
cd "$(dirname "$0")/.."

echo "› Node packages"
npm install

echo "› Python API (services/api/.venv)"
if command -v uv >/dev/null 2>&1; then
  uv venv --python 3.12 services/api/.venv
  uv pip install --python services/api/.venv/bin/python -r services/api/requirements.txt
else
  python3.12 -m venv services/api/.venv
  services/api/.venv/bin/pip install -r services/api/requirements.txt
fi
[ -f services/api/.env ] || cp services/api/.env.example services/api/.env

echo "› OPSIN 2.9.0 (name → structure)"
JAR=services/api/opsin/opsin-core-2.9.0-jar-with-dependencies.jar
if [ ! -f "$JAR" ]; then
  curl -fL -o "$JAR" https://github.com/dan2097/opsin/releases/download/2.9.0/opsin-core-2.9.0-jar-with-dependencies.jar
fi
mkdir -p services/api/opsin/classes
javac -cp "$JAR" -d services/api/opsin/classes services/api/opsin/OpsinBridge.java

echo "› Web assets (RDKit.js, OpenChemLib, chemistry worker)"
npm run build:assets -w @orbital/web

echo
echo "Done. Start everything with:  npm run dev"
