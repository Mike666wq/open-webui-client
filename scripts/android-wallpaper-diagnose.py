#!/usr/bin/env python3
"""Exercise the Android wallpaper preview on a GitHub-hosted emulator."""

import argparse
import hashlib
import json
import re
import struct
import subprocess
import threading
import time
import xml.etree.ElementTree as ET
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PACKAGE = "local.openwebui.client"
IMAGE_NAME = "owc-wallpaper-diagnose.png"
PORT = 8765
FIXTURE_LOCK = threading.Lock()
FIXTURE_EVENTS: list[dict] = []


def record_fixture_event(kind: str, details: dict | None = None) -> None:
    event = {"kind": kind, "elapsed": time.monotonic(), **(details or {})}
    with FIXTURE_LOCK:
        FIXTURE_EVENTS.append(event)
        del FIXTURE_EVENTS[:-200]

# This is the image the user reported: appearance disabled, a saved local image,
# and the image control still showing the gradient until Apply is enabled.
REPORTED_CONFIG = {
    "schema": 1,
    "enabled": False,
    "navigation": False,
    "preset": "blue",
    "mode": "system",
    "accent": "#2563EB",
    "background": "gradient",
    "image": "",
    "position": 50,
    "zoom": 100,
    "dim": 0,
    "blur": 0,
    "opacity": 90,
    "glassBlur": 18,
    "radius": 20,
    "codeTone": "auto",
    "fontSize": 16,
    "lineHeight": 165,
}


class DiagnosisFailure(RuntimeError):
    pass


def command(argv, *, check=True, timeout=60, text=True):
    result = subprocess.run(argv, capture_output=True, text=text, timeout=timeout)
    if check and result.returncode:
        stdout = result.stdout or ""
        stderr = result.stderr or ""
        raise DiagnosisFailure(
            f"Command failed ({result.returncode}): {' '.join(argv)}\n{stdout}\n{stderr}"
        )
    return result


def adb(*args, check=True, timeout=60):
    return command(["adb", *args], check=check, timeout=timeout).stdout.strip()


def shell(value, *, check=True, timeout=60):
    return adb("shell", value, check=check, timeout=timeout)


def ensure_device_root():
    """Elevate adbd before fixture forwarding; adb root restarts the daemon."""
    if shell("id -u", check=False).strip() == "0":
        return
    adb("root", check=False, timeout=30)
    time.sleep(2)
    adb("wait-for-device", check=False, timeout=30)


def ensure_fixture_reverse():
    forwarding = f"tcp:{PORT}"
    adb("reverse", forwarding, forwarding)
    mappings = adb("reverse", "--list")
    record_fixture_event("reverse-configured", {"mappings": mappings})
    if forwarding not in mappings:
        raise DiagnosisFailure(
            f"Android fixture forwarding was not established: {mappings!r}"
        )


