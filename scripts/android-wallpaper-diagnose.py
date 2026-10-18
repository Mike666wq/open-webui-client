#!/usr/bin/env python3
"""Exercise the Android wallpaper preview on a GitHub-hosted emulator."""

import argparse
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


def screenshot(output, label):
    result = command(["adb", "exec-out", "screencap", "-p"], timeout=45, text=False)
    path = output / f"{label}.png"
    path.write_bytes(result.stdout)
    return path


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        if self.path == "/api/config":
            body = b'{"status":true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path not in ("/", "/index.html"):
            self.send_error(404)
            return
        body = b"""<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; background: transparent; color: #111827; }
  #app, #app > div, #chat-container, #chat-container > div,
  #chat-container > div > div, #chat-container > div > div > div,
  #chat-pane, #messages-container { background: transparent; }
  #chat-container { min-height: 100dvh; display: flex; flex-direction: column; }
  #chat-container > div { min-height: 0; flex: 1; display: flex; flex-direction: column; }
  #chat-pane { min-height: 0; flex: 1; display: flex; flex-direction: column; }
  nav { padding: 12px 18px; background: rgba(255,255,255,.82); }
  #messages-container { min-height: 0; flex: 1; overflow: auto; padding: 18px; }
  .user-message { display: flex; justify-content: flex-end; margin: 18px 0; }
  .rounded-3xl { max-width: 88%; padding: 12px 14px; border-radius: 18px; background: rgba(255,255,255,.84); }
  #message-input-container { padding: 12px; background: rgba(255,255,255,.82); }
  #chat-input { width: 100%; min-height: 48px; border: 1px solid #64748b; border-radius: 12px; padding: 10px; }
</style></head>
<body><div id="app"><div><div id="chat-container"><div><div><div><div id="chat-pane">
  <nav><strong id="fixture-header">Wallpaper fixture 8765</strong></nav>
  <div id="messages-container">
    <div class="user-message" id="message-wallpaper-1"><div class="rounded-3xl"><div class="markdown-prose">Verify the selected local wallpaper.</div></div></div>
    <div class="user-message" id="message-wallpaper-2"><div class="rounded-3xl"><div class="markdown-prose">The image should be visible through this transparent chat surface.</div></div></div>
  </div>
  <div id="message-input-container"><textarea id="chat-input" aria-label="Message">wallpaper diagnostic</textarea></div>
</div></div></div></div></div></div></div></body></html>"""
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


def tap_node(node):
    left, top, right, bottom = bounds(node)
    shell(f"input tap {(left + right) // 2} {(top + bottom) // 2}")


def tap(output, label, *, timeout=30, exact=False):
    tap_node(find(output, label, timeout=timeout, exact=exact))


def tap_exact(output, label, *, timeout=30):
    tap(output, label, timeout=timeout, exact=True)


