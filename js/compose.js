/* Lays out the receipt at printer-dot resolution and converts it to a 1-bit bitmap. */
(function () {
  const RPB = (window.RPB = window.RPB || {});

  // aspect = slot width / height
  const LAYOUTS = {
    single: { count: 1, cols: 1, aspect: 1 },
    duo: { count: 2, cols: 1, aspect: 4 / 3 },
    strip3: { count: 3, cols: 1, aspect: 4 / 3 },
    strip4: { count: 4, cols: 1, aspect: 4 / 3 },
    grid4: { count: 4, cols: 2, aspect: 1 },
  };

  // What guests pick from: a photo layout plus a receipt theme.
  const TEMPLATES = {
    agentId: { label: 'Agent ID Badge', poses: 1, layout: 'single', theme: 'agent' },
    botInvoice: { label: 'Bot Invoice', poses: 3, layout: 'strip3', theme: 'invoice' },
    bootLog: { label: 'Boot Log', poses: 4, layout: 'grid4', theme: 'terminal' },
    squad: { label: 'Bot Squad', poses: 4, layout: 'strip4', theme: 'agent' },
    classic1: { label: 'Classic Receipt', poses: 1, layout: 'single', theme: 'classic' },
    boarding: { label: 'Boarding Pass', poses: 2, layout: 'duo', theme: 'boarding' },
    classic3: { label: 'Classic Strip', poses: 3, layout: 'strip3', theme: 'classic' },
    cinema: { label: 'Movie Ticket', poses: 3, layout: 'strip3', theme: 'cinema' },
    grid4: { label: 'Classic Grid', poses: 4, layout: 'grid4', theme: 'classic' },
    classic4: { label: 'Long Strip', poses: 4, layout: 'strip4', theme: 'classic' },
  };

  const TITLE_FONTS = {
    'Archivo Black': '"Archivo Black", "Arial Black", sans-serif',
    'Bebas Neue': '"Bebas Neue", Impact, sans-serif',
    Pacifico: 'Pacifico, "Brush Script MT", cursive',
    'Playfair Display': '"Playfair Display", Georgia, serif',
    'Space Mono': '"Space Mono", "Courier New", monospace',
  };
  const MONO = '"Space Mono", "Courier New", monospace';

  const dotsFor = (mm) => (Number(mm) === 80 ? 576 : 384);

  async function loadFonts(s) {
    if (!document.fonts || !document.fonts.load) return;
    const want = [`400 20px ${TITLE_FONTS[s.titleFont] || MONO}`, `400 20px ${MONO}`, `700 20px ${MONO}`];
    const all = Promise.all(want.map((f) => document.fonts.load(f).catch(() => null)));
    await Promise.race([all, new Promise((r) => setTimeout(r, 2500))]);
  }

  /* Draws a photo so it covers rect r, then applies the guest's move / zoom / turn (xf),
     the colour look (CSS filter string) and the beauty soft-focus level. */
  function drawPhoto(ctx, img, r, xf, look, beauty) {
    const t = xf || { dx: 0, dy: 0, scale: 1, rot: 0 };
    const iw = img.width, ih = img.height;
    const k = Math.max(r.w / iw, r.h / ih) * (t.scale || 1);
    const css = look && look !== 'none' ? look : '';
    const pass = (filter, alpha) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();
      ctx.filter = filter || 'none';
      ctx.globalAlpha = alpha;
      ctx.translate(r.x + r.w / 2 + (t.dx || 0) * r.w, r.y + r.h / 2 + (t.dy || 0) * r.h);
      ctx.rotate(((t.rot || 0) * Math.PI) / 180);
      ctx.scale(t.flip ? -k : k, k);
      ctx.drawImage(img, -iw / 2, -ih / 2);
      ctx.restore();
    };
    ctx.fillStyle = '#fff';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = '#000';
    pass(css, 1);
    const b = RPB.imaging.BEAUTY[beauty | 0];
    if (b && b.alpha) pass(`${css} blur(${(r.w * 0.012).toFixed(1)}px) brightness(${b.bright})`.trim(), b.alpha);
  }

  /* ---------- stickers and drawing ----------
     Each sticker draws itself in a unit box (-0.5..0.5), black with a white edge so it reads
     on both light and dark parts of a photo and survives the 1-bit print. */
  const ink = (ctx) => {
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 0.09;
    ctx.stroke();
    ctx.fillStyle = '#000';
    ctx.fill();
  };
  const poly = (ctx, pts) => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
  };
  const burst = (n, outer, inner) => {
    const pts = [];
    for (let i = 0; i < n * 2; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / n;
      const r = i % 2 ? inner : outer;
      pts.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    return pts;
  };
  const rrect = (ctx, x, y, w, h, r) => {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
  };
  const bubble = (word) => (ctx) => {
    rrect(ctx, -0.48, -0.36, 0.96, 0.5, 0.14);
    ctx.moveTo(-0.2, 0.12);
    ctx.lineTo(-0.3, 0.4);
    ctx.lineTo(0.02, 0.12);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 0.07;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.save();
    ctx.scale(0.01, 0.01);
    ctx.fillStyle = '#000';
    ctx.font = '400 27px "Archivo Black", "Arial Black", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(word, 0, -10);
    ctx.restore();
  };
  const STICKERS = {
    heart: (ctx) => {
      ctx.beginPath();
      ctx.moveTo(0, 0.42);
      ctx.bezierCurveTo(-0.62, 0.02, -0.42, -0.5, 0, -0.2);
      ctx.bezierCurveTo(0.42, -0.5, 0.62, 0.02, 0, 0.42);
      ctx.closePath();
      ink(ctx);
    },
    star: (ctx) => { poly(ctx, burst(5, 0.48, 0.2)); ink(ctx); },
    sparkle: (ctx) => { poly(ctx, burst(4, 0.48, 0.11)); ink(ctx); },
    crown: (ctx) => {
      poly(ctx, [[-0.45, 0.3], [-0.48, -0.25], [-0.22, 0.02], [0, -0.38], [0.22, 0.02], [0.48, -0.25], [0.45, 0.3]]);
      ink(ctx);
    },
    glasses: (ctx) => {
      ctx.beginPath();
      ctx.arc(-0.25, 0, 0.18, 0, Math.PI * 2);
      ctx.moveTo(0.43, 0);
      ctx.arc(0.25, 0, 0.18, 0, Math.PI * 2);
      ctx.moveTo(-0.07, -0.02);
      ctx.lineTo(0.07, -0.02);
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 0.15;
      ctx.stroke();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 0.07;
      ctx.stroke();
    },
    shades: (ctx) => {
      rrect(ctx, -0.47, -0.15, 0.4, 0.3, 0.09);
      ink(ctx);
      rrect(ctx, 0.07, -0.15, 0.4, 0.3, 0.09);
      ink(ctx);
      ctx.fillRect(-0.09, -0.13, 0.18, 0.07);
    },
    mustache: (ctx) => {
      ctx.beginPath();
      ctx.moveTo(0, -0.05);
      ctx.bezierCurveTo(-0.15, -0.2, -0.4, -0.1, -0.5, 0.12);
      ctx.bezierCurveTo(-0.35, 0.2, -0.12, 0.18, 0, 0.05);
      ctx.bezierCurveTo(0.12, 0.18, 0.35, 0.2, 0.5, 0.12);
      ctx.bezierCurveTo(0.4, -0.1, 0.15, -0.2, 0, -0.05);
      ctx.closePath();
      ink(ctx);
    },
    bow: (ctx) => {
      poly(ctx, [[0, 0], [-0.48, -0.28], [-0.48, 0.28]]);
      ink(ctx);
      poly(ctx, [[0, 0], [0.48, -0.28], [0.48, 0.28]]);
      ink(ctx);
      ctx.beginPath();
      ctx.arc(0, 0, 0.11, 0, Math.PI * 2);
      ink(ctx);
    },
    hat: (ctx) => {
      poly(ctx, [[0, -0.42], [-0.36, 0.42], [0.36, 0.42]]);
      ink(ctx);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 0.05;
      ctx.beginPath();
      ctx.moveTo(-0.17, 0); ctx.lineTo(0.17, 0);
      ctx.moveTo(-0.27, 0.22); ctx.lineTo(0.27, 0.22);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, -0.42, 0.08, 0, Math.PI * 2);
      ink(ctx);
    },
    wow: bubble('WOW!'),
    lol: bubble('LOL'),
    yay: bubble('YAY!'),
    robot: (ctx) => {
      // antenna
      ctx.beginPath();
      ctx.moveTo(0, -0.3); ctx.lineTo(0, -0.42);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.12; ctx.lineCap = 'round'; ctx.stroke();
      ctx.strokeStyle = '#000'; ctx.lineWidth = 0.05; ctx.stroke();
      ctx.beginPath(); ctx.arc(0, -0.44, 0.06, 0, Math.PI * 2); ink(ctx);
      // ears
      rrect(ctx, -0.48, -0.08, 0.1, 0.22, 0.03); ink(ctx);
      rrect(ctx, 0.38, -0.08, 0.1, 0.22, 0.03); ink(ctx);
      // head
      rrect(ctx, -0.38, -0.3, 0.76, 0.6, 0.12); ink(ctx);
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(-0.16, -0.05, 0.09, 0, Math.PI * 2); ctx.arc(0.16, -0.05, 0.09, 0, Math.PI * 2); ctx.fill();
      ctx.fillRect(-0.18, 0.13, 0.36, 0.06);
      ctx.fillStyle = '#000';
      ctx.fillRect(-0.06, 0.13, 0.03, 0.06); ctx.fillRect(0.03, 0.13, 0.03, 0.06);
    },
    visor: (ctx) => {
      rrect(ctx, -0.5, -0.16, 1, 0.32, 0.16); ink(ctx);
      ctx.fillStyle = '#fff';
      for (let i = -3; i <= 3; i++) ctx.fillRect(i * 0.11 - 0.035, -0.02, 0.07, 0.04);
    },
    chip: (ctx) => {
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.1; ctx.lineCap = 'butt';
      ctx.beginPath();
      for (let i = -2; i <= 2; i++) {
        const t = i * 0.12;
        ctx.moveTo(t, -0.48); ctx.lineTo(t, 0.48);
        ctx.moveTo(-0.48, t); ctx.lineTo(0.48, t);
      }
      ctx.stroke();
      ctx.strokeStyle = '#000'; ctx.lineWidth = 0.05; ctx.stroke();
      rrect(ctx, -0.32, -0.32, 0.64, 0.64, 0.06); ink(ctx);
      ctx.save(); ctx.scale(0.01, 0.01);
      ctx.fillStyle = '#fff'; ctx.font = '400 30px "Archivo Black", "Arial Black", sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('AI', 0, 2);
      ctx.restore();
    },
    bolt: (ctx) => { poly(ctx, [[0.12, -0.48], [-0.3, 0.06], [-0.02, 0.06], [-0.12, 0.48], [0.3, -0.08], [0.02, -0.08]]); ink(ctx); },
    beep: bubble('BEEP!'),
    hello: bubble('HI HUMAN'),
    ai: bubble('100% AI'),
  };

  /* decor: { stickers: [{type,x,y,size,rot}], strokes: [{pts:[[x,y]],w,white}] }
     Positions are fractions of the slot; sizes and line widths are fractions of its width. */
  function drawDecor(ctx, r, decor) {
    if (!decor) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    for (const st of decor.strokes || []) {
      ctx.strokeStyle = st.white ? '#fff' : '#000';
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = Math.max(1.5, st.w * r.w);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      st.pts.forEach((p, i) => {
        const x = r.x + p[0] * r.w, y = r.y + p[1] * r.h;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      if (st.pts.length === 1) ctx.lineTo(r.x + st.pts[0][0] * r.w + 0.1, r.y + st.pts[0][1] * r.h);
      ctx.stroke();
    }
    for (const k of decor.stickers || []) {
      ctx.save();
      ctx.translate(r.x + k.x * r.w, r.y + k.y * r.h);
      ctx.rotate(((k.rot || 0) * Math.PI) / 180);
      ctx.scale(k.size * r.w, k.size * r.w);
      (STICKERS[k.type] || STICKERS.heart)(ctx);
      ctx.restore();
    }
    ctx.restore();
  }

  /* Finds the transparent photo spots in a frame PNG. Returns [{x,y,w,h}] as fractions,
     ordered top to bottom then left to right. */
  function detectSlots(img) {
    const w = Math.min(320, img.width);
    const h = Math.max(1, Math.round((w * img.height) / img.width));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const seen = new Uint8Array(w * h);
    const out = [];
    const stack = [];
    for (let start = 0; start < w * h; start++) {
      if (seen[start] || d[start * 4 + 3] >= 40) continue;
      let minX = w, maxX = 0, minY = h, maxY = 0, count = 0;
      stack.push(start);
      seen[start] = 1;
      while (stack.length) {
        const p = stack.pop();
        const x = p % w, y = (p - x) / w;
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
        for (const q of nb) if (q >= 0 && !seen[q] && d[q * 4 + 3] < 40) { seen[q] = 1; stack.push(q); }
      }
      const bw = maxX - minX + 1, bh = maxY - minY + 1;
      const area = bw * bh;
      // Ignore specks, thin slivers, and a transparent margin that wraps the whole frame.
      if (area < w * h * 0.015 || count < area * 0.5 || area > w * h * 0.9) continue;
      out.push({ x: minX / w, y: minY / h, w: bw / w, h: bh / h });
    }
    out.sort((a, b) => (Math.abs(a.y - b.y) < 0.05 ? a.x - b.x : a.y - b.y));
    return out.slice(0, 8);
  }

  function drawQr(ctx, W, y, qr) {
    const px = Math.max(3, Math.floor((W * 0.44) / qr.size));
    const total = px * qr.size;
    const x0 = Math.round((W - total) / 2);
    y += px * 4;
    ctx.fillStyle = '#000';
    for (let yy = 0; yy < qr.size; yy++)
      for (let xx = 0; xx < qr.size; xx++)
        if (qr.m[yy * qr.size + xx]) ctx.fillRect(x0 + xx * px, y + yy * px, px, px);
    y += total + px * 3;
    const size = Math.round(W * 0.042);
    ctx.font = `700 ${size}px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('SCAN FOR YOUR PHOTO', W / 2, y);
    return y + Math.round(size * 1.3);
  }

  /* Transparent layer holding every slot's stickers and drawing. */
  function decorLayer(w, h, rects, decor) {
    if (!decor || !decor.some((d) => d && ((d.stickers && d.stickers.length) || (d.strokes && d.strokes.length)))) return null;
    const ov = document.createElement('canvas');
    ov.width = w;
    ov.height = h;
    const ctx = ov.getContext('2d', { willReadFrequently: true });
    rects.forEach((r, i) => drawDecor(ctx, r, decor[i]));
    return ov;
  }

  /* Operator's own frame PNG: photos go into its transparent spots, the artwork sits on top. */
  function buildFramed(opts) {
    const f = opts.frame;
    const W = opts.dots || dotsFor(opts.paperWidth);
    const H = Math.round((W * f.h) / f.w);
    const qrRoom = opts.qr ? Math.max(3, Math.floor((W * 0.44) / opts.qr.size)) * (opts.qr.size + 7) + Math.round(W * 0.1) : 0;
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H + qrRoom;
    const ctx = out.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, out.height);
    const rects = f.slots.map((s) => ({
      x: Math.round(s.x * W), y: Math.round(s.y * H), w: Math.round(s.w * W), h: Math.round(s.h * H),
    }));
    rects.forEach((r, i) => {
      const img = opts.photos[i];
      if (img) drawPhoto(ctx, img, r, opts.xf && opts.xf[i], opts.look, opts.beauty);
    });
    ctx.drawImage(f.img, 0, 0, W, H);
    if (opts.qr) drawQr(ctx, W, H, opts.qr);
    const overlay = decorLayer(W, out.height, rects, opts.decor);
    if (overlay && opts.flatten) ctx.drawImage(overlay, 0, 0);
    return { canvas: out, rects, overlay, ditherRest: true };
  }

  function wrap(ctx, text, maxW) {
    const lines = [];
    for (const para of String(text).split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/)) {
        const t = line ? line + ' ' + word : word;
        if (line && ctx.measureText(t).width > maxW) { lines.push(line); line = word; }
        else line = t;
      }
      lines.push(line);
    }
    return lines;
  }

  const spaced = (t) => String(t).split('').join(' ');

  /* Drawing helpers shared by the themes. P.y is the running cursor. */
  function makePen(ctx, W, s, info) {
    const m = Math.round(W * 0.05);
    const gap = Math.round(W * 0.03);
    const P = {
      ctx, W, m, gap, s, inner: W - 2 * m, body: Math.round(W * 0.05), y: m,
      orderNo: info.orderNo || 1, order: info.order, dateStr: info.dateStr, dateOnly: info.dateOnly, count: info.count, showDate: info.showDate,

      rule() {
        P.y += gap;
        const dash = Math.max(4, Math.round(W / 64));
        for (let x = m; x < W - m; x += dash * 2) ctx.fillRect(x, P.y, dash, 2);
        P.y += 2 + gap;
      },
      center(text, weight, size, lh, family) {
        ctx.font = `${weight} ${size}px ${family || MONO}`;
        ctx.textAlign = 'center';
        for (const line of wrap(ctx, text, P.inner)) {
          ctx.fillText(line, W / 2, P.y);
          P.y += Math.round(size * (lh || 1.3));
        }
      },
      pair(left, right, bold) {
        ctx.font = `${bold ? 700 : 400} ${P.body}px ${MONO}`;
        ctx.textAlign = 'left';
        ctx.fillText(left, m, P.y);
        ctx.textAlign = 'right';
        ctx.fillText(right, W - m, P.y);
        P.y += Math.round(P.body * 1.4);
      },
      /* Event title in the chosen font, shrunk to fit maxW. */
      title(scale, maxW) {
        if (!s.title) return;
        const fam = TITLE_FONTS[s.titleFont] || MONO;
        const limit = maxW || P.inner;
        let size = Math.round(W * (scale || 0.15));
        ctx.font = `400 ${size}px ${fam}`;
        const tw = ctx.measureText(s.title).width;
        if (tw > limit) size = Math.max(14, Math.floor((size * limit) / tw));
        ctx.font = `400 ${size}px ${fam}`;
        ctx.textAlign = 'center';
        ctx.fillText(s.title, W / 2, P.y);
        P.y += Math.round(size * 1.15);
      },
      /* Solid black band with reversed text. */
      band(text) {
        const h = Math.round(P.body * 2.2);
        ctx.fillRect(m, P.y, P.inner, h);
        ctx.fillStyle = '#fff';
        ctx.font = `700 ${P.body}px ${MONO}`;
        ctx.textAlign = 'center';
        ctx.fillText(spaced(text), W / 2, P.y + Math.round((h - P.body) / 2) - 1);
        ctx.fillStyle = '#000';
        P.y += h;
      },
      /* Row of small-label / big-value columns. */
      cols(items) {
        const cw = P.inner / items.length;
        const small = Math.round(P.body * 0.72);
        const big = Math.round(P.body * 1.15);
        ctx.textAlign = 'left';
        items.forEach(([k, v], i) => {
          const x = m + Math.round(i * cw);
          ctx.font = `400 ${small}px ${MONO}`;
          ctx.fillText(k, x, P.y);
          ctx.font = `700 ${big}px ${MONO}`;
          ctx.fillText(v, x, P.y + Math.round(small * 1.3));
        });
        P.y += Math.round(small * 1.3 + big * 1.5);
      },
      /* Decorative barcode, deterministic per order number. */
      barcode() {
        P.y += gap;
        let seed = ((info.orderNo || 1) * 2654435761) >>> 0;
        const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
        const bh = Math.round(W * 0.11);
        const unit = Math.max(2, Math.round(W / 190));
        let x = m + Math.round(P.inner * 0.1);
        const end = W - m - Math.round(P.inner * 0.1);
        let ink = true;
        while (x < end) {
          const bw = unit * (1 + Math.floor(rnd() * 3));
          if (ink) ctx.fillRect(x, P.y, Math.min(bw, end - x), bh);
          x += bw;
          ink = !ink;
        }
        P.y += bh + Math.round(gap / 2);
        P.center(P.order, 400, Math.round(P.body * 0.85));
      },
      footerText() {
        if (s.footer) P.center(s.footer, 400, P.body, 1.35);
      },
    };
    return P;
  }

  const THEMES = {
    classic: {
      header(P) {
        const s = P.s;
        P.title(0.15);
        if (s.subtitle) P.center(s.subtitle, 400, Math.round(P.W * 0.05));
        P.rule();
        if (s.receiptLines) P.pair('ORDER ' + P.order, P.showDate ? P.dateStr : '');
        else if (P.showDate) P.center(P.dateStr, 400, P.body);
        if (s.receiptLines || P.showDate) P.y += P.gap;
      },
      footer(P) {
        const s = P.s;
        P.rule();
        if (s.receiptLines) {
          P.pair(`${P.count} x MEMORIES`, 'PRICELESS');
          P.pair('TOTAL', 'PRICELESS', true);
          P.y += P.gap;
        }
        P.footerText();
        if (s.receiptLines) P.barcode();
      },
    },

    boarding: {
      header(P) {
        const s = P.s;
        P.band('BOARDING PASS');
        P.y += P.gap;
        P.title(0.12);
        if (s.subtitle) P.center(s.subtitle, 400, Math.round(P.W * 0.045));
        P.rule();
        P.cols([['FROM', 'HERE'], ['TO', 'FOREVER']]);
        P.cols([['FLIGHT', 'RP' + P.order.slice(1)], ['DATE', P.showDate ? P.dateOnly : 'TODAY']]);
        P.cols([['GATE', 'SMILE'], ['SEAT', P.count + 'A']]);
        P.y += Math.round(P.gap / 2);
      },
      footer(P) {
        P.rule();
        P.center('PASSENGERS: THE BEST COMPANY', 700, Math.round(P.body * 0.85));
        P.y += Math.round(P.gap / 2);
        P.footerText();
        P.barcode();
      },
    },

    cinema: {
      header(P) {
        const s = P.s, ctx = P.ctx;
        const y0 = P.y;
        const pad = Math.round(P.gap * 1.2);
        P.y += pad;
        P.center(spaced('ADMIT ONE'), 700, P.body);
        P.y += Math.round(P.gap / 3);
        P.title(0.13, P.inner - pad * 2);
        P.y += Math.round(pad / 2);
        ctx.lineWidth = 3;
        ctx.strokeRect(P.m + 1.5, y0 + 1.5, P.inner - 3, P.y - y0 - 3);
        ctx.lineWidth = 2;
        ctx.strokeRect(P.m + 8, y0 + 8, P.inner - 16, P.y - y0 - 16);
        P.y += P.gap * 2;
        if (s.subtitle) {
          P.center('NOW SHOWING', 400, Math.round(P.body * 0.75));
          P.center(s.subtitle, 700, P.body);
          P.y += Math.round(P.gap / 2);
        }
        P.pair('ROW  FUN', 'SEAT  ' + P.order.slice(1));
        if (P.showDate) P.pair('SCREENING', P.dateStr);
        P.y += P.gap;
      },
      footer(P) {
        const ctx = P.ctx;
        // Perforation line
        P.y += P.gap * 1.5;
        const r = Math.max(2, Math.round(P.W / 130));
        for (let x = P.m + r; x < P.W - P.m; x += r * 4) {
          ctx.beginPath();
          ctx.arc(x, P.y, r, 0, Math.PI * 2);
          ctx.fill();
        }
        P.y += P.gap * 1.5;
        P.center('RATED G: FOR GORGEOUS', 700, Math.round(P.body * 0.85));
        P.y += Math.round(P.gap / 2);
        P.footerText();
        P.barcode();
      },
    },
  };

  /* ---------- AI Bots Agency themes ----------
     Each guest gets a made-up agent persona, fixed per order number so reprints match. */
  const BOT_NAMES = ['NOVA', 'PIXEL', 'ECHO', 'BOLT', 'ORBIT', 'SPARK', 'CIPHER', 'NEON', 'QUBIT', 'VECTOR', 'HALO', 'GLITCH', 'TURBO', 'ZENITH', 'BYTE', 'COMET'];
  const BOT_ROLES = ['CHIEF SMILE OFFICER', 'POSE ENGINEER', 'VIBE ANALYST', 'SELFIE ARCHITECT', 'JOY OPTIMIZER', 'FUN DEPLOYER', 'GRIN STRATEGIST', 'MEMORY CURATOR'];
  const BOT_MODELS = ['SMILE-7B', 'POSE-X 2.0', 'GRIN-LM 13B', 'JOY-NET 4', 'VIBE-3 TURBO', 'FLASH-1 MINI'];
  function persona(no) {
    let seed = (((no || 1) + 7) * 2654435761) >>> 0;
    const pick = (arr) => { seed = (seed * 1664525 + 1013904223) >>> 0; return arr[seed % arr.length]; };
    return { name: pick(BOT_NAMES), role: pick(BOT_ROLES), model: pick(BOT_MODELS), level: 1 + (seed % 9) };
  }

  Object.assign(THEMES, {
    agent: {
      header(P) {
        const p = persona(P.orderNo);
        P.band('AI BOTS AGENCY');
        P.y += P.gap;
        P.center('OFFICIAL AGENT CREDENTIALS', 700, Math.round(P.body * 0.8));
        P.y += Math.round(P.gap / 2);
        P.title(0.14);
        if (P.s.subtitle) P.center(P.s.subtitle, 400, Math.round(P.W * 0.045));
        P.rule();
        P.cols([['AGENT', p.name], ['UNIT', 'BOT-' + P.order.slice(1)]]);
        P.cols([['MODEL', p.model], ['CLEARANCE', 'LVL ' + p.level]]);
        P.y += Math.round(P.gap / 2);
      },
      footer(P) {
        const p = persona(P.orderNo);
        P.y += P.gap;
        P.cols([['ROLE', p.role]]);
        P.pair('STATUS', 'DEPLOYED', true);
        P.pair('HUMANS', P.count > 1 ? P.count + ' VERIFIED' : 'VERIFIED');
        if (P.showDate) P.pair('ACTIVATED', P.dateOnly);
        P.rule();
        P.center('THIS AGENT RUNS ON GOOD VIBES', 700, Math.round(P.body * 0.8));
        P.y += Math.round(P.gap / 2);
        P.footerText();
        P.barcode();
      },
    },

    invoice: {
      header(P) {
        const s = P.s;
        P.title(0.14);
        if (s.subtitle) P.center(s.subtitle, 400, Math.round(P.W * 0.045));
        P.y += Math.round(P.gap / 2);
        P.band('BOT INVOICE');
        P.y += P.gap;
        P.pair('INVOICE', 'AI-' + P.order.slice(1));
        if (P.showDate) P.pair('DATE', P.dateStr);
        P.pair('CLIENT', 'YOU, A HUMAN');
        P.y += Math.round(P.gap / 2);
      },
      footer(P) {
        P.rule();
        P.pair('QTY ITEM', 'AMOUNT', true);
        P.pair(`${P.count} PHOTO RENDERS`, 'FREE');
        P.pair('1 PROMPT: "SMILE"', '0.00');
        P.pair('GPU HOURS', '0.00');
        P.pair('HALLUCINATIONS', '0');
        P.pair('GOOD VIBES', '+100%');
        P.rule();
        P.pair('TOTAL', 'PRICELESS', true);
        P.pair('PAID WITH', 'SMILES');
        P.y += P.gap;
        P.center('NO HUMANS WERE REPLACED', 700, Math.round(P.body * 0.8));
        P.center('IN THE MAKING OF THIS PHOTO', 400, Math.round(P.body * 0.8));
        P.y += Math.round(P.gap / 2);
        P.footerText();
        P.barcode();
      },
    },

    terminal: {
      header(P) {
        const ctx = P.ctx;
        const size = Math.round(P.body * 0.85);
        const lh = Math.round(size * 1.45);
        const line = (left, right) => {
          ctx.font = `400 ${size}px ${MONO}`;
          ctx.textAlign = 'left';
          ctx.fillText(left, P.m, P.y);
          if (right) {
            ctx.font = `700 ${size}px ${MONO}`;
            ctx.textAlign = 'right';
            ctx.fillText(right, P.W - P.m, P.y);
          }
          P.y += lh;
        };
        P.title(0.13);
        if (P.s.subtitle) P.center(P.s.subtitle.toUpperCase(), 700, Math.round(P.body * 0.85));
        P.rule();
        line('> boot agent ' + persona(P.orderNo).name.toLowerCase());
        line('> load personality', '[ OK ]');
        line('> calibrate smile', '[ OK ]');
        line('> scan humans: ' + P.count, '[ OK ]');
        line('> capture memories');
        P.y += Math.round(P.gap / 2);
      },
      footer(P) {
        const ctx = P.ctx;
        const size = Math.round(P.body * 0.85);
        P.y += P.gap;
        ctx.font = `400 ${size}px ${MONO}`;
        ctx.textAlign = 'left';
        ctx.fillText('> render receipt', P.m, P.y);
        ctx.font = `700 ${size}px ${MONO}`;
        ctx.textAlign = 'right';
        ctx.fillText('[DONE]', P.W - P.m, P.y);
        P.y += Math.round(size * 1.45);
        // progress bar
        const h = Math.round(size * 0.9);
        ctx.lineWidth = 2;
        ctx.strokeRect(P.m + 1, P.y + 1, P.inner - 2, h);
        ctx.fillRect(P.m + 4, P.y + 4, P.inner - 8, h - 6);
        P.y += h + Math.round(size * 0.5);
        P.center('100% · ' + (P.showDate ? P.dateStr : 'NOW'), 400, size);
        P.rule();
        P.center('SESSION ' + P.order + ' TERMINATED', 700, size);
        P.center('HUMANS HAD FUN. :)', 400, size);
        P.y += Math.round(P.gap / 2);
        P.footerText();
        P.barcode();
      },
    },
  });

  /* opts: { paperWidth, layout, theme, photos: [canvas|img], s: settings, orderNo, date }
     returns { canvas, rects: [{x,y,w,h}] } */
  function build(opts) {
    if (opts.frame) return buildFramed(opts);
    const s = opts.s;
    const W = opts.dots || dotsFor(opts.paperWidth); // opts.dots: larger render for the colour copy
    const L = LAYOUTS[opts.layout] || LAYOUTS.strip3;
    const theme = THEMES[opts.theme] || THEMES.classic;

    const work = document.createElement('canvas');
    work.width = W;
    work.height = W * 10;
    const ctx = work.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, work.height);
    ctx.fillStyle = '#000';
    ctx.strokeStyle = '#000';
    ctx.textBaseline = 'top';

    const d = opts.date || new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    // Date on the print: automatic, the operator's own text, or none at all.
    const mode = s.dateMode || 'auto';
    const custom = mode === 'custom' && s.dateText ? String(s.dateText) : '';
    const dateOnly = custom || `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    const P = makePen(ctx, W, s, {
      orderNo: opts.orderNo,
      order: '#' + String(opts.orderNo || 1).padStart(4, '0'),
      dateOnly,
      dateStr: custom || `${dateOnly} ${p2(d.getHours())}:${p2(d.getMinutes())}`,
      showDate: mode !== 'none',
      count: L.count,
    });

    if (opts.logo && s.logoOnPrint) {
      const lw = opts.logo.width, lh = opts.logo.height;
      const k = Math.min((P.inner * 0.6) / lw, (W * 0.26) / lh);
      const w = Math.round(lw * k), h = Math.round(lh * k);
      ctx.drawImage(opts.logo, Math.round((W - w) / 2), P.y, w, h);
      P.y += h + P.gap;
    }

    theme.header(P);

    const rects = [];
    const slotW = Math.floor((P.inner - (L.cols - 1) * P.gap) / L.cols);
    const slotH = Math.round(slotW / L.aspect);
    for (let i = 0; i < L.count; i++) {
      const col = i % L.cols;
      if (col === 0 && i > 0) P.y += slotH + P.gap;
      const r = { x: P.m + col * (slotW + P.gap), y: P.y, w: slotW, h: slotH };
      rects.push(r);
      const img = opts.photos[i];
      if (img) drawPhoto(ctx, img, r, opts.xf && opts.xf[i], opts.look, opts.beauty);
      else { ctx.fillStyle = '#bbb'; ctx.fillRect(r.x, r.y, r.w, r.h); ctx.fillStyle = '#000'; }
    }
    P.y += slotH;

    theme.footer(P);

    // QR to the guest's download page (print only; the colour copy leaves it out).
    if (opts.qr) P.y = drawQr(ctx, W, P.y, opts.qr);
    P.y += P.m;

    const out = document.createElement('canvas');
    out.width = W;
    out.height = Math.round(P.y);
    const octx = out.getContext('2d', { willReadFrequently: true });
    octx.drawImage(work, 0, 0);
    const overlay = decorLayer(W, out.height, rects, opts.decor);
    if (overlay && opts.flatten) octx.drawImage(overlay, 0, 0);
    return { canvas: out, rects, overlay, ditherRest: false };
  }

  /* Small slip with a voucher code, printed when the operator queues vouchers from their phone. */
  function voucherSlip(paperWidth, s, code, dots) {
    const W = dots || dotsFor(paperWidth);
    const work = document.createElement('canvas');
    work.width = W;
    work.height = W * 3;
    const ctx = work.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, work.height);
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'top';
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const dateStr = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
    const P = makePen(ctx, W, s, { order: '', dateStr, dateOnly: dateStr, count: 1, showDate: true });
    P.band('VOUCHER');
    P.y += P.gap;
    P.title(0.11);
    P.rule();
    P.center('YOUR CODE', 400, Math.round(P.body * 0.8));
    P.center(String(code).split('').join(' '), 400, Math.round(W * 0.14), 1.25, TITLE_FONTS['Archivo Black']);
    P.y += P.gap;
    P.center('Enter this code at the booth. Valid for one use.', 400, Math.round(P.body * 0.85), 1.35);
    P.rule();
    P.center(dateStr, 400, Math.round(P.body * 0.8));
    P.y += P.m;
    const out = document.createElement('canvas');
    out.width = W;
    out.height = Math.round(P.y);
    out.getContext('2d').drawImage(work, 0, 0);
    return toBitmap(out, [], s, 'normal');
  }

  /* Text and rules are thresholded for crisp edges; photo slots go through the dither pipeline. */
  /* extra: { ditherRest (frame artwork is dithered instead of thresholded), overlay (stickers
     and drawing, stamped on after dithering so they stay solid) } */
  function toBitmap(canvas, rects, s, filter, extra) {
    const w = canvas.width, h = canvas.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const g = RPB.imaging.toGray(ctx.getImageData(0, 0, w, h));
    let bits;
    if (extra && extra.ditherRest) {
      bits = RPB.imaging.dither(Float32Array.from(g), w, h, 'floyd');
    } else {
      bits = new Uint8Array(w * h);
      for (let i = 0; i < g.length; i++) bits[i] = g[i] < 0.55 ? 1 : 0;
    }
    for (const r of rects) {
      const sub = new Float32Array(r.w * r.h);
      for (let yy = 0; yy < r.h; yy++)
        sub.set(g.subarray((r.y + yy) * w + r.x, (r.y + yy) * w + r.x + r.w), yy * r.w);
      const pb = RPB.imaging.processPhoto(sub, r.w, r.h, s, filter);
      for (let yy = 0; yy < r.h; yy++)
        bits.set(pb.subarray(yy * r.w, (yy + 1) * r.w), (r.y + yy) * w + r.x);
    }
    if (extra && extra.overlay) {
      const od = extra.overlay.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
      for (let i = 0, p = 0; i < bits.length; i++, p += 4) {
        if (od[p + 3] > 127) bits[i] = 0.299 * od[p] + 0.587 * od[p + 1] + 0.114 * od[p + 2] < 140 ? 1 : 0;
      }
    }
    return { bits, w, h };
  }

  /* Centres a narrower bitmap on the full paper width and shifts it left or right. */
  function padBitmap(b, fullW, shift) {
    shift = shift | 0;
    if (b.w === fullW && !shift) return b;
    const bits = new Uint8Array(fullW * b.h);
    const x0 = Math.floor((fullW - b.w) / 2) + shift;
    for (let y = 0; y < b.h; y++)
      for (let x = 0; x < b.w; x++) {
        const tx = x0 + x;
        if (tx >= 0 && tx < fullW && b.bits[y * b.w + x]) bits[y * fullW + tx] = 1;
      }
    return { bits, w: fullW, h: b.h };
  }

  /* Ruler page for setting print width and shift. The outer lines are the true paper edges;
     the dashed box is the area the receipts currently use. */
  function calibrationPage(fullW, effW, shift) {
    const H = 300;
    const c = document.createElement('canvas');
    c.width = fullW;
    c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, fullW, H);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, fullW, 3);
    ctx.fillRect(0, H - 3, fullW, 3);
    ctx.fillRect(0, 0, 3, H);
    ctx.fillRect(fullW - 3, 0, 3, H);
    ctx.font = `700 16px ${MONO}`;
    ctx.textBaseline = 'top';
    for (let x = 0; x <= fullW; x += 8) {
      const major = x % 80 === 0;
      ctx.fillRect(Math.min(x, fullW - 1), 3, 1, major ? 26 : x % 40 === 0 ? 16 : 8);
      if (major && x > 0 && x < fullW - 30) { ctx.textAlign = 'center'; ctx.fillText(String(x), x, 32); }
    }
    const x0 = Math.floor((fullW - effW) / 2) + (shift | 0);
    ctx.setLineDash([8, 6]);
    ctx.lineWidth = 2;
    ctx.strokeRect(x0 + 1, 70, effW - 2, 150);
    ctx.setLineDash([]);
    ctx.textAlign = 'center';
    ctx.fillText('PRINT AREA', x0 + effW / 2, 86);
    ctx.fillText(`${effW} of ${fullW} dots, shift ${shift | 0}`, x0 + effW / 2, 112);
    ctx.textAlign = 'left';
    ctx.fillText('< L', x0 + 10, 180);
    ctx.textAlign = 'right';
    ctx.fillText('R >', x0 + effW - 10, 180);
    ctx.textAlign = 'center';
    ctx.font = `400 14px ${MONO}`;
    ctx.fillText('All four outer lines should print.', fullW / 2, 236);
    ctx.fillText('If a side is cut, shrink or shift.', fullW / 2, 258);
    return toBitmap(c, [], {}, 'normal');
  }

  function paint(bitmap, canvas) {
    canvas.width = bitmap.w;
    canvas.height = bitmap.h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(bitmap.w, bitmap.h);
    const px = new Uint32Array(img.data.buffer);
    for (let i = 0; i < bitmap.bits.length; i++) px[i] = bitmap.bits[i] ? 0xff1a1a1a : 0xffffffff;
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /* Tinted "Photo N" stand-in used by the template gallery. */
  function placeholder(n) {
    const c = document.createElement('canvas');
    c.width = 480;
    c.height = 480;
    const x = c.getContext('2d');
    x.fillStyle = n % 2 ? '#ffe7a0' : '#dfe3e8';
    x.fillRect(0, 0, 480, 480);
    x.fillStyle = n % 2 ? '#7a5b00' : '#4a5562';
    x.font = '700 34px "Space Mono", monospace';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText('Photo ' + n, 240, 240);
    return c;
  }

  /* Synthetic photo for test prints: tonal ramp, soft sphere and fine lines. */
  function testPhoto() {
    const c = document.createElement('canvas');
    c.width = c.height = 600;
    const x = c.getContext('2d');
    const lin = x.createLinearGradient(0, 0, 600, 0);
    lin.addColorStop(0, '#000');
    lin.addColorStop(1, '#fff');
    x.fillStyle = lin;
    x.fillRect(0, 0, 600, 600);
    const rad = x.createRadialGradient(260, 250, 10, 300, 300, 230);
    rad.addColorStop(0, '#fff');
    rad.addColorStop(1, '#111');
    x.fillStyle = rad;
    x.beginPath();
    x.arc(300, 300, 220, 0, Math.PI * 2);
    x.fill();
    for (let i = 0; i < 16; i++) {
      x.fillStyle = `rgb(${i * 17},${i * 17},${i * 17})`;
      x.fillRect(i * 37.5, 540, 37.5, 60);
    }
    x.fillStyle = '#fff';
    for (let i = 0; i < 12; i++) x.fillRect(20 + i * 6, 20, 1 + (i % 3), 70);
    return c;
  }

  RPB.compose = { LAYOUTS, TEMPLATES, TITLE_FONTS, dotsFor, loadFonts, build, drawPhoto, voucherSlip, toBitmap,
    STICKERS, persona, drawDecor, detectSlots, padBitmap, calibrationPage, paint, placeholder, testPhoto };
})();
