# Bek. Faye icon: lowercase wordmark, Babel Sans Bold, pink on deep brown, tilted -2deg. Run: python3 make_icon.py
from PIL import Image, ImageDraw, ImageFont
import os
D = os.path.dirname(os.path.abspath(__file__))
DEEP, PINK, MAUVE = (0x53, 0x39, 0x3A), (0xC1, 0x79, 0x8D), (0x83, 0x59, 0x65)
def icon(N, out):
    S = 4 * N
    im = Image.new('RGB', (S, S), DEEP)
    f = ImageFont.truetype(D + '/fonts/BabelSans-Bold.ttf', int(S * .44))
    L = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(L)
    for i, w in enumerate(['bek.', 'faye']):
        x0, y0, x1, y1 = d.textbbox((0, 0), w, font=f)
        d.text((S * .09 - x0, S * (.15 + .39 * i) - y0), w, font=f, fill=PINK + (255,))
    L = L.rotate(2, resample=Image.BICUBIC, center=(S / 2, S / 2))  # PIL rotates CCW = CSS rotate(-2deg)
    im.paste(L, (0, 0), L)
    im.resize((N, N), Image.LANCZOS).save(out)
icon(512, D + '/icon-512.png'); icon(180, D + '/icon-180.png')
