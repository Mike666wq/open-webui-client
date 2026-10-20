import importlib.util
import pathlib
import sys
import types
import unittest


WEBSOCKET = types.ModuleType("websocket")
WEBSOCKET_OPTIONS = {}


def create_connection(url, **options):
    WEBSOCKET_OPTIONS.update({"url": url, **options})
    return object()


WEBSOCKET.create_connection = create_connection
sys.modules["websocket"] = WEBSOCKET
SCRIPT = pathlib.Path(__file__).with_name("android-bundled-frontend-diagnose.py")
SPEC = importlib.util.spec_from_file_location("android_bundled_frontend_diagnose", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class KeyboardGeometryTest(unittest.TestCase):
    def test_uses_ime_touchable_region_when_window_is_full_screen(self):
        dump = """
  Window #7 Window{4afd0af u0 InputMethod}:
    package=com.google.android.inputmethod.latin
    touchable region=SkRegion((0,1048,1080,1920))
    mHasSurface=true isReadyForDisplay()=true
    Frames: parent=[0,0][1080,1920] display=[0,0][1080,1920] frame=[0,0][1080,1920]
    isOnScreen=true
    isVisible=true
"""
        self.assertEqual(MODULE.parse_keyboard_top(dump), 1048)

    def test_does_not_treat_a_full_screen_ime_container_as_the_keyboard(self):
        dump = """
  Window #7 Window{4afd0af u0 InputMethod}:
    package=com.google.android.inputmethod.latin
    mHasSurface=true isReadyForDisplay()=true
    Frames: parent=[0,0][1080,1920] display=[0,0][1080,1920] frame=[0,0][1080,1920]
    isOnScreen=true
    isVisible=true
"""
        self.assertIsNone(MODULE.parse_keyboard_top(dump))

    def test_cdp_socket_suppresses_the_browser_origin_header(self):
        MODULE.open_cdp_socket("ws://127.0.0.1:9222/devtools/page/example")
        self.assertEqual(
            WEBSOCKET_OPTIONS,
            {
                "url": "ws://127.0.0.1:9222/devtools/page/example",
                "timeout": 30,
                "suppress_origin": True,
            },
        )


if __name__ == "__main__":
    unittest.main()
