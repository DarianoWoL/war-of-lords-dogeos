from PIL import Image, ImageDraw
import math

S = 4
N = 96
OUT = (62, 40, 20)
ORANGE = (240, 150, 60)
CREAM = (255, 240, 205)
STEEL = (190, 198, 214)
BLUE = (60, 120, 230)


def new():
    im = Image.new('RGBA', (N * S, N * S), (0, 0, 0, 0))
    return im, ImageDraw.Draw(im)


def P(v):
    return v * S


def W(v):
    return max(1, int(round(v * S)))


def head(d, cx=48, cy=56, r=26):
    # ears
    for sx in (-1, 1):
        d.polygon([(P(cx + sx * r * 0.95), P(cy - r * 0.15)), (P(cx + sx * r * 0.62), P(cy - r * 1.28)), (P(cx + sx * r * 0.12), P(cy - r * 0.78))], fill=ORANGE, outline=OUT)
        d.line([(P(cx + sx * r * 0.95), P(cy - r * 0.15)), (P(cx + sx * r * 0.62), P(cy - r * 1.28)), (P(cx + sx * r * 0.12), P(cy - r * 0.78))], fill=OUT, width=W(2.2))
        d.polygon([(P(cx + sx * r * 0.78), P(cy - r * 0.4)), (P(cx + sx * r * 0.62), P(cy - r * 0.98)), (P(cx + sx * r * 0.3), P(cy - r * 0.68))], fill=(255, 190, 170))
    d.ellipse([P(cx - r), P(cy - r * 0.85), P(cx + r), P(cy + r * 0.85)], fill=ORANGE, outline=OUT, width=W(2.5))
    # cream muzzle
    d.ellipse([P(cx - r * 0.7), P(cy - r * 0.05), P(cx + r * 0.7), P(cy + r * 0.8)], fill=CREAM)
    d.ellipse([P(cx - r * 0.55), P(cy - r * 0.62), P(cx - r * 0.12), P(cy - r * 0.05)], fill=CREAM)
    d.ellipse([P(cx + r * 0.12), P(cy - r * 0.62), P(cx + r * 0.55), P(cy - r * 0.05)], fill=CREAM)
    for sx in (-1, 1):
        ex = cx + sx * r * 0.33
        d.ellipse([P(ex - 3.4), P(cy - r * 0.38 - 3.4), P(ex + 3.4), P(cy - r * 0.38 + 3.4)], fill=OUT)
        d.ellipse([P(ex - 1.2), P(cy - r * 0.38 - 2.2), P(ex + 0.2), P(cy - r * 0.38 - 0.9)], fill=(255, 255, 255))
    d.ellipse([P(cx - 5), P(cy + r * 0.12), P(cx + 5), P(cy + r * 0.12 + 7)], fill=OUT)
    d.arc([P(cx - 8), P(cy + r * 0.18), P(cx), P(cy + r * 0.18 + 10)], 0, 180, fill=OUT, width=W(1.8))
    d.arc([P(cx), P(cy + r * 0.18), P(cx + 8), P(cy + r * 0.18 + 10)], 0, 180, fill=OUT, width=W(1.8))


def helmet(d, cx=48, cy=56, r=26):
    d.pieslice([P(cx - r * 0.95), P(cy - r * 1.0), P(cx + r * 0.95), P(cy + r * 0.5)], 180, 360, fill=STEEL, outline=OUT, width=W(2.4))
    d.rectangle([P(cx - r * 0.95), P(cy - r * 0.28), P(cx + r * 0.95), P(cy - r * 0.16)], fill=(150, 160, 180), outline=OUT, width=W(1.5))
    d.polygon([(P(cx), P(cy - r * 1.28)), (P(cx - 5), P(cy - r * 0.9)), (P(cx + 5), P(cy - r * 0.9))], fill=(226, 74, 74), outline=OUT)


def spear(d):
    d.line([(P(78), P(92)), (P(78), P(16))], fill=(139, 90, 43), width=W(4))
    d.polygon([(P(78), P(6)), (P(72), P(22)), (P(84), P(22))], fill=STEEL, outline=OUT)
    d.line([(P(78), P(6)), (P(72), P(22)), (P(84), P(22)), (P(78), P(6))], fill=OUT, width=W(2))


def shield(d):
    pts = [(P(14), P(58)), (P(44), P(58)), (P(44), P(80)), (P(29), P(94)), (P(14), P(80))]
    d.polygon(pts, fill=BLUE, outline=OUT)
    d.line(pts + [pts[0]], fill=OUT, width=W(2.5))
    d.line([(P(29), P(60)), (P(29), P(90))], fill=(255, 214, 64), width=W(3))
    d.line([(P(16), P(70)), (P(42), P(70))], fill=(255, 214, 64), width=W(3))


def axe(d):
    d.line([(P(20), P(94)), (P(78), P(30))], fill=(139, 90, 43), width=W(5))
    d.polygon([(P(70), P(14)), (P(92), P(30)), (P(80), P(46)), (P(66), P(34))], fill=STEEL, outline=OUT)
    d.line([(P(70), P(14)), (P(92), P(30)), (P(80), P(46)), (P(66), P(34)), (P(70), P(14))], fill=OUT, width=W(2.2))


