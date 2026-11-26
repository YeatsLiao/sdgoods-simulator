"""Pinned ESP-EMU downloads and native launch detection."""

from __future__ import annotations

from hashlib import sha256
from io import BytesIO
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import threading
from typing import Optional
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent.parent
RUNTIME_DIR = ROOT / "runtime"
WEB_DIR = ROOT / "web"

VERSION = "1.1.0"
ARCHIVE_NAME = f"esp-emu-{VERSION}-wasm"
ARCHIVE_URL = (
    "https://github.com/espressif/esp-emulator/releases/download/"
    f"v{VERSION}/{ARCHIVE_NAME}.tar.gz"
)
ARCHIVE_SHA = "948abc2efcc9e254d01609e0856df856eec21f164bb7c7042e6e1471f71c051c"
RUNTIME_FILES = ("esp_emu.js", "esp_emu_bg.wasm")

NATIVE_ARCHIVE = f"esp-emu-{VERSION}-x86_64-unknown-linux-gnu"
NATIVE_SHA = "bcb940dcf48aa6a1b62dbdc4abc37f05431710f4040d9e2504723a5ea4fd5de9"
NATIVE_NAME = f"esp-emu-{VERSION}-linux"

MAX_FIRMWARE = 32 * 1024 * 1024
MAX_MIC_FRAME = 64 * 1024

SAMPLE_FIRMWARE = WEB_DIR / "demo" / "SDGOODS_EBADGE_app.bin"

_install_lock = threading.Lock()
_native_command: Optional[list[str]] = None
_native_checked = False
_native_lock = threading.Lock()


def _release_archive(name: str, checksum: str) -> tarfile.TarFile:
    url = ARCHIVE_URL.replace(f"{ARCHIVE_NAME}.tar.gz", f"{name}.tar.gz")
    with urlopen(url, timeout=120) as response:
        archive = response.read()
    if sha256(archive).hexdigest() != checksum:
        raise RuntimeError("ESP-EMU 下载校验失败，请检查网络后重试")
    return tarfile.open(fileobj=BytesIO(archive), mode="r:gz")


def _write_atomic(path: Path, data: bytes, mode: Optional[int] = None) -> None:
    temp = path.with_name(path.name + ".download")
    try:
        temp.write_bytes(data)
        if mode is not None:
            temp.chmod(mode)
        temp.replace(path)
    finally:
        if temp.exists():
            temp.unlink(missing_ok=True)


def install_runtime() -> None:
    """Extract the pinned WASM bundle into runtime/, once per version."""
    marker = RUNTIME_DIR / f"release-{VERSION}"
    if marker.is_file() and all((RUNTIME_DIR / name).is_file() for name in RUNTIME_FILES):
        return
    with _install_lock:
        if marker.is_file() and all((RUNTIME_DIR / name).is_file() for name in RUNTIME_FILES):
            return
        RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        print(f"Downloading ESP-EMU {VERSION} (wasm) …", flush=True)
        with _release_archive(ARCHIVE_NAME, ARCHIVE_SHA) as package:
            for name in RUNTIME_FILES:
                member = package.extractfile(f"{ARCHIVE_NAME}/www/pkg/{name}")
                if member is None:
                    raise RuntimeError(f"ESP-EMU 压缩包缺少 {name}")
                _write_atomic(RUNTIME_DIR / name, member.read())
        marker.touch()


def native_command() -> Optional[list[str]]:
    """Return the process prefix that runs Linux binaries, or None."""
    global _native_command, _native_checked
    with _native_lock:
        if _native_checked:
            return _native_command
        _native_checked = True
        if platform.system() == "Linux" and platform.machine().lower() in ("x86_64", "amd64"):
            _native_command = []
            return _native_command
        wsl = shutil.which("wsl.exe")
        if not wsl or platform.machine().upper() != "AMD64":
            return None
        try:
            output = subprocess.check_output(
                [wsl, "--list", "--quiet"], stderr=subprocess.DEVNULL, timeout=6,
            )
            names = output.decode("utf-16-le").replace("\ufeff", "").splitlines()
            distro = next(
                (name.strip() for name in names if name.strip().lower().startswith("ubuntu")),
                None,
            )
            if distro:
                _native_command = [wsl, "--distribution", distro, "--exec"]
        except (OSError, subprocess.SubprocessError, UnicodeError):
            _native_command = None
        return _native_command


def _unix_root(command: list[str]) -> str:
    if not command:
        return str(ROOT)
    output = subprocess.check_output(
        [*command, "wslpath", "-a", str(ROOT)],
        timeout=20,
        stderr=subprocess.DEVNULL,
    )
    root = output.decode().strip()
    if not root:
        raise RuntimeError("无法把项目目录转换为 WSL 路径")
    return root


def install_native(command: list[str]) -> tuple[str, str]:
    """Download the Linux ESP-EMU once and return (unix root, unix binary)."""
    if command is None:
        raise RuntimeError("本机加速需要 x86-64 Linux 或 Ubuntu WSL")
    binary = RUNTIME_DIR / NATIVE_NAME
    with _install_lock:
        if not binary.is_file():
            RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
            print(f"Downloading ESP-EMU {VERSION} (native) …", flush=True)
            with _release_archive(NATIVE_ARCHIVE, NATIVE_SHA) as package:
                source = package.extractfile(f"{NATIVE_ARCHIVE}/esp-emu")
                if source is None:
                    raise RuntimeError("ESP-EMU 压缩包缺少原生可执行文件")
                with source:
                    _write_atomic(binary, source.read(), 0o755)
        elif not (binary.stat().st_mode & 0o111):
            binary.chmod(0o755)
        root = _unix_root(command)
    return root, f"{root}/runtime/{NATIVE_NAME}"


def sample_firmware() -> Optional[Path]:
    return SAMPLE_FIRMWARE if SAMPLE_FIRMWARE.is_file() else None


def sample_metadata() -> dict:
    sample = sample_firmware()
    if sample is None:
        return {"name": "", "size": 0}
    try:
        size = sample.stat().st_size
    except OSError:
        return {"name": sample.name, "size": 0}
    return {"name": sample.name, "size": size}


def status() -> dict:
    return {
        "native": native_command() is not None,
        "version": VERSION,
        "sample": sample_metadata(),
    }
