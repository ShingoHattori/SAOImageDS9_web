#!/usr/bin/env python3
"""Generate a demo FITS image (float32) without numpy/astropy.

Produces a 256x256 image: two Gaussian "stars" on a noisy background, plus a
simple TAN WCS so the viewer's RA/Dec readout has something to show.
"""
import math, struct, sys

W = H = 256

def card(key, value, comment=""):
    if isinstance(value, bool):
        v = "T" if value else "F"
        field = f"{v:>20}"
    elif isinstance(value, int):
        field = f"{value:>20}"
    elif isinstance(value, float):
        field = f"{value:>20.10E}"
    else:  # string
        field = f"'{value:<8}'".ljust(20)
    c = f"{key:<8}= {field}"
    if comment:
        c = f"{c} / {comment}"
    return c[:80].ljust(80)

def end_pad(cards):
    cards.append("END".ljust(80))
    block = "".join(cards)
    pad = (2880 - len(block) % 2880) % 2880
    return (block + " " * pad).encode("ascii")

# deterministic pseudo-random (no random module dependence on platform)
seed = 12345
def rnd():
    global seed
    seed = (1103515245 * seed + 12345) & 0x7fffffff
    return seed / 0x7fffffff

header = [
    card("SIMPLE", True, "Standard FITS"),
    card("BITPIX", -32, "32-bit float"),
    card("NAXIS", 2),
    card("NAXIS1", W),
    card("NAXIS2", H),
    card("CTYPE1", "RA---TAN"),
    card("CTYPE2", "DEC--TAN"),
    card("CRPIX1", 128.0),
    card("CRPIX2", 128.0),
    card("CRVAL1", 150.0, "deg"),
    card("CRVAL2", 2.5, "deg"),
    card("CDELT1", -0.0002777778, "deg/pix"),
    card("CDELT2", 0.0002777778, "deg/pix"),
    card("CROTA2", 0.0),
    card("BUNIT", "adu"),
    card("OBJECT", "demo"),
]

stars = [(90, 110, 5000, 3.0), (170, 150, 9000, 4.5), (60, 200, 2500, 2.0)]

data = bytearray()
for y in range(H):
    for x in range(W):
        v = 100.0 + (rnd() - 0.5) * 40.0            # background + noise
        for sx, sy, amp, sig in stars:
            r2 = (x - sx) ** 2 + (y - sy) ** 2
            v += amp * math.exp(-r2 / (2 * sig * sig))
        data += struct.pack(">f", v)

# pad data unit to 2880
pad = (2880 - len(data) % 2880) % 2880
data += b"\x00" * pad

out = sys.argv[1] if len(sys.argv) > 1 else "demo.fits"
with open(out, "wb") as f:
    f.write(end_pad(header))
    f.write(data)
print(f"wrote {out}: {W}x{H} float32, {len(data)} data bytes")
