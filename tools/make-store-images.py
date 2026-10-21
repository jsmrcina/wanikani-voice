"""Renders store images that come from the add-on itself, so they can be
remade when the UI changes (dev-time only; needs Pillow, selenium, Chromium
and chromedriver):

    python tools/make-store-images.py

- store/screenshots/5-settings.png (1280x800): the real settings page,
  rendered in headless Chromium through the test harness
  (test/options/index.html, default settings), under a heading. It is cut
  in two at a section boundary and shown as two columns, so it fits.
- store/promo-440x280.png: the Chrome Web Store's small promo tile (required;
  no text, works on a light grey page).
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
    """The settings page (its <main>) as rendered by Chromium, 2x scale, and
    where to cut it in two: the section boundary nearest its middle."""
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(ROOT), **kw)

        def log_message(self, *a):
            pass
    server = socketserver.TCPServer(("127.0.0.1", 0), Quiet)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    opts = webdriver.ChromeOptions()
    opts.binary_location = shutil.which("chromium")
    for flag in ("--headless=new", "--window-size=400,3000", "--force-device-scale-factor=2",
                 "--hide-scrollbars", "--force-color-profile=srgb"):
        opts.add_argument(flag)
    driver = webdriver.Chrome(options=opts, service=Service(shutil.which("chromedriver")))
    try:
        driver.get(f"http://127.0.0.1:{server.server_address[1]}/test/options/index.html")
        main = driver.find_element(By.TAG_NAME, "main")
        driver.implicitly_wait(5)
        driver.find_element(By.CSS_SELECTOR, ".model-row .model-status:not(:empty)")
        img = Image.open(io.BytesIO(main.screenshot_as_png)).convert("RGB")
        tops = driver.execute_script(
            "const m = arguments[0].getBoundingClientRect().top;"
            "return [...arguments[0].querySelectorAll('fieldset')]"
            ".map(f => f.getBoundingClientRect().top - m);", main)
        cut = min(tops, key=lambda t: abs(t * 2 - img.height / 2)) * 2
        return img, round(cut) - 8
    finally:
        driver.quit()
        server.shutdown()


def settings_screenshot():
    img = gradient(1280, 800)
    draw = ImageDraw.Draw(img)
    title = ImageFont.truetype(FONT.format("Bold"), 46)
    sub = ImageFont.truetype(FONT.format("Regular"), 28)
    draw.text((640, 64), "Push-to-talk or hands-free", font=title, fill=TITLE, anchor="mm")
    draw.text((640, 121), "Auto-submit, auto-advance, ignore a slip, choices, WaniKani dictionary",
              font=sub, fill=SUBTITLE, anchor="mm")
    panel, cut = settings_panel()
    columns = [panel.crop((0, 0, panel.width, cut)), panel.crop((0, cut, panel.width, panel.height))]
    gap = 40
    scale = min(612 / max(c.height for c in columns), (1200 - gap) / 2 / panel.width)
    columns = [c.resize((round(c.width * scale), round(c.height * scale)), Image.LANCZOS) for c in columns]
    x = (1280 - 2 * columns[0].width - gap) // 2
    for col in columns:
        draw.rectangle((x - 1, 179, x + col.width, 180 + col.height), outline=(214, 208, 228))
        img.paste(col, (x, 180))
        x += col.width + gap
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


if __name__ == "__main__":
    settings_screenshot()
    promo_tile()
