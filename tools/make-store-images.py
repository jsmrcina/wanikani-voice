"""Renders store images that come from the add-on itself, so they can be
remade when the UI changes (dev-time only; needs Pillow, selenium, Chromium
and chromedriver):

    python tools/make-store-images.py

- store/screenshots/5-settings.png (1280x800): the real settings page,
  rendered in headless Chromium through the test harness
  (test/options/index.html, default settings), under a heading.
- store/promo-440x280.png: the Chrome Web Store's small promo tile (required;
  no text, works on a light grey page).
- store/icon-300.png: Microsoft Edge Add-ons' store logo.
"""
import http.server
import io
import shutil
import socketserver
import subprocess
import threading
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By

ROOT = Path(__file__).resolve().parent.parent
FONT = "/usr/share/fonts/noto/NotoSans-{}.ttf"
TOP, BOTTOM = (244, 238, 255), (253, 240, 248)  # the background gradient
TITLE, SUBTITLE = (42, 33, 64), (93, 86, 114)


def gradient(w, h):
    img = Image.new("RGB", (w, h))
    draw = ImageDraw.Draw(img)
    for y in range(h):
        t = y / (h - 1)
        draw.line([(0, y), (w, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)))
    return img


def settings_panel():
    """The settings page (its <main>) as rendered by Chromium, 2x scale."""
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(ROOT), **kw)

        def log_message(self, *a):
            pass
    server = socketserver.TCPServer(("127.0.0.1", 0), Quiet)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    opts = webdriver.ChromeOptions()
    opts.binary_location = shutil.which("chromium")
    for flag in ("--headless=new", "--window-size=400,1400", "--force-device-scale-factor=2",
                 "--hide-scrollbars", "--force-color-profile=srgb"):
        opts.add_argument(flag)
    driver = webdriver.Chrome(options=opts, service=Service(shutil.which("chromedriver")))
    try:
        driver.get(f"http://127.0.0.1:{server.server_address[1]}/test/options/index.html")
        main = driver.find_element(By.TAG_NAME, "main")
        driver.implicitly_wait(5)
        driver.find_element(By.CSS_SELECTOR, ".model-row .model-status:not(:empty)")
        return Image.open(io.BytesIO(main.screenshot_as_png)).convert("RGB")
    finally:
        driver.quit()
        server.shutdown()


def settings_screenshot():
    img = gradient(1280, 800)
    draw = ImageDraw.Draw(img)
    title = ImageFont.truetype(FONT.format("Bold"), 46)
    sub = ImageFont.truetype(FONT.format("Regular"), 28)
    draw.text((640, 64), "Push-to-talk or hands-free", font=title, fill=TITLE, anchor="mm")
    draw.text((640, 121), "Auto-submit, auto-advance, English speed, custom models", font=sub, fill=SUBTITLE, anchor="mm")
    panel = settings_panel()
    scale = min(612 / panel.height, 420 / panel.width)
    panel = panel.resize((round(panel.width * scale), round(panel.height * scale)), Image.LANCZOS)
    x, y = (1280 - panel.width) // 2, 180
    draw.rectangle((x - 1, y - 1, x + panel.width, y + panel.height), outline=(214, 208, 228))
    img.paste(panel, (x, y))
    out = ROOT / "store/screenshots/5-settings.png"
    img.save(out, optimize=True)
    print("wrote", out.relative_to(ROOT))


def promo_tile():
    img = gradient(440, 280)
    png = subprocess.run(["rsvg-convert", "-w", "168", "-h", "168", str(ROOT / "icons/icon.svg")],
                         check=True, capture_output=True).stdout
    icon = Image.open(io.BytesIO(png)).convert("RGBA")
    img.paste(icon, ((440 - icon.width) // 2, (280 - icon.height) // 2), icon)
    out = ROOT / "store/promo-440x280.png"
    img.save(out, optimize=True)
    print("wrote", out.relative_to(ROOT))


def edge_logo():
    subprocess.run(["rsvg-convert", "-w", "300", "-h", "300", str(ROOT / "icons/icon.svg"),
                    "-o", str(ROOT / "store/icon-300.png")], check=True)
    print("wrote store/icon-300.png")


if __name__ == "__main__":
    settings_screenshot()
    promo_tile()
    edge_logo()
