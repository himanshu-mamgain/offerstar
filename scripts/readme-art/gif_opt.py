"""Assemble paletted frames into a GIF where unchanged pixels are transparent.

usage: python3 gif_opt.py <frames_dir> <out.gif> <frame_ms>
Frames must share one palette (ffmpeg paletteuse with a fixed palette).
"""
import glob
import sys

import numpy as np
from PIL import Image

frames_dir, out, ms = sys.argv[1], sys.argv[2], int(sys.argv[3])
files = sorted(glob.glob(f"{frames_dir}/p[0-9]*.png"))
imgs = [Image.open(f) for f in files]
assert all(im.mode == "P" for im in imgs), "frames must be paletted"
palette = imgs[0].getpalette()
arrs = [np.array(im) for im in imgs]

# The reserved transparent index is whatever the rounded corner holds.
t_idx = int(arrs[0][0, 0])

out_frames, durations = [], []
prev = arrs[0]
first = Image.fromarray(arrs[0], "P")
first.putpalette(palette)
out_frames.append(first)
durations.append(ms)

for a in arrs[1:]:
    changed = a != prev
    if not changed.any():
        durations[-1] += ms  # merge identical frames
        continue
    f = np.where(changed, a, t_idx).astype(np.uint8)
    im = Image.fromarray(f, "P")
    im.putpalette(palette)
    out_frames.append(im)
    durations.append(ms)
    prev = a

out_frames[0].save(
    out,
    save_all=True,
    append_images=out_frames[1:],
    duration=durations,
    loop=0,
    transparency=t_idx,
    disposal=1,
    optimize=False,
)
print("frames", len(out_frames), "transparent index", t_idx)