def scout(d, cx=48, cy=56, r=26):
    d.pieslice([P(cx - r * 0.95), P(cy - r * 1.05), P(cx + r * 0.95), P(cy + r * 0.45)], 180, 360, fill=(60, 170, 90), outline=OUT, width=W(2.4))
    d.polygon([(P(cx - r * 0.95), P(cy - r * 0.3)), (P(cx - r * 1.5), P(cy - r * 0.15)), (P(cx - r * 0.7), P(cy - r * 0.05))], fill=(40, 140, 70), outline=OUT)
    d.line([(P(cx + r * 0.2), P(cy - r * 1.05)), (P(cx + r * 0.8), P(cy - r * 1.5))], fill=(255, 255, 255), width=W(3))
    # scarf
    d.rectangle([P(cx - r * 0.85), P(cy + r * 0.6), P(cx + r * 0.85), P(cy + r * 0.85)], fill=(226, 74, 74), outline=OUT, width=W(1.8))
    d.line([(P(8), P(88)), (P(30), P(78))], fill=OUT, width=W(3))
    d.polygon([(P(8), P(88)), (P(30), P(78)), (P(24), P(92))], fill=STEEL, outline=OUT)


def horse(d):
    # brown horse head at the bottom, shiba rides on top
    d.polygon([(P(8), P(96)), (P(10), P(66)), (P(26), P(60)), (P(40), P(70)), (P(52), P(96))], fill=(150, 96, 50), outline=OUT)
    d.line([(P(8), P(96)), (P(10), P(66)), (P(26), P(60)), (P(40), P(70)), (P(52), P(96))], fill=OUT, width=W(2.4))
    d.ellipse([P(30), P(68), P(34), P(72)], fill=OUT)
    d.polygon([(P(12), P(60)), (P(8), P(48)), (P(20), P(56))], fill=(150, 96, 50), outline=OUT)
    d.polygon([(P(18), P(62)), (P(20), P(48)), (P(28), P(60))], fill=(110, 66, 30), outline=OUT)


def ram(d):
    d.rectangle([P(6), P(70), P(92), P(86)], fill=(139, 90, 43), outline=OUT, width=W(2.5))
    for x in (22, 50, 74):
        d.line([(P(x), P(70)), (P(x), P(86))], fill=(110, 66, 30), width=W(2))
    d.polygon([(P(92), P(66)), (P(100), P(78)), (P(92), P(90))], fill=STEEL, outline=OUT)
    d.ellipse([P(10), P(82), P(26), P(98)], fill=(90, 56, 28), outline=OUT, width=W(2))
    d.ellipse([P(68), P(82), P(84), P(98)], fill=(90, 56, 28), outline=OUT, width=W(2))


def crown(d, cx=48, cy=56, r=26):
    y0 = cy - r * 0.95
    pts = [(P(cx - r * 0.72), P(y0 + 4)), (P(cx - r * 0.76), P(y0 - 16)), (P(cx - r * 0.38), P(y0 - 4)), (P(cx), P(y0 - 22)), (P(cx + r * 0.38), P(y0 - 4)), (P(cx + r * 0.76), P(y0 - 16)), (P(cx + r * 0.72), P(y0 + 4))]
    d.polygon(pts, fill=(255, 205, 50), outline=OUT)
    d.line(pts + [pts[0]], fill=OUT, width=W(2.4))
    for x, y in ((cx - r * 0.76, y0 - 16), (cx, y0 - 22), (cx + r * 0.76, y0 - 16)):
        d.ellipse([P(x - 3.2), P(y - 3.2), P(x + 3.2), P(y + 3.2)], fill=(226, 74, 74), outline=OUT)
    # cape collar
    d.polygon([(P(cx - r * 0.9), P(cy + r * 0.62)), (P(cx + r * 0.9), P(cy + r * 0.62)), (P(cx + r * 1.15), P(cy + r * 1.15)), (P(cx - r * 1.15), P(cy + r * 1.15))], fill=(200, 40, 50), outline=OUT)


def make(name, parts):
    im, d = new()
    for fn in parts:
        fn(d)
    im.resize((N, N), Image.LANCZOS).save(f'E:/Gry/WoL-Doge/public/assets/unit-{name}.png')
    return im.resize((N, N), Image.LANCZOS)


icons = {
    'archer': [spear, head, helmet],
    'shield': [head, helmet, shield],
    'axe': [head, helmet, axe],
    'scout': [head, scout],
    'cavalry': [horse, head, helmet, spear],
    'ram': [ram, head],
    'lord': [head, crown],
}
sheet = Image.new('RGBA', (N * 7, N), (255, 246, 214, 255))
for i, (k, parts) in enumerate(icons.items()):
    im = make(k, parts)
    sheet.alpha_composite(im, (i * N, 0))
sheet.save('E:/Gry/WoL-Doge/runtime/mapa/icons-preview.png')
print('ok')