def screenshot(output, label):
    result = command(["adb", "exec-out", "screencap", "-p"], timeout=45, text=False)
    path = output / f"{label}.png"
    path.write_bytes(result.stdout)
    signature = command(
        ["identify", "-format", "%[mean] %[standard-deviation]", str(path)],
        timeout=30,
    ).stdout.strip()
    (output / f"{label}.pixels.txt").write_text(signature + "\n", encoding="utf-8")
    return path


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        if self.path != "/__fixture_state":
            self.send_error(404)
            return
        length = min(int(self.headers.get("Content-Length", "0")), 65536)
        try:
            details = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_error(400)
            return
        if not isinstance(details, dict):
            self.send_error(400)
            return
        record_fixture_event("page-state", details)
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        if self.path == "/api/config":
            record_fixture_event("api-config")
            body = b'{"status":true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path not in ("/", "/index.html", "/c/original", "/c/restored"):
            self.send_error(404)
            return
        body = (Path(__file__).parent / "fixtures/personalization/android.html").read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def write_test_png(path):
    """Create a dependency-free, high-contrast wallpaper for visual comparison."""
    width, height = 720, 1280
    colors = ((230, 40, 50), (20, 190, 80), (35, 80, 230), (245, 210, 20))
    rows = []
    for y in range(height):
        row = bytearray([0])
        for x in range(width):
            # A large checkerboard and diagonal bands make scaling/crop changes visible.
            section = ((x // 120) + (y // 120) + ((x + y) // 240)) % len(colors)
            row.extend(colors[section])
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(kind, payload):
        return (
            struct.pack(">I", len(payload))
            + kind
            + payload
            + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
        )

    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def hierarchy(output, label):
    remote = "/sdcard/wallpaper-window.xml"
    diagnostics = []
    for attempt in range(1, 5):
        shell(f"rm -f {remote}", check=False, timeout=15)
        result = command(
            ["adb", "shell", "uiautomator", "dump", remote],
            check=False,
            timeout=25,
        )
        diagnostics.append((result.stdout or "")[-500:])
        read = command(["adb", "exec-out", "cat", remote], check=False, timeout=20)
        candidate = read.stdout or ""
        start = candidate.find("<hierarchy")
        end = candidate.rfind("</hierarchy>")
        if read.returncode == 0 and start >= 0 and end >= start:
            candidate = candidate[start : end + len("</hierarchy>")]
            try:
                root = ET.fromstring(candidate)
            except ET.ParseError as error:
                diagnostics.append(f"attempt {attempt}: {error}")
            else:
                (output / f"{label}-hierarchy.xml").write_text(candidate, encoding="utf-8")
                return list(root.iter("node"))
        time.sleep(1)
    (output / f"{label}-accessibility.txt").write_text(
        "UIAutomator did not expose a complete hierarchy.\n"
        + "\n".join(diagnostics)
        + "\n",
        encoding="utf-8",
    )
    raise DiagnosisFailure(f"UI hierarchy unavailable for {label}")


def bounds(node):
    values = list(map(int, re.findall(r"-?\d+", node.get("bounds", ""))))
    if len(values) != 4 or values[2] <= values[0] or values[3] <= values[1]:
        raise DiagnosisFailure(f"Control has no usable bounds: {node.attrib}")
    return values


def matches(node, label):
    return label.casefold() in (
        node.get("text", "").casefold(),
        node.get("content-desc", "").casefold(),
    )


def find(output, label, *, timeout=30, exact=False, predicate=None):
    deadline = time.monotonic() + timeout
    safe_label = re.sub(r"[^A-Za-z0-9_.-]", "-", label)[:40]
    while time.monotonic() < deadline:
        for node in hierarchy(output, safe_label):
            values = (node.get("text", "").casefold(), node.get("content-desc", "").casefold())
            if ((label.casefold() in values) if exact else matches(node, label)) and (
                predicate is None or predicate(node)
            ):
                bounds(node)
                return node
        time.sleep(1)
    raise DiagnosisFailure(f"Missing UI control: {label}")


def wait_for_web_page(output, *, timeout=45):
    """Wait for native connection state and WebView paint without parsing its DOM."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        nodes = hierarchy(output, "web-page-ready")
        has_client_toolbar = any(
            node.get("content-desc", "") in ("Client toolbar", "客户端顶部栏")
            for node in nodes
        )
        has_connected_status = any(
            node.get("text", "") == "Connected"
            or node.get("text", "") == "已连接"
            for node in nodes
        )
        has_web_view = any(
            node.get("class", "").endswith("WebView") for node in nodes
        )
        if has_client_toolbar and has_connected_status and has_web_view:
            screenshot(output, "web-page-ready")
            return
        time.sleep(1)
    raise DiagnosisFailure("Connected WebView did not render within the expected time")


def wait_fixture_state(path, *, appearance=None, timeout=30):
    """Reports come only from our synthetic page; no application test bridge."""
    deadline = time.monotonic() + timeout
    latest = None
    while time.monotonic() < deadline:
        with FIXTURE_LOCK:
            latest = next(
                (dict(item) for item in reversed(FIXTURE_EVENTS) if item["kind"] == "page-state"),
                None,
            )
        if (
            latest
            and time.monotonic() - latest["elapsed"] < 3
            and latest.get("path") == path
            and latest.get("hasInput")
            and latest.get("hasMessages") == (path != "/")
            and (appearance is None or latest.get("appearanceEnabled") is appearance)
        ):
            return latest
        time.sleep(0.25)
    raise DiagnosisFailure(f"Fixture did not reach {path}: {latest}")


def tap_fixture_control(output, label, state):
    # WebView accessibility can omit DOM controls. Convert fixture-reported
    # rectangles to screen coordinates, then send the same real adb touch.
    nodes = hierarchy(output, label)
    view = next((node for node in nodes if node.get("class", "").endswith("WebView")), None)
    rect = state.get("controls", {}).get(label)
    if view is None or not rect or len(rect) != 4 or state.get("width", 0) <= 0:
        raise DiagnosisFailure(f"Fixture control geometry unavailable: {label}")
    left, top, right, bottom = bounds(view)
    scale = (right - left) / state["width"]
    x = left + (rect[0] + rect[2]) * scale / 2
    y = top + (rect[1] + rect[3]) * scale / 2
    if not left < x < right or not top < y < bottom:
        raise DiagnosisFailure(f"Fixture control outside the WebView: {label}")
    shell(f"input tap {round(x)} {round(y)}")


def assert_fixture_glass(state, nonce):
    if state.get("nonce") != nonce or state.get("draft") != "wallpaper diagnostic":
        raise DiagnosisFailure("Applying appearance reloaded the page or changed its draft")
    for name in ("app", "shell", "chat", "messages"):
        paint = state.get(name)
        if name == "messages" and state["path"] == "/":
            continue
        if not paint or paint["backgroundColor"] not in ("rgba(0, 0, 0, 0)", "transparent"):
            raise DiagnosisFailure(f"Opaque page layer hides the wallpaper: {name}={paint}")
    for name in ("input", "bubble", "response"):
        paint = state.get(name)
        if state["path"] == "/" and name != "input":
            continue
        if not paint or "linear-gradient" not in paint["backgroundImage"]:
            raise DiagnosisFailure(f"Readable glass surface missing: {name}={paint}")
    if state.get("innerInput", {}).get("backgroundColor") != "rgba(0, 0, 0, 0)":
        raise DiagnosisFailure("Nested input container stacked another opaque surface")


def write_fixture_evidence(output: Path) -> None:
    with FIXTURE_LOCK:
        events = list(FIXTURE_EVENTS)
    (output / "fixture-events.json").write_text(
        json.dumps(events, indent=2) + "\n",
        encoding="utf-8",
    )


def tap_node(node):
    left, top, right, bottom = bounds(node)
    shell(f"input tap {(left + right) // 2} {(top + bottom) // 2}")


def tap(output, label, *, timeout=30, exact=False):
    tap_node(find(output, label, timeout=timeout, exact=exact))


def tap_exact(output, label, *, timeout=30):
    tap(output, label, timeout=timeout, exact=True)


def tap_picker(output):
    tap_after_scroll(output, "Appearance & reading", timeout=20)


def tap_one(output, labels, *, timeout=30):
    for label in labels:
        try:
            return tap(output, label, timeout=timeout)
        except DiagnosisFailure:
            continue
    raise DiagnosisFailure("None of these controls were available: " + ", ".join(labels))


def enter(output, text):
    field = next(
        (
            node
            for node in hierarchy(output, "address-field")
            if node.get("class", "").endswith("EditText")
        ),
        None,
    )
    if field is None:
        field = find(output, "Server address")
    tap_node(field)
    shell("input keyevent KEYCODE_MOVE_END")
    shell("input keyevent " + " ".join(["KEYCODE_DEL"] * 90))
    shell(f"input text {text}")


def find_image_picker_entry(output, timeout=45):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        nodes = hierarchy(output, "image-picker")
        for node in nodes:
            text = node.get("text", "").casefold()
            description = node.get("content-desc", "").casefold()
            is_file_row = description.startswith(IMAGE_NAME.casefold())
            has_file_name = IMAGE_NAME.casefold() in text or IMAGE_NAME.casefold() in description
            # The thumbnail has a separate "Preview the file ..." hit target in
            # its corner. Tapping that opens Google Photos instead of returning
            # ACTION_OPEN_DOCUMENT, so prefer the file row's full hit area.
            is_preview_action = "preview the file" in description
            if (is_file_row or has_file_name) and not is_preview_action:
                bounds(node)
                return node
        time.sleep(1)
    return None


def select_wallpaper(output):
    entry = find_image_picker_entry(output, timeout=8)
    if entry is None:
        try:
            tap_one(output, ["Large files"], timeout=2)
        except DiagnosisFailure:
            pass
        try:
            tap_one(output, ["Downloads", "Download"], timeout=8)
        except DiagnosisFailure:
            pass
        entry = find_image_picker_entry(output, timeout=18)
    if entry is None:
        tap_one(output, ["Show roots", "Show navigation drawer", "Open navigation drawer"], timeout=8)
        tap_one(output, ["Downloads", "Download"], timeout=12)
        entry = find_image_picker_entry(output, timeout=18)
    if entry is None:
        raise DiagnosisFailure(
            f"{IMAGE_NAME} was not available in the Android document picker"
        )
    before = {
        (node.get("text", ""), node.get("content-desc", ""), node.get("bounds", ""))
        for node in hierarchy(output, "image-picker-before-selection")
    }
    tap_node(entry)
    # Android's Photos app can open a full-screen preview for a single tap.
    # Use its explicit "Done/Select" action when present; otherwise Back returns
    # the chosen document to ACTION_OPEN_DOCUMENT.
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        nodes = hierarchy(output, "image-picker-confirm")
        text = " ".join(
            value
            for node in nodes
            for value in (node.get("text", ""), node.get("content-desc", ""))
            if value
        ).casefold()
        # ACTION_OPEN_DOCUMENT normally returns after one tap. Backward
        # navigation and the scroll position vary by DocumentsUI release, so
        # detect the restored native sheet itself. The caller verifies the
        # asynchronous import result and any explicit failure message.
        application_nodes = [
            node for node in nodes if node.get("package", "") == PACKAGE
        ]
        if any(
            node.get("text", "") == "Appearance & reading"
            for node in application_nodes
        ):
            return
        current = {
            (node.get("text", ""), node.get("content-desc", ""), node.get("bounds", ""))
            for node in nodes
        }
        if current == before:
            time.sleep(1)
            continue
        for label in ("Done", "Select", "Open", "Add"):
            for node in nodes:
                if label.casefold() in {
                    node.get("text", "").casefold(),
                    node.get("content-desc", "").casefold(),
                }:
                    tap_node(node)
                    time.sleep(1)
                    break
            else:
                continue
            break
        time.sleep(1)
    raise DiagnosisFailure("Android document picker did not return the selected image")


def set_slider_to_start(output, label):
    predicate = lambda item: item.get("class", "").endswith("SeekBar")
    try:
        node = find(output, label, timeout=2, predicate=predicate)
    except DiagnosisFailure:
        size = shell("wm size")
        dimensions = re.findall(r"(\d+)x(\d+)", size)
        if not dimensions:
            raise DiagnosisFailure(f"Could not determine emulator size: {size}")
        width, height = map(int, dimensions[-1])
        x = width // 2
        node = None
        for _ in range(6):
            shell(
                f"input swipe {x} {int(height * .72)} "
                f"{x} {int(height * .3)} 350"
            )
            try:
                node = find(output, label, timeout=0.5, predicate=predicate)
                break
            except DiagnosisFailure:
                continue
        if node is None:
            raise DiagnosisFailure(
                f"Could not scroll the appearance panel to {label}"
            )
    left, top, right, bottom = bounds(node)
    y = (top + bottom) // 2
    shell(f"input swipe {right - 4} {y} {left + 2} {y} 250")
    time.sleep(0.4)


def tap_after_scroll(output, label, *, timeout=12):
    try:
        return tap_exact(output, label, timeout=2)
    except DiagnosisFailure:
        size = shell("wm size")
        dimensions = re.findall(r"(\d+)x(\d+)", size)
        if not dimensions:
            raise DiagnosisFailure(f"Could not determine emulator size: {size}")
        width, height = map(int, dimensions[-1])
        x = width // 2
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            shell(
                f"input swipe {x} {int(height * .72)} "
                f"{x} {int(height * .3)} 350"
            )
            try:
                return tap_exact(output, label, timeout=0.5)
            except DiagnosisFailure:
                continue
        raise DiagnosisFailure(f"Could not scroll the panel to {label}")


def disable_appearance(output):
    toggle = find(
        output,
        "Enable appearance",
        predicate=lambda item: item.get("class", "").endswith(
            ("Switch", "SwitchCompat")
        ),
    )
    if toggle.get("checked") == "true":
        tap_node(toggle)


def switch_is_checked(output, label):
    toggle = find(
        output,
        label,
        timeout=20,
        predicate=lambda item: item.get("class", "").endswith(
            ("Switch", "SwitchCompat")
        ),
    )
    return toggle.get("checked") == "true"


def install_reported_config(output):
    """Seed only the per-origin appearance config, never login or chat state."""
    origin = f"http://127.0.0.1:{PORT}"
    digest = hashlib.sha256(origin.encode()).hexdigest()
    directory = f"/data/user/0/{PACKAGE}/no_backup/appearance"
    target = f"{directory}/{digest}.json"
    local = output / "reported-appearance-config.json"
    local.write_text(json.dumps(REPORTED_CONFIG, separators=(",", ":")) + "\n")
    shell(f"mkdir -p {directory}")
    adb("push", str(local), target)
    shell(f"chown $(stat -c '%u:%g' {directory}) {target}")
    shell(f"chmod 600 {target}")
    stored = json.loads(shell(f"cat {target}"))
    if stored != REPORTED_CONFIG:
        raise DiagnosisFailure(f"Could not seed the reported appearance state: {stored}")


def image_compare(before, after, output):
    dimensions = command(
        ["identify", "-format", "%w %h", str(before)], timeout=30
    ).stdout.strip()
    width, height = map(int, dimensions.split())
    crop = f"{max(1, width - 24)}x{max(1, height - 220)}+12+90"
    before_crop = output / "gradient-page.png"
    after_crop = output / "image-page.png"
    command(["convert", str(before), "-crop", crop, "+repage", str(before_crop)])
    command(["convert", str(after), "-crop", crop, "+repage", str(after_crop)])
    result = command(
        ["compare", "-metric", "RMSE", str(before_crop), str(after_crop), "null:"],
        check=False,
    )
    metric = result.stderr.strip()
    (output / "pixel-comparison.txt").write_text(
        f"RMSE={metric}\nbefore={before.name}\nafter={after.name}\n",
        encoding="utf-8",
    )
    match = re.search(r"\(([0-9.]+)\)", metric)
    if not match:
        raise DiagnosisFailure(f"Could not parse ImageMagick RMSE output: {metric}")
    normalized = float(match.group(1))
    if normalized < 0.08:
        raise DiagnosisFailure(
            f"Image wallpaper produced insufficient visual change: RMSE={normalized:.4f}"
        )
    return normalized


def screenshot_wallpaper_metrics(image, output):
    """Assert that the rendered image is vivid enough for a visible wallpaper.

    UIAutomator intentionally omits WebView DOM text and injected accessibility
    nodes, so layer assertions live in the deterministic adapter test. This
    screenshot check verifies the product result instead: the selected image
    reaches the Android frame with strong colour and non-trivial variation.
    """
    crop = f"{max(1, int(image_width(image)) - 24)}x{max(1, int(image_height(image)) - 260)}+12+170"
    page = output / f"{image.stem}-wallpaper-visible-page.png"
    command(["convert", str(image), "-crop", crop, "+repage", str(page)])
    metrics = command(
        [
            "convert",
            str(page),
            "-colorspace",
            "HSL",
            "-channel",
            "G",
            "-separate",
            "-format",
            "%[fx:mean] %[fx:standard_deviation]",
            "info:",
        ],
        timeout=30,
    ).stdout.strip().split()
    if len(metrics) != 2:
        raise DiagnosisFailure(
            f"Could not measure wallpaper visibility: {metrics}"
        )
    saturation, variance = map(float, metrics)
    (output / f"{image.stem}-wallpaper-visual-metrics.txt").write_text(
        f"saturation={saturation:.6f}\nvariance={variance:.6f}\n", encoding="utf-8"
    )
    if saturation < 0.20:
        raise DiagnosisFailure(
            f"Wallpaper remained washed out in the Android frame: saturation={saturation:.4f}"
        )
    if variance < 0.08:
        raise DiagnosisFailure(
            f"Wallpaper lacked visible image variation: variance={variance:.4f}"
        )
    return {"saturation": saturation, "variance": variance}


def image_width(image):
    return command(["identify", "-format", "%w", str(image)], timeout=30).stdout.strip()


def image_height(image):
    return command(["identify", "-format", "%h", str(image)], timeout=30).stdout.strip()


def capture_device_state(output):
    data = {
        "source_sha": shell("getprop ro.build.version.release", check=False),
        "model": shell("getprop ro.product.model", check=False),
        "android_release": shell("getprop ro.build.version.release", check=False),
        "sdk": shell("getprop ro.build.version.sdk", check=False),
        "webview_packages": shell("pm list packages | grep -E 'webview|chrome'", check=False),
    }
    (output / "device-metadata.json").write_text(
        json.dumps(data, indent=2) + "\n", encoding="utf-8"
    )


def collect_persisted_config(output):
    root = shell("id -u", check=False).strip()
    if root != "0":
        adb("root", check=False, timeout=30)
        time.sleep(2)
        adb("wait-for-device", check=False, timeout=30)
    directory = f"/data/user/0/{PACKAGE}/no_backup/appearance"
    listing = shell(f"ls -la {directory}", check=False)
    (output / "appearance-storage.txt").write_text(listing + "\n", encoding="utf-8")
    configs = re.findall(r"(?m)(\S+\.json)\s*$", listing)
    images = re.findall(r"(?m)(wallpaper-[a-f0-9-]+\.jpg)\s*$", listing)
    if not configs or not images:
        raise DiagnosisFailure("Persisted appearance config or decoded JPEG was not found")
    config = shell(f"cat {directory}/{configs[0]}", check=False)
    (output / "appearance-config.json").write_text(config + "\n", encoding="utf-8")
    try:
        parsed = json.loads(config)
    except json.JSONDecodeError as error:
        raise DiagnosisFailure(f"Persisted appearance config is not valid JSON: {error}") from error
    if parsed.get("background") != "image" or not re.fullmatch(
        r"wallpaper-[a-f0-9-]+\.jpg", parsed.get("image", "")
    ) or parsed.get("enabled") is not True:
        raise DiagnosisFailure(f"Unexpected persisted appearance config: {parsed}")
    if parsed.get("schema") != 2 or parsed.get("opacity") != 40:
        raise DiagnosisFailure(f"Appearance config was not migrated to schema 2: {parsed}")
    return parsed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--source-sha", required=True)
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    (output / "source-sha.txt").write_text(args.source_sha + "\n", encoding="utf-8")

    capture_device_state(output)
    ensure_device_root()
    wallpaper = output / IMAGE_NAME
    write_test_png(wallpaper)
    shell("mkdir -p /sdcard/Download")
    adb("push", str(wallpaper), f"/sdcard/Download/{IMAGE_NAME}")
    shell(
        "am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE "
        f"-d file:///sdcard/Download/{IMAGE_NAME}"
    )

    server = ThreadingHTTPServer(("127.0.0.1", PORT), Fixture)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        shell(f"pm clear {PACKAGE}")
        install_reported_config(output)
        # Keep aliases above this boundary stable. Both adb root and package
        # resets can invalidate or race device forwarding.
        ensure_fixture_reverse()
        # The picker is normally opened from the appearance sheet, but the
        # first run showed the test session terminating before that stage.
        # Keep a visible marker so UI failures identify the last completed
        # product action without relying on restricted workflow logs.
        marker = output / "progress.txt"
        marker.write_text("app-cleared\n", encoding="utf-8")
        shell(
            f"monkey -p {PACKAGE} -c android.intent.category.LAUNCHER 1",
            timeout=60,
        )
        marker.write_text("app-launched\n", encoding="utf-8")

        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if any(
                node.get("class", "").endswith("EditText")
                for node in hierarchy(output, "local-connect")
            ):
                break
            time.sleep(1)
        else:
            raise DiagnosisFailure("The local connection screen did not become ready")

        enter(output, f"http://127.0.0.1:{PORT}")
        marker.write_text("address-entered\n", encoding="utf-8")
        shell("input keyevent KEYCODE_BACK")
        tap_exact(output, "Connect")
        marker.write_text("connect-tapped\n", encoding="utf-8")
        wait_for_web_page(output, timeout=45)
        initial_state = wait_fixture_state("/c/original", appearance=False)
        document_nonce = initial_state["nonce"]
        marker.write_text("fixture-connected\n", encoding="utf-8")
        screenshot(output, "00-connected-original")

        tap_exact(output, "Client settings")
        marker.write_text("menu-opened\n", encoding="utf-8")
        tap_picker(output)
        marker.write_text("appearance-opened\n", encoding="utf-8")
        if switch_is_checked(output, "Enable appearance"):
            raise DiagnosisFailure("The reported appearance state was not seeded as disabled")
        marker.write_text("reported-disabled-appearance-open\n", encoding="utf-8")
        set_slider_to_start(output, "Scrim (%)")
        marker.write_text("scrim-zero\n", encoding="utf-8")
        set_slider_to_start(output, "Panel opacity (%)")
        marker.write_text("opacity-zero\n", encoding="utf-8")
        tap_exact(output, "Apply")
        marker.write_text("gradient-applied\n", encoding="utf-8")
        find(output, "Client settings", timeout=20, exact=True)
        time.sleep(3)
        gradient = screenshot(output, "10-gradient")
        marker.write_text("gradient-captured\n", encoding="utf-8")

        tap_exact(output, "Client settings")
        marker.write_text("menu-reopened\n", encoding="utf-8")
        tap_picker(output)
        marker.write_text("appearance-reopened\n", encoding="utf-8")
        tap_after_scroll(output, "Choose image (up to 20 MB)", timeout=20)
        marker.write_text("picker-opened\n", encoding="utf-8")
        select_wallpaper(output)
        marker.write_text("picker-selected\n", encoding="utf-8")

        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            nodes = hierarchy(output, "after-image-import")
            text = " ".join(
                node.get("text", "") + " " + node.get("content-desc", "")
                for node in nodes
            )
            failures = (
                "Could not import image",
                "Use JPEG, PNG or WebP",
                "Wallpaper unavailable",
            )
            if any(message in text for message in failures):
                raise DiagnosisFailure(f"Appearance image import failed: {text[-500:]}")
            local_image = any(node.get("text", "") == "Local image" for node in nodes)
            apply = next(
                (
                    node
                    for node in nodes
                    if node.get("text", "") == "Apply"
                    and node.get("enabled", "true") == "true"
                ),
                None,
            )
            preview = next(
                (
                    node
                    for node in nodes
                    if node.get("content-desc") == "Wallpaper preview"
                ),
                None,
            )
            appearance_enabled = switch_is_checked(output, "Enable appearance")
            if (
                "Importing" not in text
                and local_image
                and apply is not None
                and preview is not None
                and appearance_enabled
            ):
                break
            time.sleep(1)
        else:
            raise DiagnosisFailure("Image import did not finish")
        marker.write_text("image-imported\n", encoding="utf-8")
        screenshot(output, "20-appearance-after-import")
        tap_exact(output, "Apply")
        marker.write_text("image-applied\n", encoding="utf-8")
        find(output, "Client settings", timeout=20, exact=True)
        time.sleep(3)
        image = screenshot(output, "21-image")
        marker.write_text("image-captured\n", encoding="utf-8")

        normalized_difference = image_compare(gradient, image, output)
        marker.write_text(f"pixel-compare-passed:{normalized_difference:.6f}\n", encoding="utf-8")
        visual = screenshot_wallpaper_metrics(image, output)
        marker.write_text("wallpaper-visible-contract-passed\n", encoding="utf-8")
        conversation_state = wait_fixture_state("/c/original", appearance=True)
        assert_fixture_glass(conversation_state, document_nonce)

        tap_fixture_control(output, "new-chat", conversation_state)
        marker.write_text("new-chat-opened\n", encoding="utf-8")
        new_chat_state = wait_fixture_state("/", appearance=True)
        assert_fixture_glass(new_chat_state, document_nonce)
        time.sleep(1)
        new_chat = screenshot(output, "30-new-chat")
        new_chat_metrics = screenshot_wallpaper_metrics(new_chat, output)
        marker.write_text("new-chat-wallpaper-passed\n", encoding="utf-8")
        tap_fixture_control(output, "restore-chat", new_chat_state)
        marker.write_text("restore-chat-opened\n", encoding="utf-8")
        restored_state = wait_fixture_state("/c/restored", appearance=True)
        assert_fixture_glass(restored_state, document_nonce)
        time.sleep(1)
        restored = screenshot(output, "40-restored-chat")
        restored_metrics = screenshot_wallpaper_metrics(restored, output)
        marker.write_text("restored-chat-wallpaper-passed\n", encoding="utf-8")
        persisted = collect_persisted_config(output)
        write_fixture_evidence(output)
        result = {
            "status": "passed",
            "source_sha": args.source_sha,
            "image_rmse": normalized_difference,
            "wallpaper_saturation": visual["saturation"],
            "wallpaper_variance": visual["variance"],
            "new_chat_saturation": new_chat_metrics["saturation"],
            "new_chat_variance": new_chat_metrics["variance"],
            "restored_chat_saturation": restored_metrics["saturation"],
            "restored_chat_variance": restored_metrics["variance"],
            "same_document": restored_state["nonce"] == document_nonce,
            "glass_surfaces_verified": True,
            "persisted_background": persisted.get("background"),
            "persisted_image": persisted.get("image"),
        }
        (output / "result.json").write_text(
            json.dumps(result, indent=2) + "\n", encoding="utf-8"
        )
        (output / "result.txt").write_text(
            "PASS: imported a local PNG through the Android system picker, "
            "applied it, proved a vivid visible page-area change on conversation, "
            "new-chat and restored pages in the Android frame, and read the "
            "persisted image-backed appearance config.\n",
            encoding="utf-8",
        )
        print("ANDROID_WALLPAPER_DIAGNOSE_PASS")
    except Exception:
        write_fixture_evidence(output)
        screenshot(output, "failure-screen")
        current = "/sdcard/wallpaper-failure.xml"
        local = output / "failure-ui.xml"
        shell(f"uiautomator dump {current}", check=False)
        adb("pull", current, str(local), check=False)
        (output / "failure-windows.txt").write_text(
            shell("dumpsys window windows", check=False) + "\n", encoding="utf-8"
        )
        (output / "failure-logcat.txt").write_text(
            adb("logcat", "-d", "-t", "3000", check=False) + "\n", encoding="utf-8"
        )
        if local.is_file():
            try:
                root = ET.fromstring(local.read_text(encoding="utf-8"))
                labels = [
                    "text=" + node.get("text", "")
                    + " desc=" + node.get("content-desc", "")
                    + " class=" + node.get("class", "").split(".")[-1]
                    + " checked=" + node.get("checked", "")
                    + " enabled=" + node.get("enabled", "")
                    for node in root.iter("node")
                    if node.get("text")
                    or node.get("content-desc")
                    or node.get("class", "").endswith(("Switch", "SwitchCompat"))
                ]
                marker = output / "progress.txt"
                progress = marker.read_text(encoding="utf-8").strip() if marker.is_file() else "unknown"
                progress = re.sub(r"[^A-Za-z0-9_.:-]", "-", progress)[:200]
                failure = DiagnosisFailure(
                    progress + " | controls: " + " || ".join(labels[-30:])
                )
                raise failure
            except ET.ParseError:
                pass
        progress_path = output / "progress.txt"
        progress = (
            progress_path.read_text(encoding="utf-8").strip()
            if progress_path.is_file()
            else "unknown"
        )
        progress = re.sub(r"[^A-Za-z0-9_.:-]", "-", progress)[:200]
        raise DiagnosisFailure(
            progress + " | failure hierarchy unavailable"
        ) from None
    finally:
        server.shutdown()
        adb("reverse", "--remove", f"tcp:{PORT}", check=False)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"ANDROID_WALLPAPER_DIAGNOSE_FAILED: {error}", flush=True)
        raise
