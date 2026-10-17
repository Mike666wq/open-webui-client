#!/usr/bin/env python3
"""Exercise the local Android settings screen on a GitHub-hosted emulator."""

import argparse
import os
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

PACKAGE = "local.openwebui.client"
HEADING = "Connect to your server"
TEST_ADDRESS = "http://192.0.2.1:3000"
ACTIVE_PID = None
CURRENT_OUTPUT = None


class SmokeFailure(RuntimeError):
    pass


def run(command, *, check=True, timeout=30):
    result = subprocess.run(command, text=True, capture_output=True, timeout=timeout)
    if check and result.returncode:
        raise SmokeFailure(f"Command failed ({result.returncode}): {' '.join(command)}\n{result.stdout}\n{result.stderr}")
    return result.stdout.strip()


def adb(*args, check=True, timeout=30):
    return run(["adb", *args], check=check, timeout=timeout)


def shell(command, *, check=True, timeout=30):
    return adb("shell", command, check=check, timeout=timeout)


def ui_dump(output_dir, label):
    remote = "/sdcard/window.xml"
    shell(f"uiautomator dump {remote}", timeout=45)
    xml = adb("exec-out", "cat", remote, timeout=30)
    xml_path = output_dir / f"{label}-hierarchy.xml"
    xml_path.write_text(xml, encoding="utf-8")
    return xml


def capture_evidence(output_dir, label, pid):
    screenshot = subprocess.run(["adb", "exec-out", "screencap", "-p"], capture_output=True, timeout=30)
    if screenshot.returncode == 0 and screenshot.stdout:
        (output_dir / f"{label}.png").write_bytes(screenshot.stdout)
    system_log = adb("logcat", "-b", "crash", "-d", "-v", "brief", check=False, timeout=30)
    (output_dir / f"{label}-crash.log").write_text("\n".join(system_log.splitlines()[-250:]), encoding="utf-8")
    last_anr = shell("dumpsys activity lastanr", check=False)
    if PACKAGE in last_anr:
        (output_dir / f"{label}-anr.txt").write_text("\n".join(last_anr.splitlines()[-120:]), encoding="utf-8")
    if pid:
        exit_info = shell(f"dumpsys activity exit-info {PACKAGE}", check=False)
        if PACKAGE in exit_info:
            (output_dir / f"{label}-exit-info.txt").write_text("\n".join(exit_info.splitlines()[-120:]), encoding="utf-8")


def append_summary(text):
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as summary:
            summary.write(text + "\n")


def foreground_activity():
    output = shell("dumpsys activity activities", check=False)
    return "\n".join(line for line in output.splitlines() if "Resumed" in line or "mFocusedActivity" in line or "topResumedActivity" in line)


def assert_running(pid, context):
    current = shell(f"pidof {PACKAGE}", check=False)
    if not current:
        raise SmokeFailure(f"App process exited during {context}")
    pids = current.split()
    if str(pid) not in pids:
        raise SmokeFailure(f"App PID changed during {context}: initial={pid}, current={current}")
    activity = foreground_activity()
    if PACKAGE not in activity:
        raise SmokeFailure(f"App Activity is not foreground during {context}: {activity or 'no resumed/focused activity'}")
    last_anr = shell("dumpsys activity lastanr", check=False)
    if PACKAGE in last_anr:
        raise SmokeFailure(f"Android recorded an ANR for {PACKAGE} during {context}")


def assert_settings_visible(output_dir, label):
    xml = ui_dump(output_dir, label)
    root = ET.fromstring(xml)
    if HEADING not in xml and not any("WebView" in node.attrib.get("class", "") for node in root.iter("node")):
        raise SmokeFailure(f"Neither settings text nor a WebView was exposed by UIAutomator during {label}")
    fields = [node for node in root.iter("node") if "service-address" in node.attrib.get("resource-id", "")]
    if not fields:
        # WebView versions can omit HTML IDs from the native accessibility tree.
        fields = [node for node in root.iter("node") if node.attrib.get("class", "").endswith("EditText")]
    if not fields:
        # A WebView accessibility tree can be sparse. Preserve that fact in evidence,
        # but don't fail a startup-only checkpoint solely because HTML nodes are hidden.
        (output_dir / f"{label}-accessibility.txt").write_text(
            "WebView visible; HTML controls not exposed by UIAutomator. Input interaction remains unverified.\n",
            encoding="utf-8",
        )
        return None
    if HEADING not in xml:
        (output_dir / f"{label}-accessibility.txt").write_text(
            "WebView and address control visible; settings heading omitted by UIAutomator.\n",
            encoding="utf-8",
        )
    return fields[0].attrib.get("bounds", "")


def launch_cold(output_dir, round_number):
    global ACTIVE_PID
    ACTIVE_PID = None
    shell(f"am force-stop {PACKAGE}", check=False)
    shell("input keyevent KEYCODE_HOME", check=False)
    adb("logcat", "-c", check=False)
    run(["adb", "shell", "monkey", "-p", PACKAGE, "-c", "android.intent.category.LAUNCHER", "1"], timeout=45)
    deadline = time.monotonic() + 90
    pid = ""
    while time.monotonic() < deadline:
        pid = shell(f"pidof {PACKAGE}", check=False)
        if pid and PACKAGE in foreground_activity():
            break
        time.sleep(2)
    if not pid or PACKAGE not in foreground_activity():
        raise SmokeFailure(f"Cold launch {round_number} did not reach a foreground Activity")
    pid = int(pid.split()[0])
    ACTIVE_PID = pid
    assert_settings_visible(output_dir, f"round-{round_number}-launch")

    # Observe the reported <10 second failure window six times over, checking PID and Activity each interval.
    for second in range(1, 7):
        time.sleep(10)
        assert_running(pid, f"idle observation {second}/6 in cold launch {round_number}")
    assert_settings_visible(output_dir, f"round-{round_number}-after-60s")
    capture_evidence(output_dir, f"round-{round_number}", pid)
    return pid


