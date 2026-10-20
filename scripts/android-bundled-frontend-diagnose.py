#!/usr/bin/env python3
"""Inspect the real Svelte frontend inside the diagnostic Android WebView."""

import argparse
import base64
import json
import re
import subprocess
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

import websocket

PACKAGE = "local.openwebui.client"
CDP_PORT = 9222


class DiagnosisFailure(RuntimeError):
    pass


def command(argv, *, check=True, timeout=60, text=True):
    result = subprocess.run(argv, capture_output=True, text=text, timeout=timeout)
    if check and result.returncode:
        raise DiagnosisFailure(
            "Command failed "
            f"({result.returncode}): {' '.join(argv)}\n"
            f"{result.stdout or ''}\n{result.stderr or ''}"
        )
    return result


def adb(*args, check=True, timeout=60):
    return command(["adb", *args], check=check, timeout=timeout).stdout.strip()


def shell(value, *, check=True, timeout=60):
    return adb("shell", value, check=check, timeout=timeout)


def png(path):
    result = command(["adb", "exec-out", "screencap", "-p"], timeout=45, text=False)
    path.write_bytes(result.stdout)


def find(output, label, *, timeout=30, predicate=None):
    remote = "/sdcard/bundled-frontend-window.xml"
    import xml.etree.ElementTree as ET

    labels = [label] if isinstance(label, str) else list(label)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        shell("rm -f " + remote, check=False, timeout=15)
        command(
            ["adb", "shell", "uiautomator", "dump", remote],
            check=False,
            timeout=25,
        )
        result = command(
            ["adb", "exec-out", "cat", remote],
            check=False,
            timeout=20,
        )
        text = result.stdout or ""
        start = text.find("<hierarchy")
        end = text.rfind("</hierarchy>")
        if result.returncode == 0 and start >= 0 and end >= start:
            try:
                root = ET.fromstring(text[start : end + len("</hierarchy>")])
            except ET.ParseError:
                root = None
            if root is not None:
                for node in root.iter("node"):
                    values = (
                        node.get("text", "").casefold(),
                        node.get("content-desc", "").casefold(),
                    )
                    if any(candidate.casefold() in values for candidate in labels) and (
                        predicate is None or predicate(node)
                    ):
                        match = re.findall(r"-?\d+", node.get("bounds", ""))
                        if len(match) == 4 and float(match[2]) > float(match[0]):
                            return node
        time.sleep(1)
    raise DiagnosisFailure(f"Missing Android control: {labels}")


def bounds(node):
    values = list(map(int, re.findall(r"-?\d+", node.get("bounds", ""))))
    if len(values) != 4 or values[2] <= values[0] or values[3] <= values[1]:
        raise DiagnosisFailure(f"Invalid Android control bounds: {node.attrib}")
    return values


def tap(output, label, *, timeout=30, exact=True):
    labels = [label] if isinstance(label, str) else list(label)
    if exact:
        predicate = lambda node: any(
            value in (node.get("text", ""), node.get("content-desc", ""))
            for value in labels
        )
        node = find(output, label, timeout=timeout, predicate=predicate)
    else:
        node = find(output, label, timeout=timeout)
    left, top, right, bottom = bounds(node)
    shell(f"input tap {(left + right) // 2} {(top + bottom) // 2}")


def input_text(value):
    """Type text without letting spaces or shell syntax become adb commands."""
    encoded = value.replace("%", "%25").replace(" ", "%s")
    shell(f"input text {encoded}")


def wait_for_control(output, label, *, timeout=45):
    return find(output, label, timeout=timeout)


def find_any(output, labels, *, timeout=45, predicate=None):
    return find(output, labels, timeout=timeout, predicate=predicate)


def tap_any(output, labels, *, timeout=30):
    labels = list(labels)
    predicate = lambda node: any(
        value in (node.get("text", ""), node.get("content-desc", ""))
        for value in labels
    )
    node = find_any(output, labels, timeout=timeout, predicate=predicate)
    tap_bounds(bounds(node))


def tap_bounds(rect):
    left, top, right, bottom = rect
    shell(f"input tap {(left + right) // 2} {(top + bottom) // 2}")


def replace_text(output, labels, value):
    node = find_any(
        output,
        labels,
        predicate=lambda candidate: candidate.get("class", "").endswith("EditText"),
    )
    tap_bounds(bounds(node))
    shell("input keyevent KEYCODE_MOVE_END")
    shell("input keyevent " + " ".join(["KEYCODE_DEL"] * 120))
    input_text(value)
    return node


def screen_metrics():
    size_match = re.findall(r"(\d+)x(\d+)", shell("wm size"))
    density_match = re.search(r"(\d+(?:\.\d+)?)", shell("wm density"))
    if not size_match:
        raise DiagnosisFailure("Could not read the Android screen size")
    width, height = map(int, size_match[-1])
    density = float(density_match.group(1)) / 160 if density_match else 3.0
    return width, height, density


def window_evidence(output, name):
    text = shell("dumpsys window windows", check=False)
    (output / f"{name}.txt").write_text(text + "\n", encoding="utf-8")
    return text


def keyboard_visible():
    dump = shell("dumpsys input_method", check=False)
    return bool(re.search(r"mInputShown\s*=\s*true|mInputShown=true", dump))


