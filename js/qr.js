/* QR code encoder: byte mode, versions 1-10, error correction M when it fits the version, else L.
   encode(text) -> { size, m } where m is a Uint8Array of size*size, 1 = dark module. */
(function () {
  const RPB = (window.RPB = window.RPB || {});

  const ECC_PER_BLOCK = { L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18], M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26] };
  const NUM_BLOCKS = { L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4], M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5] };
  const FORMAT_BITS = { L: 1, M: 0 };

  function rawModules(ver) {
    let r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const n = Math.floor(ver / 7) + 2;
      r -= (25 * n - 10) * n - 55;
      if (ver >= 7) r -= 36;
    }
    return r;
  }
  const dataCodewords = (ver, ecl) => (rawModules(ver) >>> 3) - ECC_PER_BLOCK[ecl][ver - 1] * NUM_BLOCKS[ecl][ver - 1];

  /* GF(2^8) arithmetic and Reed-Solomon, polynomial 0x11D. */
  function mul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
  }
  function rsDivisor(degree) {
    const res = new Array(degree).fill(0);
    res[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < degree; j++) {
        res[j] = mul(res[j], root);
        if (j + 1 < degree) res[j] ^= res[j + 1];
      }
      root = mul(root, 2);
    }
    return res;
  }
  function rsRemainder(data, divisor) {
    const res = divisor.map(() => 0);
    for (const b of data) {
      const factor = b ^ res.shift();
      res.push(0);
      divisor.forEach((coef, i) => (res[i] ^= mul(coef, factor)));
    }
    return res;
  }

  const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];

  function encode(text, forceMask) {
    const bytes = Array.from(new TextEncoder().encode(String(text)));
    let ver = 0, ecl = 'L';
    for (let v = 1; v <= 10 && !ver; v++) {
      const need = 4 + (v < 10 ? 8 : 16) + bytes.length * 8;
      if (need <= dataCodewords(v, 'L') * 8) {
        ver = v;
        if (need <= dataCodewords(v, 'M') * 8) ecl = 'M';
      }
    }
    if (!ver) throw new Error('That link is too long for a QR code.');

    // Data bits: mode, length, payload, terminator, padding.
    const cap = dataCodewords(ver, ecl) * 8;
    const bits = [];
    const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    push(4, 4);
    push(bytes.length, ver < 10 ? 8 : 16);
    bytes.forEach((b) => push(b, 8));
    push(0, Math.min(4, cap - bits.length));
    push(0, (8 - (bits.length % 8)) % 8);
    for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) push(pad, 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      data.push(b);
    }

    // Error correction blocks, interleaved.
    const nb = NUM_BLOCKS[ecl][ver - 1], el = ECC_PER_BLOCK[ecl][ver - 1];
    const raw = rawModules(ver) >>> 3;
    const nShort = nb - (raw % nb), shortLen = Math.floor(raw / nb);
    const divisor = rsDivisor(el);
    const blocks = [];
    for (let i = 0, k = 0; i < nb; i++) {
      const dat = data.slice(k, k + shortLen - el + (i < nShort ? 0 : 1));
      k += dat.length;
      const ecc = rsRemainder(dat, divisor);
      if (i < nShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    const all = [];
    for (let i = 0; i < blocks[0].length; i++)
      for (let j = 0; j < nb; j++)
        if (i !== shortLen - el || j >= nShort) all.push(blocks[j][i]);

    // Function patterns.
    const size = 17 + 4 * ver;
    const m = new Uint8Array(size * size);
    const fn = new Uint8Array(size * size);
    const setF = (x, y, dark) => { m[y * size + x] = dark ? 1 : 0; fn[y * size + x] = 1; };

    for (let i = 0; i < size; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          const x = cx + dx, y = cy + dy;
          if (x >= 0 && x < size && y >= 0 && y < size) setF(x, y, d !== 2 && d !== 4);
        }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);

    const align = [];
    if (ver > 1) {
      const n = Math.floor(ver / 7) + 2;
      const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
      align.push(6);
      for (let pos = size - 7; align.length < n; pos -= step) align.splice(1, 0, pos);
    }
    const na = align.length;
    for (let i = 0; i < na; i++)
      for (let j = 0; j < na; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++)
            setF(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }

    const drawFormat = (mask) => {
      const d = (FORMAT_BITS[ecl] << 3) | mask;
      let rem = d;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const f = ((d << 10) | rem) ^ 0x5412;
      const bit = (i) => ((f >>> i) & 1) !== 0;
      for (let i = 0; i <= 5; i++) setF(8, i, bit(i));
      setF(8, 7, bit(6)); setF(8, 8, bit(7)); setF(7, 8, bit(8));
      for (let i = 9; i < 15; i++) setF(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) setF(size - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) setF(8, size - 15 + i, bit(i));
      setF(8, size - 8, true);
    };
    drawFormat(0);

    if (ver >= 7) {
      let rem = ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const v = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const dark = ((v >>> i) & 1) !== 0;
        const a = size - 11 + (i % 3), b = Math.floor(i / 3);
        setF(a, b, dark);
        setF(b, a, dark);
      }
    }

    // Data modules in the zigzag scan.
    let k = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!fn[y * size + x] && k < all.length * 8) {
            m[y * size + x] = (all[k >>> 3] >>> (7 - (k & 7))) & 1;
            k++;
          }
        }
      }
    }

    const applyMask = (mask) => {
      const f = MASKS[mask];
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++)
          if (!fn[y * size + x] && f(x, y)) m[y * size + x] ^= 1;
    };

    // Lower is better: long runs, 2x2 blocks and dark/light imbalance.
    const penalty = () => {
      let p = 0, dark = 0;
      for (let y = 0; y < size; y++) {
        let runX = 1, runY = 1;
        for (let x = 0; x < size; x++) {
          dark += m[y * size + x];
          if (x > 0) {
            if (m[y * size + x] === m[y * size + x - 1]) { runX++; if (runX === 5) p += 3; else if (runX > 5) p++; } else runX = 1;
            if (m[x * size + y] === m[(x - 1) * size + y]) { runY++; if (runY === 5) p += 3; else if (runY > 5) p++; } else runY = 1;
          }
          if (x > 0 && y > 0) {
            const c = m[y * size + x];
            if (c === m[y * size + x - 1] && c === m[(y - 1) * size + x] && c === m[(y - 1) * size + x - 1]) p += 3;
          }
        }
      }
      return p + Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
    };

    let best = forceMask;
    if (best == null) {
      let low = Infinity;
      for (let i = 0; i < 8; i++) {
        applyMask(i);
        drawFormat(i);
        const p = penalty();
        if (p < low) { low = p; best = i; }
        applyMask(i);
      }
    }
    applyMask(best);
    drawFormat(best);
    return { size, m, version: ver, ecl, mask: best };
  }

  /* Paints a QR onto a canvas with a 4-module quiet zone. */
  function toCanvas(qr, canvas, px) {
    const q = 4;
    canvas.width = canvas.height = (qr.size + q * 2) * px;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    for (let y = 0; y < qr.size; y++)
      for (let x = 0; x < qr.size; x++)
        if (qr.m[y * qr.size + x]) ctx.fillRect((x + q) * px, (y + q) * px, px, px);
    return canvas;
  }

  RPB.qr = { encode, toCanvas };
})();