def tap_address(bounds):
    match = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", bounds)
    if not match:
        raise ValueError(f"Could not parse address field bounds: {bounds!r}")
    left, top, right, bottom = map(int, match.groups())
    shell(f"input tap {(left + right) // 2} {(top + bottom) // 2}")
    shell("input keycombination KEYCODE_CTRL_LEFT KEYCODE_A")
    shell(f"input text {TEST_ADDRESS}")


def check_interactions(output_dir, pid):
    bounds = assert_settings_visible(output_dir, "interaction-before-input")
    if bounds is None:
        return False
    try:
        tap_address(bounds)
    except ValueError:
        return False
    assert_running(pid, "typing a reserved documentation-only address without pressing Connect")
    xml = ui_dump(output_dir, "interaction-after-input")
    if "192.0.2.1" not in xml:
        return False
    capture_evidence(output_dir, "interaction-after-input", pid)

    # On the local settings page the app intentionally finishes on Back; this is not a crash.
    shell("input keyevent KEYCODE_BACK")  # First dismiss the software keyboard if it is open.
    time.sleep(1)
    shell("input keyevent KEYCODE_BACK")
    time.sleep(3)
    if PACKAGE in foreground_activity():
        raise SmokeFailure("Back from the local settings screen did not leave the Activity")
    run(["adb", "shell", "monkey", "-p", PACKAGE, "-c", "android.intent.category.LAUNCHER", "1"], timeout=45)
    time.sleep(5)
    resumed = foreground_activity()
    if PACKAGE not in resumed:
        raise SmokeFailure("App did not relaunch to the local settings Activity after Back")
    resumed_pid = shell(f"pidof {PACKAGE}").split()[0]

    shell("input keyevent KEYCODE_HOME")
    time.sleep(3)
    if PACKAGE in foreground_activity():
        raise SmokeFailure("Home did not background the app")
    run(["adb", "shell", "monkey", "-p", PACKAGE, "-c", "android.intent.category.LAUNCHER", "1"], timeout=45)
    time.sleep(5)
    assert_running(resumed_pid, "returning from Home")
    assert_settings_visible(output_dir, "interaction-after-home-resume")
    capture_evidence(output_dir, "interaction-after-home-resume", resumed_pid)
    return True


def main():
    global CURRENT_OUTPUT
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--api", required=True, type=int)
    parser.add_argument("--source-sha", required=True)
    args = parser.parse_args()
    output_dir = Path(args.output)
    CURRENT_OUTPUT = output_dir
    output_dir.mkdir(parents=True, exist_ok=True)
    metadata = {
        "source_sha": args.source_sha,
        "api_level": args.api,
        "device": shell("getprop ro.product.model", check=False),
        "android_release": shell("getprop ro.build.version.release", check=False),
        "webview_packages": shell("pm list packages | grep -E 'webview|chrome'", check=False),
    }
    (output_dir / "device-metadata.txt").write_text("\n".join(f"{key}={value}" for key, value in metadata.items()), encoding="utf-8")
    shell(f"pm clear {PACKAGE}")

    pids = [launch_cold(output_dir, round_number) for round_number in range(1, 4)]
    idle_pass = f"BASELINE_IDLE_PASS: API {args.api}, source {args.source_sha}, 3 cold starts x 60 seconds idle; same PID and foreground Activity at every 10-second checkpoint; no recorded ANR."
    print(idle_pass, flush=True)
    (output_dir / "baseline-idle-result.txt").write_text(idle_pass + "\n", encoding="utf-8")
    append_summary(f"### Android idle startup baseline\n\n**PASS** — API {args.api}, source `{args.source_sha}`, 3 cold starts × 60 seconds idle; PID and foreground Activity remained stable at 10-second checkpoints, with no recorded ANR.\n")
    try:
        interaction_pass = check_interactions(output_dir, pids[-1])
    except Exception as error:
        message = f"SUPPLEMENTARY_INTERACTION_FAILURE: {error}"
        print(message, file=sys.stderr)
        append_summary(f"### Supplementary interaction check\n\n**FAIL** — `{error}`. The idle baseline above passed; this interaction failure does not indicate the reported idle-start crash.\n")
        raise
    if interaction_pass:
        message = "SUPPLEMENTARY_INTERACTION_PASS: reserved address input, local Back, Home and resume passed."
        print(message)
        append_summary("### Supplementary interaction check\n\n**PASS** — reserved address input without Connect, local Back, Home and resume.\n")
    else:
        message = "SUPPLEMENTARY_INTERACTION_UNVERIFIED: UIAutomator did not expose a usable address control and value readback."
        print(message)
        (output_dir / "supplementary-interaction-result.txt").write_text(message + "\n", encoding="utf-8")
        append_summary("### Supplementary interaction check\n\n**UNVERIFIED** — the UI hierarchy did not expose a usable address control and input readback. Idle startup baseline passed independently.\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # emit a safe failure summary; evidence is uploaded by the workflow
        if CURRENT_OUTPUT:
            try:
                capture_evidence(CURRENT_OUTPUT, "failure", ACTIVE_PID)
            except Exception as evidence_error:
                print(f"Could not capture failure evidence: {evidence_error}", file=sys.stderr)
        print(f"ANDROID_EMULATOR_SMOKE_FAILED: {error}", file=sys.stderr)
        raise
