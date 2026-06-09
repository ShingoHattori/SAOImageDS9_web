#!/usr/bin/env python3
"""Generate a demo FITS event list (BINTABLE) without numpy/astropy.

Primary HDU (no data) + a BINTABLE extension with columns X, Y, ENERGY.
~30000 events: two spatial clusters plus uniform background, like an X-ray
event file. DS9 / this viewer bins X,Y into a counts image.
"""
import math, struct, sys

NROWS = 30000
XMAX = YMAX = 1024

def card(key, value, comment=""):
    if isinstance(value, bool): f = f"{'T' if value else 'F':>20}"
    elif isinstance(value, int): f = f"{value:>20}"
    elif isinstance(value, float): f = f"{value:>20.10E}"
    else: f = f"'{value:<8}'".ljust(20)
    s = f"{key:<8}= {f}" + (f" / {comment}" if comment else "")
    return s[:80].ljust(80)

def pad(cards):
    cards = cards + ["END".ljust(80)]
    b = "".join(cards)
    b += " " * ((2880 - len(b) % 2880) % 2880)
    return b.encode("ascii")

primary = pad([card("SIMPLE", True), card("BITPIX", 8), card("NAXIS", 0), card("EXTEND", True)])

rowbytes = 3 * 4  # X,Y,ENERGY as 4-byte floats
ext = pad([
    card("XTENSION", "BINTABLE"), card("BITPIX", 8), card("NAXIS", 2),
    card("NAXIS1", rowbytes), card("NAXIS2", NROWS), card("PCOUNT", 0), card("GCOUNT", 1),
    card("TFIELDS", 3),
    card("TTYPE1", "X"), card("TFORM1", "1E"), card("TUNIT1", "pixel"),
    card("TLMIN1", 0.0), card("TLMAX1", float(XMAX)),
    card("TTYPE2", "Y"), card("TFORM2", "1E"), card("TUNIT2", "pixel"),
    card("TLMIN2", 0.0), card("TLMAX2", float(YMAX)),
    card("TTYPE3", "ENERGY"), card("TFORM3", "1E"), card("TUNIT3", "keV"),
])

seed = 4242
def rnd():
    global seed
    seed = (1103515245 * seed + 12345) & 0x7fffffff
    return seed / 0x7fffffff

def gauss(mx, my, s):
    # Box-Muller
    u1 = max(1e-9, rnd()); u2 = rnd()
    r = math.sqrt(-2 * math.log(u1))
    return mx + s * r * math.cos(2*math.pi*u2), my + s * r * math.sin(2*math.pi*u2)

data = bytearray()
clusters = [(380, 600, 45, 0.45), (680, 360, 28, 0.30)]  # x,y,sigma,fraction
for _ in range(NROWS):
    u = rnd()
    if u < clusters[0][3]:
        x, y = gauss(*clusters[0][:3]); e = 1.0 + rnd()*2
    elif u < clusters[0][3] + clusters[1][3]:
        x, y = gauss(*clusters[1][:3]); e = 4.0 + rnd()*3
    else:
        x, y = rnd()*XMAX, rnd()*YMAX; e = 0.5 + rnd()*7   # background
    x = min(XMAX, max(0, x)); y = min(YMAX, max(0, y))
    data += struct.pack(">fff", x, y, e)
data += b"\x00" * ((2880 - len(data) % 2880) % 2880)

out = sys.argv[1] if len(sys.argv) > 1 else "events.fits"
with open(out, "wb") as f:
    f.write(primary); f.write(ext); f.write(data)
print(f"wrote {out}: BINTABLE {NROWS} rows (X,Y,ENERGY)")
