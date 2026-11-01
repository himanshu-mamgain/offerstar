# README art

Generators for the animated images in `assets/readme/`. Edit the text, colours or timing in the Python files, then rebuild.

All animations loop on a 9-second cycle so the GIF loops seamlessly.

## Rebuild

Requires Python 3 with Pillow and NumPy, Node with Playwright, and ffmpeg.

```bash
python3 scripts/readme-art/make_hero.py assets/readme/hero.svg
python3 scripts/readme-art/make_route.py assets/readme/route.svg

# GIF version of the hero, for npm and social previews (about 400 KB)
node scripts/readme-art/frames.js assets/readme/hero.svg /tmp/frames 1280 480 9000 18000 80
mkdir -p /tmp/pal
ffmpeg -framerate 12.5 -i /tmp/frames/f%04d.png \
  -vf "fps=10,scale=800:-1:flags=lanczos,palettegen=max_colors=128:reserve_transparent=1:stats_mode=full" /tmp/pal/palette.png
ffmpeg -framerate 12.5 -i /tmp/frames/f%04d.png -i /tmp/pal/palette.png \
  -lavfi "fps=10,scale=800:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:alpha_threshold=128" /tmp/pal/p%04d.png
python3 scripts/readme-art/gif_opt.py /tmp/pal assets/readme/hero.gif 100
```

`frames.js` pauses every CSS animation and seeks it to an exact time, so frames are deterministic. `gif_opt.py` makes unchanged pixels transparent between frames, which keeps the GIF small.