def wait_for_keyboard(*, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if keyboard_visible():
            return True
        time.sleep(0.5)
    raise DiagnosisFailure("The Android keyboard did not become visible")


def parse_keyboard_top(dump):
    candidates = []
    for block in re.split(r"(?=Window #\d+)", dump):
        if (
            "InputMethod" not in block
            and "com.google.android.inputmethod" not in block
            and "com.android.inputmethod" not in block
        ):
            continue
        if "isVisible=true" not in block and "mHasSurface=true" not in block:
            continue
        # Some Android releases report the IME window as a full-screen
        # transparent container. Its touchable region is the visible keyboard.
        for region in re.finditer(r"touchable region=SkRegion\(\(([^)]+)\)\)", block):
            values = [int(value) for value in re.findall(r"-?\d+", region.group(1))]
            for index in range(0, len(values) - 3, 4):
                top = values[index + 1]
                if top > 0:
                    candidates.append(top)
    return min(candidates) if candidates else None


def keyboard_top():
    return parse_keyboard_top(shell("dumpsys window windows", check=False))


def wait_for_webview_debug():
    pids = shell(f"pidof {PACKAGE}", check=False).split()
    if not pids:
        raise DiagnosisFailure("The Android app process is not running")
    pid = pids[-1]
    socket_name = f"webview_devtools_remote_{pid}"
    adb("forward", f"tcp:{CDP_PORT}", f"localabstract:{socket_name}")
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        try:
            with urlopen(f"http://127.0.0.1:{CDP_PORT}/json", timeout=3) as response:
                pages = json.load(response)
            matches = [
                page
                for page in pages
                if page.get("type") == "page"
                and page.get("url", "").startswith("http://127.0.0.1:8765/")
            ]
            if matches:
                return matches[0]
        except (URLError, TimeoutError, json.JSONDecodeError):
            pass
        time.sleep(1)
    raise DiagnosisFailure(
        "The bundle WebView did not expose a debuggable CDP target"
    )


def open_cdp_socket(websocket_url):
    # WebView's DevTools endpoint rejects browser-style Origin headers. The
    # diagnostic is a raw debugger client, so do not claim a page origin.
    return websocket.create_connection(
        websocket_url,
        timeout=30,
        suppress_origin=True,
    )


class CDP:
    def __init__(self, websocket_url):
        self.ws = open_cdp_socket(websocket_url)
        self.request_id = 0

    def send(self, method, params=None, *, timeout=30):
        self.request_id += 1
        request_id = self.request_id
        self.ws.send(
            json.dumps({"id": request_id, "method": method, "params": params or {}})
        )
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.ws.settimeout(max(0.2, deadline - time.monotonic()))
            message = json.loads(self.ws.recv())
            if message.get("id") == request_id:
                if "error" in message:
                    raise DiagnosisFailure(
                        f"CDP {method} failed: {message['error']}"
                    )
                return message.get("result", {})
        raise DiagnosisFailure(f"CDP {method} timed out")

    def evaluate(self, expression):
        result = self.send(
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": True,
            },
        )
        if result.get("exceptionDetails"):
            raise DiagnosisFailure(
                "JavaScript evaluation failed: "
                + json.dumps(result["exceptionDetails"], ensure_ascii=False)
            )
        remote = result.get("result", {})
        if remote.get("subtype") == "error":
            raise DiagnosisFailure(
                f"JavaScript evaluation failed: {remote.get('description')}"
            )
        return remote.get("value")

    def screenshot(self, path):
        result = self.send("Page.captureScreenshot", {"format": "png", "fromSurface": True})
        path.write_bytes(base64.b64decode(result["data"]))

    def scroll_gesture(self, selector, *, y_ratio=0.78, distance=420, downward=True):
        rect = self.evaluate(public_rect(selector))
        if not rect or rect["width"] <= 0 or rect["height"] <= 0:
            raise DiagnosisFailure(f"Cannot scroll missing element: {selector}")
        self.send(
            "Input.synthesizeScrollGesture",
            {
                "x": int(rect["left"] + rect["width"] / 2),
                "y": int(rect["top"] + rect["height"] * y_ratio),
                "yDistance": (-abs(distance) if downward else abs(distance)),
                "speed": 900,
                "gestureSourceType": "touch",
                "repeatCount": 0,
            },
        )

    def touch_click_expression(self, expression, label):
        rect = self.evaluate(
            f"""
            (() => {{
              const element=({expression});
              if(!element) return null;
              const rect=element.getBoundingClientRect();
              if(rect.width<=0 || rect.height<=0) return null;
              return {{
                left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,
                width:rect.width,height:rect.height
              }};
            }})()
            """
        )
        if not rect:
            raise DiagnosisFailure(f"Cannot find visible page control: {label}")
        x = int(rect["left"] + rect["width"] / 2)
        y = int(rect["top"] + rect["height"] / 2)
        self.send(
            "Input.dispatchTouchEvent",
            {
                "type": "touchStart",
                "touchPoints": [{"x": x, "y": y, "radiusX": 2, "radiusY": 2}],
            },
        )
        self.send(
            "Input.dispatchTouchEvent",
            {
                "type": "touchEnd",
                "touchPoints": [],
            },
        )
        return rect

    def close(self):
        self.ws.close()


def evaluate_until(cdp, expression, *, timeout=45):
    deadline = time.monotonic() + timeout
    latest = None
    while time.monotonic() < deadline:
        latest = cdp.evaluate(expression)
        if latest:
            return latest
        time.sleep(0.5)
    raise DiagnosisFailure(f"Web page did not become ready: {latest!r}")


def wait_for_selector(cdp, selector, *, timeout=60):
    return evaluate_until(
        cdp,
        f"(() => Boolean(document.querySelector({json.dumps(selector)})))()",
        timeout=timeout,
    )


def public_rect(element):
    return (
        "{"
        "const r=(document.querySelector(" + json.dumps(element) + ")?.getBoundingClientRect());"
        "r?{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}:null"
        "}"
    )


def assert_rect_inside(name, rect, width, height, *, expected_right=None):
    if not rect:
        raise DiagnosisFailure(f"{name} is missing")
    if (
        rect["left"] < -0.5
        or rect["right"] > width + 0.5
        or rect["top"] < -0.5
        or rect["bottom"] > height + 0.5
    ):
        raise DiagnosisFailure(
            f"{name} is outside the {width}x{height} viewport: {rect}"
        )
    if expected_right is not None and abs(rect["right"] - expected_right) > 2:
        raise DiagnosisFailure(
            f"{name} does not use the expected right edge: {rect}"
        )


def bundle_state(cdp):
    return cdp.evaluate(
        """
        (async () => {
          const response = await fetch('/__fixture_provenance', {cache:'no-store'});
          const provenance = response.ok ? await response.json() : null;
          const app = Boolean(document.querySelector('.owui-mist-app'));
          const auth = Boolean(
            document.querySelector('#auth-login-card form #email') &&
            document.querySelector('#auth-login-card form #password')
          );
          return {
            app,
            auth,
            provenanceCommit: provenance?.sourceCommit ?? null,
            title: document.title,
            htmlCount: document.querySelectorAll('body *').length,
            location: location.href
          };
        })()
        """
    )


