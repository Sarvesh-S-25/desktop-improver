"""Draws the Desktop Pods app icon (a glass pod: 3 tiles + a mini cluster) and
writes assets/icon.ico with PNG-compressed 256/64/48/32/16 px images. Pure Python."""
import math
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "icon.ico")


def rrect_sdf(px, py, cx, cy, hw, hh, r):
    qx = abs(px - cx) - hw + r
    qy = abs(py - cy) - hh + r
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r


def cover(d, aa):
    return min(max(0.5 - d / aa, 0.0), 1.0)


def over(dst, src, a):
    return [s * a + d * (1 - a) for s, d in zip(src, dst)]


def render(size):
    s = size / 256.0
    aa = max(1.0, 1.0 / s) * s  # ~1px antialias at every size
    px_rows = []
    # tiles in 256-space: 2x2 grid inside the glass
    tiles = [(92, 92), (164, 92), (92, 164)]
    cluster = (164, 164)
    for y in range(size):
        row = bytearray()
        for x in range(size):
            X = (x + 0.5) / s
            Y = (y + 0.5) / s
            # glass body with a blue -> rose gradient (the "wallpaper" seen through it)
            body = cover(rrect_sdf(X, Y, 128, 128, 116, 116, 52) * s, aa)
            t = (X + Y) / 512.0
            col = [74 + (214 - 74) * t, 120 + (126 - 120) * t, 222 + (170 - 222) * t]
            # soft top highlight
            col = over(col, [255, 255, 255], 0.22 * max(0.0, 1 - Y / 150))
            # inner hairline
            edge = cover(abs(rrect_sdf(X, Y, 128, 128, 113, 113, 49)) * s - 1.2 * s, aa)
            col = over(col, [255, 255, 255], 0.45 * edge)
            # three app tiles
            for (cx, cy) in tiles:
                a = cover(rrect_sdf(X, Y, cx, cy, 28, 28, 12) * s, aa)
                if a:
                    col = over(col, [255, 255, 255], 0.95 * a)
            # cluster: translucent well with 4 mini tiles
            well = cover(rrect_sdf(X, Y, cluster[0], cluster[1], 28, 28, 12) * s, aa)
            if well:
                col = over(col, [255, 255, 255], 0.38 * well)
                for dx in (-13, 13):
                    for dy in (-13, 13):
                        a = cover(rrect_sdf(X, Y, cluster[0] + dx, cluster[1] + dy, 9, 9, 4) * s, aa)
                        if a:
                            col = over(col, [255, 255, 255], 0.95 * a)
            row += bytes([int(round(c)) for c in col] + [int(round(body * 255))])
        px_rows.append(row)
    return px_rows


def png(size, rows):
    raw = b"".join(b"\x00" + bytes(r) for r in rows)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main():
    sizes = [256, 64, 48, 32, 16]
    images = [png(n, render(n)) for n in sizes]
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries = b""
    for n, data in zip(sizes, images):
        entries += struct.pack("<BBBBHHII", n % 256, n % 256, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    with open(OUT, "wb") as f:
        f.write(header + entries + b"".join(images))
    with open(os.path.join(ROOT, "assets", "icon.png"), "wb") as f:
        f.write(images[0])
    print("wrote", OUT)


if __name__ == "__main__":
    main()