def tap_picker(output):
    deadline = time.monotonic() + 20
    node = None
    while time.monotonic() < deadline:
        for item in hierarchy(output, "appearance-row"):
            if item.get("text") == "Appearance & reading" or item.get("content-desc") == "Appearance & reading":
                node = item
                break
        if node is not None:
            break
        time.sleep(1)
    if node is None:
        raise DiagnosisFailure("Missing UI control: Appearance & reading")
    # A modal/dialog parent can expose a merged full-screen accessibility node
    # carrying a child button's label. Tapping that node's center would hit the
    # page underneath. The menu row is explicitly laid out beneath its heading;
    # use the nearest clickable descendant or row-center fallback.
    candidates = []
    for item in hierarchy(output, "appearance-row-candidates"):
        if "Appearance & reading" not in (
            item.get("text", ""),
            item.get("content-desc", ""),
        ):
            continue
        item_bounds = bounds(item)
        if item.get("clickable") == "true" or item.get("class", "").endswith("Button"):
            candidates.append(item)
    target = min(candidates, key=lambda item: bounds(item)[1], default=node)
    target_bounds = bounds(target)
    x = (target_bounds[0] + target_bounds[2]) // 2
    y = target_bounds[1] + min(28, (target_bounds[3] - target_bounds[1]) // 2)
    shell(f"input tap {x} {y}")


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
        for node in reversed(nodes):
            text = node.get("text", "").casefold()
            description = node.get("content-desc", "").casefold()
            if IMAGE_NAME.casefold() in text or IMAGE_NAME.casefold() in description:
                bounds(node)
                return node
        time.sleep(1)
    return None


def select_wallpaper(output):
    entry = find_image_picker_entry(output, timeout=8)
    if entry is None:
        tap_one(output, ["Downloads", "Download"], timeout=8)
        entry = find_image_picker_entry(output, timeout=18)
    if entry is None:
        tap_one(output, ["Show roots", "Show navigation drawer", "Open navigation drawer"], timeout=8)
        tap_one(output, ["Downloads", "Download"], timeout=12)
        entry = find_image_picker_entry(output, timeout=18)
    if entry is None:
        raise DiagnosisFailure(
            f"{IMAGE_NAME} was not available in the Android document picker"
        )
    tap_node(entry)


def set_slider_to_start(output, label):
    node = find(
        output,
        label,
        predicate=lambda item: item.get("class", "").endswith("SeekBar"),
    )
    left, top, right, bottom = bounds(node)
    y = (top + bottom) // 2
    shell(f"input swipe {right - 4} {y} {left + 2} {y} 250")
    time.sleep(0.4)


def enable_appearance(output):
    toggle = find(
        output,
        "Enable appearance",
        predicate=lambda item: item.get("class", "").endswith(
            ("Switch", "SwitchCompat")
        )
    )
    if toggle.get("checked") != "true":
        tap_node(toggle)


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
    ):
        raise DiagnosisFailure(f"Unexpected persisted appearance config: {parsed}")
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
    adb("reverse", f"tcp:{PORT}", f"tcp:{PORT}")
    try:
        shell(f"pm clear {PACKAGE}")
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
        find(output, "Wallpaper fixture 8765", timeout=45)
        marker.write_text("fixture-connected\n", encoding="utf-8")
        screenshot(output, "00-connected-original")

        tap_exact(output, "Client settings")
        marker.write_text("menu-opened\n", encoding="utf-8")
        tap_picker(output)
        marker.write_text("appearance-opened\n", encoding="utf-8")
        enable_appearance(output)
        marker.write_text("appearance-enabled\n", encoding="utf-8")
        set_slider_to_start(output, "Scrim (%)")
        marker.write_text("scrim-zero\n", encoding="utf-8")
        set_slider_to_start(output, "Panel opacity (%)")
        marker.write_text("opacity-zero\n", encoding="utf-8")
        tap_exact(output, "Apply")
        marker.write_text("gradient-applied\n", encoding="utf-8")
        find(output, "Wallpaper fixture 8765", timeout=20)
        time.sleep(3)
        gradient = screenshot(output, "10-gradient")
        marker.write_text("gradient-captured\n", encoding="utf-8")

        tap_exact(output, "Client settings")
        marker.write_text("menu-reopened\n", encoding="utf-8")
        tap_picker(output)
        marker.write_text("appearance-reopened\n", encoding="utf-8")
        tap(output, "Choose image (up to 20 MB)", timeout=20)
        marker.write_text("picker-opened\n", encoding="utf-8")
        select_wallpaper(output)
        marker.write_text("picker-selected\n", encoding="utf-8")

        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            text = " ".join(
                node.get("text", "") + " " + node.get("content-desc", "")
                for node in hierarchy(output, "after-image-import")
            )
            if "Importing" not in text and "Choose image" in text:
                break
            time.sleep(1)
        else:
            raise DiagnosisFailure("Image import did not finish")
        marker.write_text("image-imported\n", encoding="utf-8")
        screenshot(output, "20-appearance-after-import")
        tap_exact(output, "Apply")
        marker.write_text("image-applied\n", encoding="utf-8")
        find(output, "Wallpaper fixture 8765", timeout=20)
        time.sleep(3)
        image = screenshot(output, "21-image")
        marker.write_text("image-captured\n", encoding="utf-8")

        normalized_difference = image_compare(gradient, image, output)
        marker.write_text(f"pixel-compare-passed:{normalized_difference:.6f}\n", encoding="utf-8")
        persisted = collect_persisted_config(output)
        result = {
            "status": "passed",
            "source_sha": args.source_sha,
            "image_rmse": normalized_difference,
            "persisted_background": persisted.get("background"),
            "persisted_image": persisted.get("image"),
        }
        (output / "result.json").write_text(
            json.dumps(result, indent=2) + "\n", encoding="utf-8"
        )
        (output / "result.txt").write_text(
            "PASS: imported a local PNG through the Android system picker, "
            "applied it, proved a visible page-area pixel change, and read the "
            "persisted image-backed appearance config.\n",
            encoding="utf-8",
        )
        print("ANDROID_WALLPAPER_DIAGNOSE_PASS")
    except Exception:
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