def wait_for_bundle_state(cdp, expected_frontend_sha, *, timeout=60):
    deadline = time.monotonic() + timeout
    latest = None
    while time.monotonic() < deadline:
        latest = bundle_state(cdp)
        if latest.get("provenanceCommit") != expected_frontend_sha:
            raise DiagnosisFailure(
                "The WebView was not served by the pinned API-only frontend fixture: "
                f"{latest}"
            )
        if latest.get("app") or latest.get("auth"):
            return latest
        time.sleep(0.25)
    raise DiagnosisFailure(f"The bundled Svelte application did not render: {latest}")


def sign_in_fixture(cdp):
    submitted = cdp.evaluate(
        """
        (() => {
          const form=document.querySelector('#auth-login-card form');
          const email=document.querySelector('#auth-login-card #email');
          const password=document.querySelector('#auth-login-card #password');
          if(!form || !email || !password) return false;
          const setter=Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            'value'
          ).set;
          setter.call(email,'fixture@example.invalid');
          email.dispatchEvent(new Event('input',{bubbles:true}));
          email.dispatchEvent(new Event('change',{bubbles:true}));
          setter.call(password,'fixture-password');
          password.dispatchEvent(new Event('input',{bubbles:true}));
          password.dispatchEvent(new Event('change',{bubbles:true}));
          form.requestSubmit();
          return true;
        })()
        """
    )
    if not submitted:
        raise DiagnosisFailure("The fixture sign-in form is missing")
    return submitted


def wait_bundle_ready(cdp, expected_frontend_sha):
    state = wait_for_bundle_state(cdp, expected_frontend_sha)
    if state.get("auth"):
        sign_in_fixture(cdp)
        deadline = time.monotonic() + 60
        latest = None
        while time.monotonic() < deadline:
            latest = bundle_state(cdp)
            if latest.get("app"):
                return latest
            time.sleep(0.25)
        raise DiagnosisFailure(
            "The bundled Svelte application did not render after fixture sign-in: "
            f"{latest}"
        )
    if not state.get("app"):
        raise DiagnosisFailure(f"The bundled Svelte application did not render: {state}")
    return state


def open_settings(cdp):
    # Android starts with the mobile drawer closed. Open it through the real
    # navbar control before looking for the user menu at the bottom.
    cdp.touch_click_expression(
        """
        document.querySelector('#sidebar-toggle-button') ||
        document.querySelector(
          'button[aria-label="Open Sidebar"], button[aria-label="展开侧边栏"]'
        )
        """,
        "open sidebar",
    )
    evaluate_until(
        cdp,
        """
        (() => {
          const sidebar=document.querySelector('#sidebar');
          return sidebar?.getAttribute('aria-hidden') === 'false' &&
            Boolean(document.querySelector(
              'button[aria-label="User menu"], button[aria-label="用户菜单"]'
            ));
        })()
        """,
    )
    cdp.touch_click_expression(
        """
        document.querySelector('button[aria-label="User menu"]') ||
        document.querySelector('button[aria-label="用户菜单"]')
        """,
        "user menu",
    )
    evaluate_until(
        cdp,
        """
        (() => [...document.querySelectorAll('button')]
          .some(e=>['Settings','设置'].includes(e.textContent.trim())))()
        """,
    )
    cdp.touch_click_expression(
        """
        [...document.querySelectorAll('button')]
          .find(e=>['Settings','设置'].includes(e.textContent.trim()))
        """,
        "settings",
    )
    evaluate_until(
        cdp,
        """
        (() => Boolean(
          document.querySelector('.settings-content-scroll') &&
          document.querySelector('button[aria-controls="tab-appearance"]')
        ))()
        """,
    )


def open_appearance_tab(cdp):
    cdp.touch_click_expression(
        """
        document.querySelector('button[aria-controls="tab-appearance"]')
        """,
        "appearance tab",
    )
    wait_for_selector(cdp, "#open-mist-appearance-editor")


def open_appearance_editor(cdp, *, width, height):
    open_appearance_tab(cdp)
    settings_geometry = cdp.evaluate(
        """
        (() => {
          const area=document.querySelector('.settings-content-scroll');
          const editor=document.querySelector('#open-mist-appearance-editor');
          if(!area || !editor) return null;
          const s=area.getBoundingClientRect(), e=editor.getBoundingClientRect();
          return {
            clientHeight:area.clientHeight,
            scrollHeight:area.scrollHeight,
            scrollTop:area.scrollTop,
            settings:{left:s.left,top:s.top,right:s.right,bottom:s.bottom},
            editor:{left:e.left,top:e.top,right:e.right,bottom:e.bottom}
          };
        })()
        """
    )
    if not settings_geometry:
        raise DiagnosisFailure("The appearance settings page or editor entry is missing")
    if settings_geometry["scrollHeight"] <= settings_geometry["clientHeight"] + 1:
        raise DiagnosisFailure(
            "The settings page does not have an independent scroll container: "
            f"{settings_geometry}"
        )

    def editor_is_reachable():
        value = cdp.evaluate(
            """
            (() => {
              const area=document.querySelector('.settings-content-scroll');
              const editor=document.querySelector('#open-mist-appearance-editor');
              if(!area || !editor) return null;
              const s=area.getBoundingClientRect(), e=editor.getBoundingClientRect();
              return {
                left:e.left,top:e.top,right:e.right,bottom:e.bottom,
                visible:e.bottom>s.top && e.top<s.bottom &&
                  e.left>=s.left-0.5 && e.right<=s.right+0.5 &&
                  e.top>=s.top-0.5 && e.bottom<=s.bottom+0.5,
                scrollTop:area.scrollTop
              };
            })()
            """
        )
        if not value:
            raise DiagnosisFailure("The appearance settings entry disappeared during scrolling")
        return value

    initial = editor_is_reachable()
    for _ in range(12):
        current = editor_is_reachable()
        if current["visible"]:
            break
        cdp.scroll_gesture(
            ".settings-content-scroll",
            distance=300,
            downward=current["bottom"] > settings_geometry["settings"]["bottom"],
        )
    else:
        raise DiagnosisFailure(
            f"Could not touch-scroll to the appearance editor entry: {current}"
        )
    reachable = editor_is_reachable()
    if not (
        reachable["left"] >= -0.5
        and reachable["right"] <= width + 0.5
        and reachable["top"] >= -0.5
        and reachable["bottom"] <= height + 0.5
    ):
        raise DiagnosisFailure(
            f"The appearance entry is outside the viewport: {reachable}"
        )
    touch = {
        "initial": initial,
        "reachable": reachable,
        "settings": settings_geometry,
    }

    cdp.touch_click_expression(
        "document.querySelector('#open-mist-appearance-editor')",
        "appearance editor entry",
    )
    wait_for_editor_open(cdp)
    return touch


