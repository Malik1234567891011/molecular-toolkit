"""Long-lived OPSIN process (name → structure). One JVM, requests serialised over a line protocol."""
from __future__ import annotations

import asyncio
import itertools
import shutil
from dataclasses import dataclass, field

from . import config


@dataclass
class OpsinResult:
    status: str  # SUCCESS | WARNING | FAILURE
    smiles: str
    message: str
    flags: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.status != "FAILURE" and bool(self.smiles)


class OpsinBridge:
    def __init__(self) -> None:
        self.proc: asyncio.subprocess.Process | None = None
        self.version = "unknown"
        self.lock = asyncio.Lock()
        self.ids = itertools.count(1)
        self.cache: dict[str, OpsinResult] = {}

    async def start(self) -> None:
        java = shutil.which("java")
        if not java:
            raise RuntimeError("java not found on PATH; OPSIN requires a JRE")
        self.proc = await asyncio.create_subprocess_exec(
            java, "-Xss4m", "-cp", f"{config.OPSIN_CLASSES}:{config.OPSIN_JAR}", "OpsinBridge",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        assert self.proc.stdout
        while True:
            line = (await self.proc.stdout.readline()).decode("utf-8").rstrip("\n")
            if line.startswith("READY"):
                self.version = line.split("\t", 1)[1] if "\t" in line else "unknown"
                break
            if not line and self.proc.returncode is not None:
                raise RuntimeError("OPSIN failed to start")

    async def parse(self, name: str) -> OpsinResult:
        name = name.replace("\t", " ").replace("\n", " ").strip()
        if name in self.cache:
            return self.cache[name]
        async with self.lock:
            if self.proc is None or self.proc.returncode is not None:
                await self.start()
            assert self.proc and self.proc.stdin and self.proc.stdout
            rid = str(next(self.ids))
            self.proc.stdin.write(f"{rid}\t{name}\n".encode("utf-8"))
            await self.proc.stdin.drain()
            while True:
                raw = await asyncio.wait_for(self.proc.stdout.readline(), timeout=20)
                if not raw:
                    self.proc = None
                    return OpsinResult("FAILURE", "", "OPSIN process exited")
                parts = raw.decode("utf-8").rstrip("\n").split("\t")
                if parts[0] != rid:
                    continue
                while len(parts) < 5:
                    parts.append("")
                res = OpsinResult(parts[1], parts[2], parts[3], [f for f in parts[4].split(",") if f])
                if len(self.cache) > 20000:
                    self.cache.clear()
                self.cache[name] = res
                return res

    async def close(self) -> None:
        if self.proc and self.proc.returncode is None:
            self.proc.kill()


opsin = OpsinBridge()
