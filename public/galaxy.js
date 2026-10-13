// The two-galaxies-merge hero animation, ported from the AppBridge design prototype.
const cl = t => Math.max(0, Math.min(1, t));
const ease = t => (t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const eOut = t => 1 - Math.pow(1 - t, 3);
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
const DENSITY = 700;
export const MERGE_MS = 2400;

export class Galaxy {
  constructor(canvas, hero) {
    this.hero = hero;
    this.eng = { mode: 'idle', t0: 0, hover: 0, hoverT: 0, gen: false, appear: -1e5, pulses: [] };
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = 560 * dpr; canvas.height = 320 * dpr;
    this.ctx = canvas.getContext('2d');
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.setTints([158, 193, 255], [158, 193, 255]);
    this.last = performance.now();
    const loop = t => { this.frame(t); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }
  destroy() { cancelAnimationFrame(this.raf); }
  hover(on) { this.eng.hoverT = on ? 1 : 0; }
  merge() { Object.assign(this.eng, { mode: 'merge', t0: performance.now(), hoverT: 0 }); }
  generating(on) { this.eng.gen = on; }
  pulse() { this.eng.pulses.push(performance.now()); }
  reset() {
    Object.assign(this.eng, { mode: 'idle', gen: false, appear: performance.now(), pulses: [] });
    this.P.forEach(p => { p.fz = false; p.d = 0; p.rs = false; p.px = null; });
  }
  setTints(left, right) {
    const tints = [left, right];
    this.P = [];
    for (let g = 0; g < 2; g++) for (let i = 0; i < DENSITY; i++) {
      const r0 = 5 + 92 * Math.pow(Math.random(), 1.45);
      const free = Math.random() < .18;
      const ph = free ? Math.random() * 6.283 : (i % 2) * Math.PI + gauss() * (.22 + .25 * r0 / 97);
      const k = Math.min(1, Math.max(0, 1 - r0 / 30) * .85 + Math.random() * .15);
      const t = tints[g];
      this.P.push({ g, r0, ph, w: .5 * Math.sqrt(26 / (r0 + 10)), s: .7 + Math.random() * 1.1 * (1 - r0 / 140), a: Math.min(1, (.45 + .75 * Math.random()) * (1 - .45 * r0 / 97)),
        c: [0, 1, 2].map(j => Math.round(t[j] + (255 - t[j]) * k)).join(','), d: 0, rs: false, fz: this.eng.mode === 'fused', px: null, py: null });
    }
    this.D = [];
    for (let i = 0; i < 420; i++) {
      const r = 29 + 36 * Math.pow(Math.random(), 1.3); const k = Math.random();
      this.D.push({ r, ph: Math.random() * 6.283, w: 2.2 * Math.sqrt(30 / r), s: .4 + Math.random() * .8, a: .3 + .7 * Math.random(), c: `255,${Math.round(231 + 24 * k)},${Math.round(196 + 59 * k)}` });
    }
  }
  frame(now) {
    const ctx = this.ctx, E = this.eng;
    const dt = Math.min(.05, (now - this.last) / 1000); this.last = now;
    E.hover += (E.hoverT - E.hover) * Math.min(1, dt * 6);
    const cy = this.hero.offsetHeight / 2 - 8, hx = 280, hv = E.hover;
    let T = 0;
    if (E.mode === 'merge') { T = (now - E.t0) / MERGE_MS; if (T >= 1.2) E.mode = 'fused'; }
    const fused = E.mode === 'fused' || (E.mode === 'merge' && T > .76);
    const p1 = ease(cl((T - .04) / .62)), p2 = ease(cl((T - .6) / .16));
    const q = E.mode === 'fused' ? 1 : eOut(cl((T - .76) / .32));
    const ap = eOut(cl((now - E.appear) / 900));
    let pk = 0;
    E.pulses = E.pulses.filter(t0 => (now - t0) < 1400);
    E.pulses.forEach(t0 => { pk = Math.max(pk, 1 - (now - t0) / 1400); });
    ctx.clearRect(0, 0, 560, 320);
    ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
    for (const p of this.P) {
      let x, y, al;
      if (!fused) {
        const sg = p.g ? -1 : 1;
        p.ph -= p.w * (1 + 9 * p1 * p1 + hv * .5) * dt * sg;
        const ang = p.ph + sg * .052 * p.r0;
        const sc = (1 - .95 * p1) * (1 - p2) * ap;
        const c0 = p.g ? 430 : 130;
        const cx = c0 + (hx - c0) * p1 + sg * hv * 6;
        const tl = (p.g ? -.38 : .38) * (1 - p1);
        const lx = Math.cos(ang) * p.r0 * sc, ly = Math.sin(ang) * p.r0 * sc * (.56 + .3 * p1);
        x = cx + lx * Math.cos(tl) - ly * Math.sin(tl); y = cy + lx * Math.sin(tl) + ly * Math.cos(tl);
        al = p.a * (1 - p2) * (1 + p1 * .6);
      } else {
        if (!p.fz) { p.fz = true; p.ph += p.g * Math.PI / 2; p.px = null; }
        if (E.gen) { p.d += dt * .045 * (.6 + p.w); if (p.d > .85) { p.d = 0; p.rs = true; p.px = null; } }
        p.ph -= p.w * .85 * (E.gen ? 1.5 : 1) * dt;
        const re = p.r0 * .74 * (1 - p.d) * q * (1 + pk * .1);
        const ang = p.ph + .052 * p.r0 * (1 - p.d * .5);
        const lx = Math.cos(ang) * re, ly = Math.sin(ang) * re * .5, tl = -.12;
        x = hx + lx * Math.cos(tl) - ly * Math.sin(tl); y = cy + lx * Math.sin(tl) + ly * Math.cos(tl);
        al = p.a * (.35 + .65 * q) * (p.rs ? Math.min(1, p.d / .08) : 1) * (1 + pk * .6);
      }
      if (p.px !== null && Math.abs(x - p.px) + Math.abs(y - p.py) < 40) {
        ctx.strokeStyle = `rgba(${p.c},${Math.min(1, al)})`; ctx.lineWidth = p.s;
        ctx.beginPath(); ctx.moveTo(p.px, p.py); ctx.lineTo(x + .01, y); ctx.stroke();
      }
      p.px = x; p.py = y;
    }
    const hr = (24 + hv * 3 + 8 * p1) * (1 - p2) * ap;
    if ((!fused || T < .78) && hr > .5) {
      const pts = [];
      for (const d of this.D) {
        d.ph += d.w * (1 + 3 * p1 + hv * .6) * dt;
        const rr = d.r * (1 + .2 * p1) * (1 - p2) * ap;
        const lx = Math.cos(d.ph) * rr, ly = Math.sin(d.ph) * rr * .26, tl = -.18;
        pts.push([hx + lx * Math.cos(tl) - ly * Math.sin(tl), cy + lx * Math.sin(tl) + ly * Math.cos(tl), Math.sin(d.ph) < 0, d]);
      }
      const bright = .55 + .5 * p1 + .35 * hv;
      const drawDisk = back => { for (const [x, y, b, d] of pts) if (b === back) { ctx.fillStyle = `rgba(${d.c},${Math.min(1, d.a * bright)})`; ctx.fillRect(x - d.s / 2, y - d.s / 2, d.s, d.s); } };
      drawDisk(true);
      const g = ctx.createRadialGradient(hx, cy, hr * .9, hx, cy, hr * 2.8);
      g.addColorStop(0, `rgba(255,236,210,${.2 * (1 + hv + p1)})`); g.addColorStop(1, 'rgba(255,236,210,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(hx, cy, hr * 2.8, 0, 6.283); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(hx, cy, hr, 0, 6.283); ctx.fill();
      ctx.strokeStyle = `rgba(255,238,215,${.55 + .3 * hv})`; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(hx, cy, hr + 1, 0, 6.283); ctx.stroke();
      ctx.globalCompositeOperation = 'lighter';
      drawDisk(false);
    }
    if (E.mode !== 'idle' && T > .72 && T < 1.2) {
      const k = cl((T - .72) / .45);
      const g = ctx.createRadialGradient(hx, cy, 0, hx, cy, 20 + k * 140);
      g.addColorStop(0, `rgba(255,250,240,${.9 * Math.pow(1 - k, 2)})`); g.addColorStop(1, 'rgba(255,250,240,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(hx, cy, 20 + k * 140, 0, 6.283); ctx.fill();
      ctx.strokeStyle = `rgba(255,255,255,${.7 * Math.pow(1 - k, 2)})`; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.ellipse(hx, cy, 10 + k * 320, (10 + k * 320) * .45, 0, 0, 6.283); ctx.stroke();
    }
    if (fused) {
      const g = ctx.createRadialGradient(hx, cy, 0, hx, cy, 80);
      g.addColorStop(0, `rgba(255,255,255,${.1 * q})`); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(hx, cy, 80, 0, 6.283); ctx.fill();
    }
    E.pulses.forEach(t0 => {
      const k = (now - t0) / 1400;
      ctx.strokeStyle = `rgba(160,255,190,${.55 * Math.pow(1 - k, 2)})`; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.ellipse(hx, cy, 30 + k * 240, (30 + k * 240) * .5, -.12, 0, 6.283); ctx.stroke();
    });
    ctx.globalCompositeOperation = 'source-over';
  }
}

// Average colour of an app icon, weighted towards its saturated pixels, for tinting its galaxy.
export function iconTint(src) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = c.height = 24;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0, 24, 24);
      const d = x.getImageData(0, 0, 24, 24).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const w = (d[i + 3] / 255) * (.05 + (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2])) / 255);
        r += d[i] * w; g += d[i + 1] * w; b += d[i + 2] * w; n += w;
      }
      if (!n) return resolve([158, 193, 255]);
      // Lift dark icons so the stars stay visible on the dark window.
      const rgb = [r / n, g / n, b / n], lift = Math.max(1, 150 / Math.max(...rgb, 1));
      resolve(rgb.map(v => Math.round(Math.min(255, v * lift))));
    };
    img.onerror = () => resolve([158, 193, 255]);
    img.src = src;
  });
}
