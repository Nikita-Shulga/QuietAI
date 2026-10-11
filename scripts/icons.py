"""Render the Quiet AI mark: a sun setting on a horizon. Standard library only."""
import math, struct, zlib
from pathlib import Path

def mix(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(4))

def over(dst, src):
    a = src[3] / 255
    return tuple(src[i] * a + dst[i] * (1 - a) for i in range(3)) + (min(255, src[3] + dst[3] * (1 - a)),)

def sample(px, py):
    color = (0., 0., 0., 0.)
    # Plate: squircle-ish rounded square with a faint top-down sheen.
    dx, dy = max(abs(px - 256) - 128, 0), max(abs(py - 256) - 128, 0)
    if dx * dx + dy * dy <= 112 * 112:
        color = mix((34, 34, 38, 255), (14, 14, 16, 255), py / 512)
    # Sun: a cap setting below the horizon, warm gradient.
    if py <= 278 and math.hypot(px - 256, py - 316) <= 128:
        color = over(color, mix((255, 208, 122, 255), (242, 132, 34, 255), (py - 188) / 90))
    # Horizon and its reflection: rounded lines, a little dimmer.
    for y0, x0, x1, alpha in ((300, 112, 400, 235), (334, 176, 336, 120)):
        t = max(0, min(1, (px - x0) / (x1 - x0)))
        if math.hypot(px - (x0 + (x1 - x0) * t), py - y0) <= 8:
            color = over(color, (246, 156, 52, alpha))
    return color

def render(size):
    rows = bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            acc = [0., 0., 0., 0.]
            for ox, oy in ((.25, .25), (.75, .25), (.25, .75), (.75, .75)):
                c = sample((x + ox) * 512 / size, (y + oy) * 512 / size)
                for i in range(4): acc[i] += c[i] / 4
            rows.extend(max(0, min(255, round(c))) for c in acc)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows, 9)) + chunk(b'IEND', b'')

def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))

def render_tray(size):
    """The same sunset mark without its plate, for a macOS template image."""
    rows = bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            covered = 0
            for ox, oy in ((.25, .25), (.75, .25), (.25, .75), (.75, .75)):
                px, py = 96 + (x + ox) * 320 / size, 116 + (y + oy) * 320 / size
                inside = py <= 278 and math.hypot(px - 256, py - 316) <= 128
                for y0, x0, x1 in ((300, 112, 400), (334, 176, 336)):
                    closest = max(x0, min(x1, px))
                    inside |= math.hypot(px - closest, py - y0) <= 8
                covered += inside
            rows.extend((0, 0, 0, round(covered * 255 / 4)))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows, 9)) + chunk(b'IEND', b'')

if __name__ == '__main__':
    target = Path(__file__).resolve().parent.parent / 'desktop'
    (target / 'trayTemplate.png').write_bytes(render_tray(18))
    (target / 'trayTemplate@2x.png').write_bytes(render_tray(36))
    import sys
    if '--tray-only' in sys.argv:
        sys.exit(0)
    large, small = render(512), render(256)
    (target / 'icon.png').write_bytes(large)
    # Windows picks the closest size for each place (title bar 16-24, taskbar 32-48, Explorer 48-256).
    sizes = (16, 24, 32, 48, 64, 128, 256)
    images = [small if size == 256 else render(size) for size in sizes]
    header, offset = struct.pack('<HHH', 0, 1, len(sizes)), 6 + 16 * len(sizes)
    for size, image in zip(sizes, images):
        header += struct.pack('<BBBBHHII', size % 256, size % 256, 0, 0, 1, 32, len(image), offset)
        offset += len(image)
    (target / 'icon.ico').write_bytes(header + b''.join(images))
    parts = b'ic09' + struct.pack('>I', len(large) + 8) + large + b'ic08' + struct.pack('>I', len(small) + 8) + small
    (target / 'icon.icns').write_bytes(b'icns' + struct.pack('>I', len(parts) + 8) + parts)
