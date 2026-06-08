#!/usr/bin/env python3
"""Generate a demo radio spectral cube (RA, Dec, velocity) without numpy.

64x64x32 float32 cube. Two spatial clumps, each emitting a Gaussian spectral
line at a different radial velocity, so stepping through channels shows the
emission appear, peak, and fade — like a real PPV (position-position-velocity)
cube. Axis 3 is VRAD (radio velocity) with CUNIT3 = m/s.
"""
import math, struct, sys

W = H = 64
NCHAN = 32
V0, V1 = -60.0, 60.0          # km/s range across the cube
CRVAL3 = V0 * 1000.0          # m/s
CDELT3 = (V1 - V0) * 1000.0 / (NCHAN - 1)

def card(key, value, comment=""):
    if isinstance(value, bool):
        field = f"{'T' if value else 'F':>20}"
    elif isinstance(value, int):
        field = f"{value:>20}"
    elif isinstance(value, float):
        field = f"{value:>20.10E}"
    else:
        field = f"'{value:<8}'".ljust(20)
    c = f"{key:<8}= {field}"
    if comment:
        c = f"{c} / {comment}"
    return c[:80].ljust(80)

def header_bytes(cards):
    cards = cards + ["END".ljust(80)]
    block = "".join(cards)
    block += " " * ((2880 - len(block) % 2880) % 2880)
    return block.encode("ascii")

# clumps: (x, y, spatial_sigma, peak_velocity_kms, spectral_sigma_kms, amp)
clumps = [
    (22, 26, 5.0, -25.0, 8.0, 8000.0),
    (42, 38, 6.0,  20.0, 6.0, 6000.0),
    (32, 14, 4.0,  -5.0, 10.0, 4000.0),
]

seed = 9
def rnd():
    global seed
    seed = (1103515245 * seed + 12345) & 0x7fffffff
    return seed / 0x7fffffff

header = [
    card("SIMPLE", True, "Standard FITS"),
    card("BITPIX", -32),
    card("NAXIS", 3),
    card("NAXIS1", W), card("NAXIS2", H), card("NAXIS3", NCHAN),
    card("CTYPE1", "RA---TAN"), card("CTYPE2", "DEC--TAN"), card("CTYPE3", "VRAD"),
    card("CRPIX1", W/2.0), card("CRPIX2", H/2.0), card("CRPIX3", 1.0),
    card("CRVAL1", 83.8221, "deg (Orion-ish)"),
    card("CRVAL2", -5.3911, "deg"),
    card("CRVAL3", CRVAL3, "m/s"),
    card("CDELT1", -0.001), card("CDELT2", 0.001), card("CDELT3", CDELT3, "m/s"),
    card("CUNIT3", "m/s"),
    card("RESTFRQ", 115.271202e9, "CO(1-0) Hz"),
    card("BUNIT", "K"),
    card("OBJECT", "demo cube"),
]

# build data channel-major (NAXIS3 outermost), each plane row-major
planes = []
for k in range(NCHAN):
    v = V0 + (V1 - V0) * k / (NCHAN - 1)     # km/s of this channel
    plane = bytearray()
    for y in range(H):
        for x in range(W):
            val = 2.0 + (rnd() - 0.5) * 3.0  # background noise
            for cx, cy, ssig, vpk, vsig, amp in clumps:
                spatial = math.exp(-((x-cx)**2 + (y-cy)**2) / (2*ssig*ssig))
                spectral = math.exp(-((v - vpk)**2) / (2*vsig*vsig))
                val += amp * spatial * spectral
            plane += struct.pack(">f", val)
    planes.append(plane)

data = b"".join(planes)
data += b"\x00" * ((2880 - len(data) % 2880) % 2880)

out = sys.argv[1] if len(sys.argv) > 1 else "cube.fits"
with open(out, "wb") as f:
    f.write(header_bytes(header))
    f.write(data)
print(f"wrote {out}: {W}x{H}x{NCHAN} VRAD cube, v {V0}..{V1} km/s")