def element_geometry(cdp, selector):
    return cdp.evaluate(
        f"""
        (() => {{
          const element=document.querySelector({json.dumps(selector)});
          if(!element) return null;
          const rect=element.getBoundingClientRect();
          return {{
            left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,
            width:rect.width,height:rect.height,
            clientHeight:element.clientHeight,scrollHeight:element.scrollHeight,
            scrollTop:element.scrollTop,
            visible:rect.bottom>0 && rect.top<innerHeight
          }};
        }})()
        """
    )


def assert_element_visible(name, geometry, width, height):
    if not geometry:
        raise DiagnosisFailure(f"{name} is missing")
    if not geometry["visible"]:
        raise DiagnosisFailure(f"{name} is not visible in the {width}x{height} viewport: {geometry}")
    if (
        geometry["left"] < -0.5
        or geometry["right"] > width + 0.5
        or geometry["top"] < -0.5
        or geometry["bottom"] > height + 0.5
    ):
        raise DiagnosisFailure(
            f"{name} is outside the {width}x{height} viewport: {geometry}"
        )


def assert_horizontal_bounds(name, rect, width):
    if not rect:
        raise DiagnosisFailure(f"{name} is missing")
    if rect["left"] < -0.5 or rect["right"] > width + 0.5:
        raise DiagnosisFailure(f"{name} crosses the {width}px viewport: {rect}")


def scroll_element_to_bottom(cdp, selector, *, attempts=16):
    before = element_geometry(cdp, selector)
    if not before or before["scrollHeight"] <= before["clientHeight"] + 1:
        raise DiagnosisFailure(f"{selector} has no real scrollable overflow: {before}")
    maximum_scroll_top = max(0, before["scrollHeight"] - before["clientHeight"])
    if before["scrollTop"] >= maximum_scroll_top - 1:
        # Chat pages intentionally open at the newest message. Treat that
        # valid end position as success instead of requiring a downward swipe
        # that the scroll container cannot accept.
        return {"before": before, "after": before, "alreadyAtBottom": True}
    previous = before["scrollTop"]
    for _ in range(attempts):
        cdp.scroll_gesture(selector, distance=360)
        time.sleep(0.25)
        current = element_geometry(cdp, selector)
        if not current:
            raise DiagnosisFailure(f"{selector} disappeared while scrolling")
        if current["scrollTop"] <= previous + 0.5:
            after = current
            break
        previous = current["scrollTop"]
    else:
        raise DiagnosisFailure(f"Could not scroll {selector} to its end")
    if after["scrollTop"] <= before["scrollTop"] + 1:
        raise DiagnosisFailure(f"Touch scrolling did not advance {selector}: {before} -> {after}")
    return {"before": before, "after": after}


def assert_editor_scroll_and_actions(cdp, *, width, height):
    scroll = scroll_element_to_bottom(cdp, ".mist-panel__body")
    body = element_geometry(cdp, ".mist-panel__body")
    footer = element_geometry(cdp, ".mist-panel__footer")
    last_group = element_geometry(cdp, ".mist-editor-group:last-of-type")
    cancel = cdp.evaluate(
        """
        (() => {
          const button=[...document.querySelectorAll('.mist-panel__footer button')]
            .find(element=>['Cancel','取消'].includes(element.textContent.trim()));
          if(!button) return null;
          const r=button.getBoundingClientRect();
          return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};
        })()
        """
    )
    apply = cdp.evaluate(
        """
        (() => {
          const button=[...document.querySelectorAll('.mist-panel__footer button')]
            .find(element=>['Apply','应用'].includes(element.textContent.trim()));
          if(!button) return null;
          const r=button.getBoundingClientRect();
          return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};
        })()
        """
    )
    for name, rect in (
        ("editor body", body),
        ("editor footer", footer),
        ("last settings group", last_group),
        ("editor cancel action", cancel),
        ("editor apply action", apply),
    ):
        assert_horizontal_bounds(name, rect, width)
        if not rect or rect["top"] < -0.5 or rect["bottom"] > height + 0.5:
            raise DiagnosisFailure(f"{name} is not reachable in the viewport: {rect}")
    if last_group["bottom"] > body["bottom"] + 1:
        raise DiagnosisFailure(
            f"The last appearance group remains clipped above the footer: {last_group} / {body}"
        )
    return {
        "scroll": scroll,
        "body": body,
        "footer": footer,
        "lastGroup": last_group,
        "cancel": cancel,
        "apply": apply,
    }


def touch_scroll_until_visible(
    cdp, scroll_selector, target_selector, *, width, height, attempts=12
):
    before = element_geometry(cdp, scroll_selector)
    if not before or before["scrollHeight"] <= before["clientHeight"] + 1:
        raise DiagnosisFailure(f"{scroll_selector} has no real scrollable overflow: {before}")
    for _ in range(attempts):
        target = element_geometry(cdp, target_selector)
        if (
            target
            and target["visible"]
            and target["top"] >= -0.5
            and target["bottom"] <= height + 0.5
            and target["left"] >= -0.5
            and target["right"] <= width + 0.5
        ):
            after = element_geometry(cdp, scroll_selector)
            if after["scrollTop"] <= before["scrollTop"]:
                raise DiagnosisFailure(
                    f"Touch scrolling did not advance {scroll_selector}: {before} -> {after}"
                )
            return {"before": before, "after": after, "target": target}
        cdp.scroll_gesture(scroll_selector)
    raise DiagnosisFailure(f"Could not touch-scroll to {target_selector}")


