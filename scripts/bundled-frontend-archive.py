"""Verify all frontend bytes before adding them to an APK or trusting a cache."""

import hashlib
import json
import pathlib
import re
import stat
import sys
import zipfile

MANIFEST = "frontend-manifest.json"
MAX_BYTES = 2 * 1024**3
MAX_FILES = 40_000


def safe_path(value):
    if not isinstance(value, str) or not value or "\\" in value or "\0" in value:
        raise ValueError("Invalid frontend asset path")
    path = pathlib.PurePosixPath(value)
    if path.is_absolute() or any(part in ("", ".", "..") for part in value.split("/")):
        raise ValueError("Frontend asset path escapes its root")
    return value


def load_manifest(data, lock):
    if hashlib.sha256(data).hexdigest() != lock["manifestSha256"]:
        raise ValueError("Frontend manifest SHA256 does not match lock")
    manifest = json.loads(data)
    for name in ("sourceRepository", "sourceCommit", "upstreamVersion", "upstreamCommit"):
        if manifest.get(name) != lock[name]:
            raise ValueError("Frontend manifest identity mismatch: " + name)
    if manifest.get("schema") != 1 or manifest.get("entry") != "index.html":
        raise ValueError("Unsupported frontend manifest")
    routes = manifest.get("pageRoutes")
    if not isinstance(routes, list) or not routes or len(routes) > 1000:
        raise ValueError("Missing frontend page routes")
    for route in routes:
        if not isinstance(route, str) or len(route) > 1024 or not route.startswith("^") or not route.endswith("$"):
            raise ValueError("Frontend page routes must be bounded regular expressions")
        re.compile(route)
    records = manifest.get("files")
    if not isinstance(records, list) or not records or len(records) > MAX_FILES:
        raise ValueError("Invalid frontend file inventory")
    files = {}
    for record in records:
        name = safe_path(record["path"])
        if name == MANIFEST or name in files:
            raise ValueError("Duplicate or reserved frontend asset path")
        if not re.fullmatch(r"[0-9a-f]{64}", record.get("sha256", "")):
            raise ValueError("Invalid frontend file digest")
        if type(record.get("size")) is not int or record["size"] < 0:
            raise ValueError("Invalid frontend file size")
        if not re.fullmatch(r"[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+", record.get("mime", "")):
            raise ValueError("Invalid frontend file MIME type")
        files[name] = record
    if "index.html" not in files or sum(item["size"] for item in files.values()) > MAX_BYTES:
        raise ValueError("Missing frontend entry or excessive unpacked size")
    return manifest, files


def verify_bytes(data, record):
    if len(data) != record["size"] or hashlib.sha256(data).hexdigest() != record["sha256"]:
        raise ValueError("Frontend asset size or SHA256 mismatch: " + record["path"])


def verify_directory(directory, lock):
    directory = pathlib.Path(directory)
    manifest, files = load_manifest((directory / MANIFEST).read_bytes(), lock)
    actual = set()
    for filename in directory.rglob("*"):
        if filename.is_symlink():
            raise ValueError("Frontend assets cannot be symlinks")
        if filename.is_file():
            name = filename.relative_to(directory).as_posix()
            actual.add(name)
            if name != MANIFEST:
                if name not in files:
                    raise ValueError("Unlisted frontend asset")
                verify_bytes(filename.read_bytes(), files[name])
    if actual != set(files) | {MANIFEST}:
        raise ValueError("Frontend asset inventory is incomplete")
    return {"sourceCommit": manifest["sourceCommit"], "files": len(files)}


def extract_archive(archive, directory, lock):
    directory = pathlib.Path(directory)
    with zipfile.ZipFile(archive) as zipped:
        names = set()
        entries = []
        total = 0
        for info in zipped.infolist():
            name = info.filename.rstrip("/") if info.is_dir() else info.filename
            safe_path(name)
            if info.filename in names or stat.S_ISLNK(info.external_attr >> 16):
                raise ValueError("Duplicate or symlink ZIP entry")
            names.add(info.filename)
            total += info.file_size
            if total > MAX_BYTES or len(names) > MAX_FILES * 2:
                raise ValueError("Frontend ZIP exceeds unpacking limits")
            if not info.is_dir():
                entries.append(info)
        manifest, files = load_manifest(zipped.read(MANIFEST), lock)
        if {entry.filename for entry in entries} != set(files) | {MANIFEST}:
            raise ValueError("ZIP files do not match the verified inventory")
        for info in entries:
            data = zipped.read(info)
            if info.filename != MANIFEST:
                verify_bytes(data, files[info.filename])
            destination = directory / info.filename
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
    return verify_directory(directory, lock)


def verify_apk(archive, lock):
    prefix = "assets/bundled-frontend/"
    with zipfile.ZipFile(archive) as zipped:
        manifest, files = load_manifest(zipped.read(prefix + MANIFEST), lock)
        names = [info.filename for info in zipped.infolist() if info.filename.startswith(prefix) and not info.is_dir()]
        if len(names) != len(set(names)) or set(names) != {prefix + name for name in files} | {prefix + MANIFEST}:
            raise ValueError("APK frontend inventory mismatch")
        for name, record in files.items():
            verify_bytes(zipped.read(prefix + name), record)
    return {"sourceCommit": manifest["sourceCommit"], "files": len(files)}


if __name__ == "__main__":
    try:
        operation = sys.argv[1]
        lock = json.loads(pathlib.Path(sys.argv[-1]).read_text())
        if operation == "verify":
            result = verify_directory(sys.argv[2], lock)
        elif operation == "extract":
            result = extract_archive(sys.argv[2], sys.argv[3], lock)
        elif operation == "apk":
            result = verify_apk(sys.argv[2], lock)
        else:
            raise ValueError("Unknown frontend verification operation")
        print(json.dumps(result))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
