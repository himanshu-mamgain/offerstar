// Render an animated SVG at fixed animation times by pausing every CSS
// animation and seeking it, so frames are deterministic.
// usage: node frames.js <svg> <outdir> <width> <height> <t0_ms> <t1_ms> <step_ms>
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const [svg, outdir, w, h, t0, t1, step] = process.argv.slice(2);
  fs.mkdirSync(outdir, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: +w, height: +h } });
  await page.route(/^https?:/, r => r.abort());
  await page.goto('file://' + path.resolve(svg), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  let i = 0;
  for (let t = +t0; t < +t1; t += +step) {
    await page.evaluate(ms => {
      for (const a of document.getAnimations()) { a.pause(); a.currentTime = ms; }
    }, t);
    await page.screenshot({ path: path.join(outdir, `f${String(i).padStart(4, '0')}.png`), omitBackground: true });
    i++;
  }
  console.log('frames', i);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