def wallpaper_probe(cdp):
    return cdp.evaluate(
        """
        (() => {
          const layer=document.querySelector('.mist-backdrop__layer');
          const backdrop=document.querySelector('.mist-backdrop');
          const root=document.documentElement;
          return {
            image:layer ? getComputedStyle(layer).backgroundImage : null,
            layerInline:layer?.getAttribute('style') ?? null,
            backdrop:backdrop?.className ?? null,
            kind:backdrop?.classList.contains('mist-backdrop--wallpaper') ? 'wallpaper' : 'gradient',
            appearance:root.dataset.owuiAppearance ?? null,
            viewport:[innerWidth,innerHeight]
          };
        })()
        """
    )


def import_wallpaper(cdp):
    imported = cdp.evaluate(
        """
        (async () => {
          const input=[...document.querySelectorAll('input[type=file]')]
            .find(element=>element.accept==='image/jpeg,image/png,image/webp');
          if(!input) return {ok:false,reason:'wallpaper file input missing'};

          const canvas=document.createElement('canvas');
          canvas.width=96;canvas.height=96;
          const context=canvas.getContext('2d');
          context.fillStyle='#ff5900';context.fillRect(0,0,48,48);
          context.fillStyle='#0068ff';context.fillRect(48,0,48,48);
          context.fillStyle='#16a36a';context.fillRect(0,48,48,48);
          context.fillStyle='#d7198b';context.fillRect(48,48,48,48);
          const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
          if(!blob || blob.size<100) return {ok:false,reason:'PNG encoder returned an invalid file'};

          const transfer=new DataTransfer();
          transfer.items.add(new File([blob],'fixture-wallpaper.png',{type:'image/png'}));
          input.files=transfer.files;
          input.dispatchEvent(new Event('change',{bubbles:true}));
          const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
          for(let attempt=0;attempt<80;attempt++){
            const layer=document.querySelector('.mist-backdrop__layer');
            if(layer && getComputedStyle(layer).backgroundImage.startsWith('url("blob:')) {
              return {ok:true,size:blob.size,image:getComputedStyle(layer).backgroundImage};
            }
            await sleep(50);
          }
          const toast=[...document.querySelectorAll('[data-sonner-toast]')]
            .map(element=>element.textContent.trim()).join(' | ');
          return {ok:false,reason:'preview background did not change',toast};
        })()
        """
    )
    if not imported.get("ok"):
        raise DiagnosisFailure(f"Could not import a real wallpaper into the live page: {imported}")
    return imported


def restore_wallpaper_draft(cdp, image):
    restored = cdp.evaluate(
        f"""
        (async () => {{
          const expected={json.dumps(image)};
          const select=[...document.querySelectorAll('label.mist-editor-field')]
            .find(element=>element.textContent.includes('背景类型') ||
                          element.textContent.includes('Background type'))
            ?.querySelector('select');
          if(!select) return {{ok:false,reason:'background type selector missing'}};
          select.value='gradient';
          select.dispatchEvent(new Event('change',{{bubbles:true}}));
          const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
          for(let attempt=0;attempt<40;attempt++){{
            const image=getComputedStyle(
              document.querySelector('.mist-backdrop__layer')
            ).backgroundImage;
            if(image===expected) return {{ok:true,image}};
            await sleep(50);
          }}
          return {{
            ok:false,
            reason:'cancel did not restore the previous wallpaper',
            image:getComputedStyle(document.querySelector('.mist-backdrop__layer')).backgroundImage,
            expected
          }};
        }})()
        """
    )
    if not restored.get("ok"):
        raise DiagnosisFailure(f"Wallpaper cancel did not restore state: {restored}")
    return restored


def reset_wallpaper_draft(cdp, expected_image):
    restored = cdp.evaluate(
        f"""
        (async () => {{
          const expected={json.dumps(expected_image)};
          const select=[...document.querySelectorAll('label.mist-editor-field')]
            .find(element=>element.textContent.includes('背景类型') ||
                          element.textContent.includes('Background type'))
            ?.querySelector('select');
          if(!select) return {{ok:false,reason:'background type selector missing'}};
          select.value='gradient';
          select.dispatchEvent(new Event('change',{{bubbles:true}}));
          const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
          for(let attempt=0;attempt<40;attempt++){{
            const image=getComputedStyle(
              document.querySelector('.mist-backdrop__layer')
            ).backgroundImage;
            if(image===expected) return {{ok:true,image}};
            await sleep(50);
          }}
          return {{ok:false,reason:'could not reset wallpaper draft',expected}};
        }})()
        """
    )
    if not restored.get("ok"):
        raise DiagnosisFailure(f"Could not reset wallpaper draft: {restored}")
    return restored


def settings_open(cdp):
    return cdp.evaluate(
        "(() => Boolean(document.querySelector('.settings-content-scroll')))()"
    )


def close_settings(cdp):
    cdp.touch_click_expression(
        """
        [...document.querySelectorAll('button')]
          .find(element=>['Back','返回'].includes(element.textContent.trim()))
        """,
        "close settings",
    )
    evaluate_until(
        cdp,
        "(() => !document.querySelector('.settings-content-scroll'))()",
    )


def click_editor_action(cdp, labels):
    labels = [labels] if isinstance(labels, str) else list(labels)
    cdp.touch_click_expression(
        f"""
        [...document.querySelectorAll('.mist-panel__footer button')]
          .find(element=>{json.dumps(labels)}.includes(element.textContent.trim()))
        """,
        f"appearance editor action {labels}",
    )
    wait_for_editor_closed(cdp)


def wait_for_editor_closed(cdp):
    evaluate_until(
        cdp,
        "(() => !document.querySelector('.mist-panel__body'))()",
    )


def wait_for_editor_open(cdp):
    evaluate_until(
        cdp,
        "(() => Boolean(document.querySelector('.mist-panel__body')))()",
    )


def navigate_fixture_route(cdp, path, expected_frontend_sha):
    cdp.send("Page.navigate", {"url": f"http://127.0.0.1:8765{path}"})
    evaluate_until(
        cdp,
        f"(() => location.pathname === {json.dumps(path)} && document.readyState === 'complete')()",
        timeout=60,
    )
    return wait_bundle_ready(cdp, expected_frontend_sha)


def previous_change_log(output):
    logcat = subprocess.run(
        ["adb", "logcat", "-b", "crash", "-d", "-t", "400"],
        capture_output=True,
        text=True,
        timeout=30,
    ).stdout
    (output / "crash-logcat.txt").write_text(logcat + "\n", encoding="utf-8")


def save_wallpaper_state(output, cdp, name, expected_sha):
    state = wait_bundle_ready(cdp, expected_sha)
    wallpaper = wallpaper_probe(cdp)
    payload = {"route": state, "wallpaper": wallpaper}
    (output / f"{name}.json").write_text(
        json.dumps(payload, indent=2) + "\n", encoding="utf-8"
    )
    png(output / f"{name}.png")
    return payload


def wait_for_wallpaper(cdp, kind, *, expected_image=None, timeout=45):
    deadline = time.monotonic() + timeout
    latest = None
    while time.monotonic() < deadline:
        latest = wallpaper_probe(cdp)
        if latest.get("kind") == kind:
            if expected_image is None or latest.get("image") == expected_image:
                return latest
        time.sleep(0.5)
    raise DiagnosisFailure(
        f"Wallpaper did not become {kind!r}: {latest}"
    )


def fingerprint_geometry(cdp):
    return cdp.evaluate(
        """
        (() => {
          const card=document.querySelector('.owui-assistant-card');
          if(!card) return null;
          const rect=card.getBoundingClientRect();
          const body=document.querySelector('.owui-assistant-card .markdown-prose');
          const bodyRect=body?.getBoundingClientRect() ?? null;
          const actionRects=[...document.querySelectorAll('.owui-assistant-card .buttons button')]
            .map(element=>{const r=element.getBoundingClientRect();
              return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};});
          const composer=document.querySelector('#message-input-container');
          const composerRect=composer?.getBoundingClientRect() ?? null;
          return {
            page:[document.documentElement.scrollWidth,document.documentElement.clientWidth],
            card:{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom},
            body:bodyRect ? {left:bodyRect.left,right:bodyRect.right,top:bodyRect.top,bottom:bodyRect.bottom} : null,
            actions:actionRects,
            composer:composerRect ? {
              left:composerRect.left,right:composerRect.right,
              top:composerRect.top,bottom:composerRect.bottom
            } : null,
            assistant:[...document.querySelectorAll('.owui-assistant-message')]
              .map(element=>{const r=element.getBoundingClientRect();
                return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};}),
            avatars:[...document.querySelectorAll('.owui-assistant-avatar')]
              .map(element=>{const r=element.getBoundingClientRect();
                return {display:getComputedStyle(element).display,left:r.left,right:r.right,top:r.top,bottom:r.bottom};})
          };
        })()
        """
    )


def assert_chat_layout(cdp, *, label):
    wait_for_selector(cdp, ".owui-assistant-message .owui-assistant-card")
    wait_for_selector(cdp, ".owui-assistant-card .markdown-prose")
    wait_for_selector(cdp, "#message-input-container")
    metrics = cdp.evaluate(
        """
        (() => {
          const card=document.querySelector('.owui-assistant-message .owui-assistant-card');
          const body=document.querySelector('.owui-assistant-card .markdown-prose');
          const composer=document.querySelector('#message-input-container');
          if(!card || !body || !composer) return null;
          const rect=element=>{const r=element.getBoundingClientRect();
            return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
          return {
            viewport:{width:innerWidth,height:innerHeight},
            page:{scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth},
            card:rect(card),
            body:rect(body),
            composer:rect(composer),
            actions:[...document.querySelectorAll('.owui-assistant-card .buttons button')].map(rect),
            messageList:(()=>{const e=document.querySelector('#messages-container');
              return e?{clientHeight:e.clientHeight,scrollHeight:e.scrollHeight,scrollTop:e.scrollTop}:null;})()
          };
        })()
        """
    )
    if not metrics:
        raise DiagnosisFailure(f"{label}: chat layout elements did not render")
    width = metrics["viewport"]["width"]
    if metrics["page"]["scrollWidth"] > metrics["page"]["clientWidth"] + 1:
        raise DiagnosisFailure(f"{label}: page-level horizontal overflow: {metrics['page']}")
    for name in ("card", "body", "composer"):
        assert_horizontal_bounds(f"{label} {name}", metrics[name], width)
    for index, action in enumerate(metrics["actions"]):
        assert_horizontal_bounds(f"{label} action {index}", action, width)
    composer = metrics["composer"]
    if composer["bottom"] < -0.5 or composer["top"] > metrics["viewport"]["height"] + 0.5:
        raise DiagnosisFailure(f"{label}: composer is outside the viewport: {composer}")
    message_list = metrics["messageList"]
    if message_list and message_list["scrollHeight"] > message_list["clientHeight"] + 1:
        scroll_element_to_bottom(cdp, "#messages-container")
        metrics = cdp.evaluate(
            """
            (() => {
              const card=document.querySelector('.owui-assistant-message .owui-assistant-card');
              const composer=document.querySelector('#message-input-container');
              const rect=element=>{const r=element.getBoundingClientRect();
                return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
              return {
                viewport:{width:innerWidth,height:innerHeight},
                page:{scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth},
                card:card?rect(card):null,
                composer:composer?rect(composer):null,
                actions:[...document.querySelectorAll('.owui-assistant-card .buttons button')].map(rect)
              };
            })()
            """
        )
        for index, action in enumerate(metrics["actions"]):
            assert_horizontal_bounds(f"{label} action after scroll {index}", action, width)
    return metrics


def assert_connection_panel(
    output,
    *,
    label,
    allow_scroll=True,
    connect_labels=("Connect securely", "安全连接"),
):
    width, height, density = screen_metrics()
    card = find_any(
        output,
        ["Connection form", "连接表单"],
        predicate=lambda node: node.get("content-desc") in ("Connection form", "连接表单"),
    )
    card_bounds = bounds(card)
    connect = find_any(output, list(connect_labels))
    connect_bounds = bounds(connect)
    if card_bounds[0] < 0 or card_bounds[2] > width:
        raise DiagnosisFailure(f"{label} connection card crosses the viewport: {card_bounds}")
    if connect_bounds[3] > card_bounds[3]:
        raise DiagnosisFailure(f"{label} connect action extends beyond its card")
    tail = card_bounds[3] - connect_bounds[3]
    if tail > int(108 * density):
        raise DiagnosisFailure(
            f"{label} connection card leaves a {tail / density:.1f}dp empty tail"
        )
    if card_bounds[3] > height - int(16 * density):
        if not allow_scroll:
            raise DiagnosisFailure(
                f"{label} connection card is not bottom-contained: {card_bounds}"
            )
    return {
        "screen": [width, height],
        "density": density,
        "card": card_bounds,
        "connect": connect_bounds,
        "tailDp": tail / density,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--frontend-sha", required=True)
    parser.add_argument("--fixture-provenance", required=True)
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    provenance = json.loads(Path(args.fixture_provenance).read_text(encoding="utf-8"))
    if provenance.get("sourceCommit") != args.frontend_sha:
        raise DiagnosisFailure("The fixture provenance does not match the diagnostic frontend")
    (output / "source-sha.txt").write_text(args.source_sha + "\n", encoding="utf-8")
    (output / "frontend-sha.txt").write_text(args.frontend_sha + "\n", encoding="utf-8")
    (output / "fixture-provenance.json").write_text(
        json.dumps(provenance, indent=2) + "\n", encoding="utf-8"
    )

    cdp = None
    connection_evidence = {}
    try:
        shell("settings put system font_scale 1.0")
        shell("settings put system accelerometer_rotation 0")
        shell("settings put system user_rotation 0")
        shell("settings put secure show_ime_with_hard_keyboard 1")
        adb("reverse", "tcp:8765", "tcp:8765")
        shell(f"pm clear {PACKAGE}")
        shell(f"monkey -p {PACKAGE} -c android.intent.category.LAUNCHER 1", timeout=60)
        wait_for_control(output, ["Client toolbar", "客户端顶部栏"], timeout=45)
        wait_for_control(output, ["Connection form", "连接表单"], timeout=45)
        connection_empty = assert_connection_panel(
            output, label="default connection page", allow_scroll=False
        )
        png(output / "connection-empty.png")
        address = replace_text(
            output,
            ["Server address", "服务地址"],
            "http://127.0.0.1:8765",
        )
        wait_for_keyboard()
        keyboard_panel = assert_connection_panel(
            output, label="connection page with keyboard", allow_scroll=True
        )
        window_evidence(output, "keyboard")
        ime_top = keyboard_top()
        if ime_top is None:
            raise DiagnosisFailure("Could not locate the visible IME window")
        if keyboard_panel["connect"][3] > ime_top + 3:
            raise DiagnosisFailure(
                "The native connection action is covered by the keyboard: "
                f"{keyboard_panel['connect']} / IME top {ime_top}"
            )
        png(output / "keyboard.png")
        shell("input keyevent KEYCODE_BACK")
        time.sleep(1)
        tap_any(output, ["Connect securely", "安全连接"])
        wait_for_control(output, ["Connected", "已连接"], timeout=45)
        connection_evidence = {
            "empty": connection_empty,
            "keyboard": keyboard_panel,
            "addressBounds": bounds(address),
        }
        (output / "connection-geometry.json").write_text(
            json.dumps(connection_evidence, indent=2) + "\n", encoding="utf-8"
        )

        # This debug-only diagnostic uses the app already opened above. Do not
        # launch the fixture URL externally: that can leave the app in the
        # background while a browser renders a different page.
        target = wait_for_webview_debug()
        cdp = CDP(target["webSocketDebuggerUrl"])
        cdp.send("Page.enable")
        cdp.send("Runtime.enable")
        ready = wait_bundle_ready(cdp, args.frontend_sha)
        (output / "frontend-ready.json").write_text(
            json.dumps(ready, indent=2) + "\n", encoding="utf-8"
        )

        navigate_fixture_route(cdp, "/c/layout-fixture", args.frontend_sha)
        chat_metrics = assert_chat_layout(cdp, label="layout fixture portrait")
        (output / "chat-geometry.json").write_text(
            json.dumps(chat_metrics, indent=2) + "\n", encoding="utf-8"
        )
        png(output / "chat-real-frontend.png")

        open_settings(cdp)
        settings_geometry = cdp.evaluate(
            """
            (() => {
              const area=document.querySelector('.settings-content-scroll');
              const editor=document.querySelector('#open-mist-appearance-editor');
              if(!area || !editor) return null;
              const s=area.getBoundingClientRect(), e=editor.getBoundingClientRect();
              return {
                settings:{
                  top:s.top,bottom:s.bottom,left:s.left,right:s.right,
                  clientHeight:area.clientHeight,scrollHeight:area.scrollHeight
                },
                editor:{top:e.top,bottom:e.bottom,left:e.left,right:e.right}
              };
            })()
            """
        )
        if not settings_geometry:
            raise DiagnosisFailure("The appearance settings page is missing")
        if settings_geometry["settings"]["scrollHeight"] <= settings_geometry["settings"]["clientHeight"] + 1:
            raise DiagnosisFailure(
                f"The settings page has no independent scroll area: {settings_geometry}"
            )
        (output / "settings-geometry.json").write_text(
            json.dumps(settings_geometry, indent=2) + "\n", encoding="utf-8"
        )
        png(output / "settings-real-frontend.png")

        editor_touch = open_appearance_editor(
            cdp,
            width=int(cdp.evaluate("innerWidth")),
            height=int(cdp.evaluate("innerHeight")),
        )
        editor_scroll = assert_editor_scroll_and_actions(
            cdp,
            width=int(cdp.evaluate("innerWidth")),
            height=int(cdp.evaluate("innerHeight")),
        )
        (output / "editor-scroll.json").write_text(
            json.dumps(
                {"touch": editor_touch, "scroll": editor_scroll},
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        png(output / "editor-bottom.png")

        baseline = wallpaper_probe(cdp)
        if baseline.get("kind") != "gradient":
            raise DiagnosisFailure(f"The clean appearance did not use the gradient baseline: {baseline}")
        imported = import_wallpaper(cdp)
        preview = wait_for_wallpaper(cdp, "wallpaper")
        (output / "wallpaper-preview.json").write_text(
            json.dumps({"baseline": baseline, "imported": imported, "preview": preview}, indent=2)
            + "\n",
            encoding="utf-8",
        )
        png(output / "wallpaper-preview.png")
        click_editor_action(cdp, ["Cancel", "取消"])
        cancelled = wait_for_wallpaper(
            cdp, "gradient", expected_image=baseline.get("image")
        )
        save_wallpaper_state(output, cdp, "wallpaper-cancel", args.frontend_sha)
        (output / "wallpaper-cancel-evidence.json").write_text(
            json.dumps(
                {"baseline": baseline, "cancelled": cancelled},
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

        editor_touch = open_appearance_editor(
            cdp,
            width=int(cdp.evaluate("innerWidth")),
            height=int(cdp.evaluate("innerHeight")),
        )
        import_wallpaper(cdp)
        click_editor_action(cdp, ["Apply", "应用"])
        applied = wait_for_wallpaper(cdp, "wallpaper")
        save_wallpaper_state(output, cdp, "wallpaper-applied", args.frontend_sha)
        (output / "wallpaper-applied-evidence.json").write_text(
            json.dumps({"applied": applied, "editorTouch": editor_touch}, indent=2)
            + "\n",
            encoding="utf-8",
        )
        close_settings(cdp)
        cdp.send("Page.reload", {"ignoreCache": True})
        time.sleep(2)
        wait_bundle_ready(cdp, args.frontend_sha)
        reloaded = wait_for_wallpaper(cdp, "wallpaper")
        save_wallpaper_state(output, cdp, "wallpaper-reloaded", args.frontend_sha)
        if reloaded.get("kind") != "wallpaper":
            raise DiagnosisFailure(f"Wallpaper was not restored after reload: {reloaded}")

        navigate_fixture_route(cdp, "/", args.frontend_sha)
        wait_for_selector(cdp, "#message-input-container")
        new_chat = wallpaper_probe(cdp)
        if new_chat.get("kind") != "wallpaper":
            raise DiagnosisFailure(f"Wallpaper disappeared on the new-chat page: {new_chat}")
        save_wallpaper_state(output, cdp, "wallpaper-new-chat", args.frontend_sha)

        navigate_fixture_route(cdp, "/c/layout-fixture", args.frontend_sha)
        assert_chat_layout(cdp, label="layout fixture after wallpaper")
        restored = wallpaper_probe(cdp)
        if restored.get("kind") != "wallpaper":
            raise DiagnosisFailure(f"Wallpaper disappeared on the restored chat: {restored}")
        save_wallpaper_state(output, cdp, "wallpaper-restored-chat", args.frontend_sha)

        rotation_marker = cdp.evaluate(
            "(() => { window.__diagnosisRotationMarker='kept'; return window.__diagnosisRotationMarker; })()"
        )
        shell("settings put system user_rotation 1")
        time.sleep(4)
        rotated_ready = wait_bundle_ready(cdp, args.frontend_sha)
        rotated_width = int(cdp.evaluate("innerWidth"))
        rotated_height = int(cdp.evaluate("innerHeight"))
        assert_chat_layout(cdp, label="layout fixture landscape")
        rotated = wallpaper_probe(cdp)
        marker_after_rotation = cdp.evaluate("window.__diagnosisRotationMarker")
        if marker_after_rotation != rotation_marker:
            raise DiagnosisFailure("Rotation recreated the page or lost the WebView state")
        if rotated.get("kind") != "wallpaper":
            raise DiagnosisFailure(f"Wallpaper disappeared after rotation: {rotated}")
        save_wallpaper_state(output, cdp, "rotation", args.frontend_sha)
        (output / "rotation.json").write_text(
            json.dumps(
                {
                    "viewport": [rotated_width, rotated_height],
                    "ready": rotated_ready,
                    "marker": marker_after_rotation,
                    "wallpaper": rotated,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        shell("settings put system user_rotation 0")
        time.sleep(4)
        wait_bundle_ready(cdp, args.frontend_sha)

        shell("input keyevent KEYCODE_HOME")
        time.sleep(2)
        shell(f"monkey -p {PACKAGE} -c android.intent.category.LAUNCHER 1", timeout=60)
        wait_for_control(output, ["Client toolbar", "客户端顶部栏"], timeout=30)
        resumed = wait_for_wallpaper(cdp, "wallpaper")
        save_wallpaper_state(output, cdp, "resume", args.frontend_sha)
        (output / "resume.json").write_text(
            json.dumps({"wallpaper": resumed, "marker": cdp.evaluate("window.__diagnosisRotationMarker")}, indent=2)
            + "\n",
            encoding="utf-8",
        )

        # Native chrome remains usable with large text. This is a real
        # configuration change, followed by a tap on the native settings
        # button rather than a synthetic control click.
        shell("settings put system font_scale 1.3")
        time.sleep(3)
        tap_any(output, ["Client settings", "客户端设置"])
        wait_for_control(output, ["Connection form", "连接表单"], timeout=30)
        large_font_panel = assert_connection_panel(
            output,
            label="connection page at 1.3x font",
            allow_scroll=True,
            connect_labels=["Switch server", "切换服务"],
        )
        png(output / "font_scale.png")
        window_evidence(output, "font_scale")
        (output / "font-scale.json").write_text(
            json.dumps(large_font_panel, indent=2) + "\n", encoding="utf-8"
        )
        tap_any(output, ["Close connection settings", "关闭连接设置"])
        shell("settings put system font_scale 1.0")
        time.sleep(2)

        result = {
            "status": "passed",
            "sourceSha": args.source_sha,
            "frontendSha": args.frontend_sha,
            "connection": connection_evidence,
            "device": {
                "model": shell("getprop ro.product.model", check=False),
                "sdk": shell("getprop ro.build.version.sdk", check=False),
                "release": shell("getprop ro.build.version.release", check=False),
            },
        }
        (output / "result.json").write_text(
            json.dumps(result, indent=2) + "\n", encoding="utf-8"
        )
        print("ANDROID_BUNDLED_FRONTEND_DIAGNOSE_PASS")
    except Exception:
        try:
            png(output / "failure.png")
        except Exception:
            pass
        try:
            window_evidence(output, "failure-window")
        except Exception:
            pass
        raise
    finally:
        shell("settings put system user_rotation 0", check=False)
        shell("settings put system font_scale 1.0", check=False)
        shell("settings put system accelerometer_rotation 1", check=False)
        if cdp is not None:
            cdp.close()
        previous_change_log(output)
        adb("forward", "--remove", f"tcp:{CDP_PORT}", check=False)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"ANDROID_BUNDLED_FRONTEND_DIAGNOSE_FAILED: {error}")
        raise
