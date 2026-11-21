/* Receipt Photobooth: kiosk flow, camera capture, editing, settings and printing. */
(function () {
  const RPB = window.RPB;
  const { imaging, compose, escpos, printer } = RPB;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  const DEFAULTS = {
    connection: 'usb', paperWidth: 58, baud: 9600, chunkRows: 128, feedLines: 3, cut: true,
    dither: 'floyd', brightness: 0, contrast: 0, gamma: 1, sharpen: 30, autoLevels: true, faceBoost: true,
    title: 'AI BOTS AGENCY', titleFont: 'Archivo Black', subtitle: 'Humans + bots, one photo',
    footer: 'Thanks for hanging out with our bots!', dateMode: 'auto', dateText: '', receiptLines: true,
    logoOnPrint: true, accent: '#5ef2c2',
    cameraId: '', countdown: 3, mirror: true, sound: true, retakeLimit: 2,
    sessionLimit: 300, copiesMax: 2, printMore: true, printMorePrice: '₱20 per copy', printMoreMax: 5, autoSave: false,
    resultIdle: 60, pin: '1234',
    btAddress: '', printerIp: '',
    shareOn: false, shareUrl: '', shareKey: '', eventCode: '', galleryOn: false,
    voucherPrint: false, requireVoucher: false,
    paperCheck: true, printScale: 100, printShift: 0,
    welcomeFit: 'cover', welcomeCta: true, hideBuiltinStickers: false, printAnim: true, splash: true,
    tplPinned: [], tplHidden: [],
  };
  const freshDefaults = () => JSON.parse(JSON.stringify(DEFAULTS));
  const NATIVE = !!RPB.native;
  const NATIVE_ONLY = ['btclassic', 'network'];
  const WEB_ONLY = ['bluetooth', 'serial', 'browser'];
  const STORE = 'rpb.settings.v1';
  const IDLE_SECONDS = 120;

  function loadSettings() {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (e) { stored = {}; }
    const s = Object.assign(freshDefaults(), stored);
    if (stored.showDate === false && !stored.dateMode) s.dateMode = 'none';
    if (!Array.isArray(s.tplPinned)) s.tplPinned = [];
    if (!Array.isArray(s.tplHidden)) s.tplHidden = [];
    if ((NATIVE ? WEB_ONLY : NATIVE_ONLY).includes(s.connection)) s.connection = 'usb';
    return s;
  }
  function saveSettings() {
    try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) { /* private mode */ }
  }
  function nextOrderNo() {
    let n = 1;
    try { n = (parseInt(localStorage.getItem('rpb.order'), 10) || 0) + 1; localStorage.setItem('rpb.order', String(n)); } catch (e) { /* ignore */ }
    return n;
  }

  /* Uploaded files (logo, background, thank-you sound) live outside the settings object. */
  const ASSET = {
    get(k) { try { return localStorage.getItem('rpb.asset.' + k) || ''; } catch (e) { return ''; } },
    set(k, v) {
      try {
        if (v) localStorage.setItem('rpb.asset.' + k, v); else localStorage.removeItem('rpb.asset.' + k);
        return true;
      } catch (e) { return false; }
    },
  };

  /* Large files (the welcome design can be a video) go to IndexedDB, which has room for them. */
  const BIG = {
    open() {
      return new Promise((res, rej) => {
        const r = indexedDB.open('rpb', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('assets');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    },
    async get(key) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const q = db.transaction('assets').objectStore('assets').get(key);
        q.onsuccess = () => res(q.result || null);
        q.onerror = () => rej(q.error);
      });
    },
    async set(key, value) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const tx = db.transaction('assets', 'readwrite');
        if (value == null) tx.objectStore('assets').delete(key); else tx.objectStore('assets').put(value, key);
        tx.oncomplete = () => res();
        tx.onerror = tx.onabort = () => rej(tx.error || new Error('Storage failed.'));
      });
    },
  };

  let S = loadSettings();
  const share = RPB.share;
  const configShare = () => share.configure({ url: S.shareUrl, key: S.shareKey });
  const shareReady = () => !!S.shareOn && share.configured();
  configShare();
  const brand = { logo: null };
  const freshXf = () => ({ dx: 0, dy: 0, scale: 1, rot: 0 });
  const freshDecor = () => ({ stickers: [], strokes: [] });

  /* The operator's own frames: [{ id, name, data (PNG data URL), w, h, slots, img }] */
  let frames = [];
  function saveFrames() {
    try {
      localStorage.setItem('rpb.frames', JSON.stringify(frames.map(({ id, name, data, w, h, slots }) => ({ id, name, data, w, h, slots }))));
      return true;
    } catch (e) { return false; }
  }
  async function loadFrames() {
    let list = [];
    try { list = JSON.parse(localStorage.getItem('rpb.frames') || '[]') || []; } catch (e) { list = []; }
    const ready = [];
    for (const f of list) {
      try { f.img = await loadImage(f.data); ready.push(f); } catch (e) { /* skip a damaged entry */ }
    }
    frames = ready;
  }

  /* Everything a guest can pick: built-in templates plus the operator's frames, pinned ones first. */
  function allTemplates(includeHidden) {
    const list = Object.entries(compose.TEMPLATES).map(([key, T]) => Object.assign({ key }, T));
    frames.forEach((f) => list.push({ key: 'frame:' + f.id, label: f.name, poses: f.slots.length, layout: 'custom', theme: 'classic', frame: f }));
    const shown = includeHidden ? list : list.filter((t) => !S.tplHidden.includes(t.key));
    const pinned = (t) => (S.tplPinned.includes(t.key) ? 0 : 1);
    return shown.map((t, i) => [t, i]).sort((a, b) => pinned(a[0]) - pinned(b[0]) || a[1] - b[1]).map((x) => x[0]);
  }
  const state = {
    screen: 'welcome', layout: 'strip3', theme: 'classic', frame: null,
    shots: [], xf: [], decor: [], backup: null, filter: 'normal', beauty: 0,
    copies: 1, printed: 0, saved: false, printing: false,
    stream: null, seq: 0, running: false, retake: null, retakesLeft: 0,
    bitmap: null, hasOrder: false, orderNo: 1, date: new Date(),
    idleAt: 0, sessionEnd: 0, editing: -1,
    shareId: '', shotVer: 0, upSig: '',
    sel: 0, tplKey: '',
  };

  /* ---------- helpers ---------- */
  /* Photo count and slot shape for the chosen template, built-in or the operator's own frame. */
  function slotAspect(i) {
    const f = state.frame;
    if (!f) return compose.LAYOUTS[state.layout].aspect;
    const s = f.slots[Math.min(i || 0, f.slots.length - 1)];
    return (s.w * f.w) / (s.h * f.h);
  }
  function curLayout() {
    return state.frame ? { count: state.frame.slots.length, cols: 1, aspect: slotAspect(0) } : compose.LAYOUTS[state.layout];
  }
  const fullDots = () => compose.dotsFor(S.paperWidth);
  /* Printable width after calibration, kept on a byte boundary. */
  const effDots = () => Math.max(64, Math.round((fullDots() * clamp(Number(S.printScale) || 100, 80, 100)) / 100 / 8) * 8);

  /* Messages are shown as a popover so they sit above open dialogs (settings, PIN, sharing);
     a plain element would be hidden behind a dialog's backdrop. */
  let toastTimer;
  function toast(msg, isError) {
    const t = $('#toast');
    const raise = (on) => {
      try {
        if (!t.showPopover) return;
        if (t.matches(':popover-open')) t.hidePopover();
        if (on) t.showPopover();
      } catch (e) { /* older browser: falls back to the plain element */ }
    };
    t.textContent = msg;
    t.classList.toggle('error', !!isError);
    t.hidden = false;
    raise(true);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { raise(false); t.hidden = true; }, isError ? 7000 : 3200);
  }

  let enterTimer;
  function show(name) {
    const changed = state.screen !== name;
    state.screen = name;
    $$('.screen').forEach((el) => el.classList.toggle('active', el.dataset.screen === name));
    if (changed) {
      // While the new screen slides in, taps are ignored, so a double tap on the old screen
      // cannot land on whatever appears under the finger.
      const app = $('#app');
      app.classList.add('entering');
      clearTimeout(enterTimer);
      enterTimer = setTimeout(() => app.classList.remove('entering'), 340);
    }
    playWelcome(name === 'welcome'); // a welcome video only runs while it is on screen
    if (name === 'welcome') restartTicket();
    bumpIdle();
  }

  /* Quick fade used when a picture on screen is replaced (new filter, photo or frame). */
  function swapIn(el) {
    el.classList.remove('swap');
    void el.offsetWidth;
    el.classList.add('swap');
  }

  function bumpIdle() {
    const secs = state.screen === 'result' ? Number(S.resultIdle) || 60 : IDLE_SECONDS;
    state.idleAt = Date.now() + secs * 1000;
  }

  let audioCtx;
  function beep(freq, dur, type) {
    if (!S.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t = audioCtx.currentTime;
      const gain = audioCtx.createGain();
      gain.gain.setValueAtTime(0.25, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
      gain.connect(audioCtx.destination);
      if (type === 'noise') {
        const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * dur, audioCtx.sampleRate);
        const ch = buf.getChannelData(0);
        for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
        const src = audioCtx.createBufferSource();
        src.buffer = buf;
        src.connect(gain);
        src.start(t);
      } else {
        const osc = audioCtx.createOscillator();
        osc.frequency.value = freq;
        osc.connect(gain);
        osc.start(t);
        osc.stop(t + dur);
      }
    } catch (e) { /* audio is optional */ }
  }

  function playThanks() {
    const src = ASSET.get('thanks');
    if (src) {
      try { new Audio(src).play().catch(() => {}); } catch (e) { /* ignore */ }
      return;
    }
    [660, 880, 1320].forEach((f, i) => setTimeout(() => beep(f, 0.25), i * 150));
  }

  /* ---------- branding ---------- */
  function loadBrand() {
    document.documentElement.style.setProperty('--accent', S.accent || DEFAULTS.accent);
    const bg = ASSET.get('bg');
    document.body.style.backgroundImage = bg ? `url("${bg}")` : '';
    document.body.classList.toggle('has-bg', !!bg);
    const logo = ASSET.get('logo');
    const el = $('#welcomeLogo');
    el.hidden = !logo;
    if (logo) {
      el.src = logo;
      const img = new Image();
      img.onload = () => { brand.logo = img; renderTemplates(); };
      img.src = logo;
    } else {
      el.removeAttribute('src');
      brand.logo = null;
    }
    $$('[data-asset-note]').forEach((n) => (n.textContent = ASSET.get(n.dataset.assetNote) ? 'Custom file in use.' : 'None set.'));
  }

  /* ---------- welcome ticket: prints, is cut, and a fresh strip prints ---------- */
  const TICKET_HEADS = [
    'Meet the bots,<br><mark>print</mark> your agent ID.',
    'Prompt: "smile".<br>Output: <mark>memories</mark>.',
    'Humans welcome.<br>Bots <mark>approved</mark>.',
    'Get hired by<br>an <mark>AI agency</mark>.',
  ];
  let ticketNo = 0;
  /* Each new strip gets its own headline and highlighted photo, like a different guest's print. */
  function dressTicket() {
    $('#welcomeHead').innerHTML = TICKET_HEADS[ticketNo % TICKET_HEADS.length];
    $$('#ticket .t-shot').forEach((el, i) => el.classList.toggle('hot', i === (ticketNo + 1) % 3));
  }
  /* Starts the loop from the top, so a guest walking up sees a strip printing. */
  function restartTicket() {
    const p = $('#welcomePrinter');
    p.classList.remove('run');
    void p.offsetWidth;
    p.classList.add('run');
  }

  /* ---------- custom welcome design ---------- */
  let welcomeUrl = '';
  function styleWelcome() {
    const has = !$('#welcomeMedia').hidden;
    $('#welcomeMedia').classList.toggle('contain', S.welcomeFit === 'contain');
    $('#welcomeScreen').classList.toggle('custom', has);
    $('#welcomeScreen').classList.toggle('no-cta', has && !S.welcomeCta);
  }
  function playWelcome(on) {
    const v = $('#welcomeMedia video');
    if (!v) return;
    if (on) v.play().catch(() => {}); else v.pause();
  }
  async function loadWelcome() {
    let rec = null;
    try { rec = await BIG.get('welcome'); } catch (e) { rec = null; }
    const box = $('#welcomeMedia');
    box.innerHTML = '';
    if (welcomeUrl) URL.revokeObjectURL(welcomeUrl);
    welcomeUrl = '';
    box.hidden = !rec;
    if (rec) {
      welcomeUrl = URL.createObjectURL(rec.blob);
      let el;
      if (String(rec.type).startsWith('video/')) {
        el = document.createElement('video');
        el.muted = true;
        el.loop = true;
        el.autoplay = true;
        el.playsInline = true;
        el.setAttribute('playsinline', '');
        // A blank poster, so Android never shows its own "play" placeholder before the first frame.
        el.poster = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
      } else {
        el = document.createElement('img');
        el.alt = '';
      }
      el.src = welcomeUrl;
      box.append(el);
      playWelcome(state.screen === 'welcome');
    }
    $('#welcomeNote').textContent = rec ? `In use: ${rec.name}` : 'None set.';
    styleWelcome();
  }
  async function setWelcome(file) {
    const ok = /^image\/(png|jpeg|gif)$/.test(file.type) || /^video\/(mp4|webm)$/.test(file.type);
    if (!ok) throw new Error('Use a PNG, JPEG, GIF or MP4 file.');
    if (file.size > 100 * 1024 * 1024) throw new Error('That file is over 100 MB. Export a shorter or smaller video.');
    try {
      await BIG.set('welcome', { blob: file, type: file.type, name: file.name });
    } catch (e) {
      throw new Error('This device has no room to store that file. Try a smaller one.');
    }
    await loadWelcome();
  }

  function applyBranding() {
    $('#welcomeTitle').textContent = S.title || 'PHOTOBOOTH';
    $('#welcomeSub').textContent = (S.subtitle || 'Pose · Print · Smile').toUpperCase();
    let n = 0;
    try { n = parseInt(localStorage.getItem('rpb.order'), 10) || 0; } catch (e) { /* ignore */ }
    $('#welcomeNo').textContent = String(n + 1).padStart(6, '0');
  }

  function readDataUrl(file) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => rej(new Error('That file could not be read.'));
      fr.readAsDataURL(file);
    });
  }
  function loadImage(src) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('That image could not be read.'));
      img.src = src;
    });
  }
  async function shrinkImage(file, maxDim, type) {
    const img = await loadImage(await readDataUrl(file));
    const k = Math.min(1, maxDim / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * k));
    c.height = Math.max(1, Math.round(img.height * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL(type, 0.82);
  }

  /* ---------- camera ---------- */
  const video = $('#video');

  function stopCamera() {
    if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
    video.srcObject = null;
    video.classList.remove('live');
  }

  const cameraLive = () => !!state.stream && state.stream.getVideoTracks().some((t) => t.readyState === 'live');

  /* To save battery the camera runs only on the capture screen: it opens when the guest picks a
     frame and closes as soon as the shots are taken. The picture fades in on its first frame. */
  let cameraStarting = null;
  async function startCamera() {
    if (cameraLive()) {
      if (video.paused) await video.play().catch(() => {});
      applyLive();
      return;
    }
    if (!cameraStarting) cameraStarting = openCamera().finally(() => { cameraStarting = null; });
    return cameraStarting;
  }

  async function openCamera() {
    stopCamera();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This browser cannot open a camera here. Open the app over https or localhost.');
    }
    // 4:3 rather than 16:9: on a tablet standing in portrait, the wide format would trim the
    // sides of the picture and fewer people would fit in the frame.
    const base = { width: { ideal: 1600 }, height: { ideal: 1200 } };
    let stream;
    try {
      const v = S.cameraId ? Object.assign({ deviceId: { exact: S.cameraId } }, base) : Object.assign({ facingMode: 'user' }, base);
      stream = await navigator.mediaDevices.getUserMedia({ video: v, audio: false });
    } catch (e) {
      if (!S.cameraId) throw e;
      stream = await navigator.mediaDevices.getUserMedia({ video: base, audio: false });
    }
    if (state.screen !== 'capture') {
      // The guest left the capture screen while the camera was still opening: do not leave it running.
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    state.stream = stream;
    state.camId = S.cameraId;
    video.srcObject = stream;
    await video.play();
    video.classList.add('live');
    applyLive();
    fillCameras();
  }

  /* Live preview of the colour look, matching what drawPhoto renders. */
  function applyLive() {
    video.style.filter = imaging.FILTERS[state.filter].css;
    video.style.transform = S.mirror ? 'scaleX(-1)' : '';
  }

  async function fillCameras() {
    try {
      const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      const sel = $('#cameraSel');
      sel.innerHTML = '<option value="">Default camera</option>';
      cams.forEach((c, i) => sel.add(new Option(c.label || `Camera ${i + 1}`, c.deviceId)));
      sel.value = cams.some((c) => c.deviceId === S.cameraId) ? S.cameraId : '';
    } catch (e) { /* ignore */ }
  }

  /* Keeps the whole frame so the guest can still move and zoom it inside the slot afterwards. */
  function grab() {
    const vw = video.videoWidth, vh = video.videoHeight;
    const k = Math.min(1, 1400 / vw);
    const c = document.createElement('canvas');
    c.width = Math.round(vw * k);
    c.height = Math.round(vh * k);
    const ctx = c.getContext('2d');
    if (S.mirror) { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, 0, 0, c.width, c.height);
    return c;
  }

  /* ---------- filter chips (live on the capture screen) ---------- */
  function pickFilter(key) {
    state.filter = key;
    syncChips();
    applyLive();
    if (state.screen === 'review') drawReview();
  }
  function buildChips() {
    for (const [key, f] of Object.entries(imaging.FILTERS)) {
      const c = document.createElement('button');
      c.className = 'chip';
      c.dataset.f = key;
      c.textContent = f.label;
      c.onclick = () => pickFilter(key);
      $('#liveFilters').append(c);
    }
    syncChips();
  }
  function syncChips() {
    $$('[data-f]').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.f === state.filter)));
  }

  /* Filter strip on the review screen: the guest's own photo with every filter already applied. */
  function buildFilterStrip() {
    const box = $('#filterStrip');
    const keepScroll = box.scrollLeft;
    box.innerHTML = '';
    const shot = state.shots[state.sel] || state.shots[0];
    if (!shot) return;
    for (const [key, f] of Object.entries(imaging.FILTERS)) {
      const b = document.createElement('button');
      b.className = 'fthumb';
      b.dataset.f = key;
      const c = document.createElement('canvas');
      c.width = c.height = 132;
      compose.drawPhoto(c.getContext('2d'), shot, { x: 0, y: 0, w: 132, h: 132 }, null, f.css, state.beauty);
      const label = document.createElement('span');
      label.textContent = f.label;
      b.append(c, label);
      b.onclick = () => pickFilter(key);
      box.append(b);
    }
    box.scrollLeft = keepScroll;
    syncChips();
  }

  /* ---------- capture flow ---------- */
  function renderDots(current) {
    const n = curLayout().count;
    $('#dots').innerHTML = Array.from({ length: n }, (_, i) =>
      `<i class="${i === current ? 'now' : state.shots[i] ? 'done' : ''}"></i>`).join('');
  }

  /* The viewfinder takes the shape of the spot being shot, so guests frame what will print. */
  function setViewfinder(i) {
    const a = slotAspect(i);
    const vf = $('#viewfinder');
    vf.style.aspectRatio = String(a);
    vf.style.setProperty('--ar', String(a));
  }

  async function enterCapture(retakeIndex) {
    const L = curLayout();
    state.retake = retakeIndex == null ? null : retakeIndex;
    state.seq++;
    state.running = false;
    setViewfinder(state.retake == null ? 0 : state.retake);
    $('#camError').hidden = true;
    $('#frozen').hidden = true;
    $('#count').hidden = true;
    $('#shootBtn').hidden = false;
    $('#shootBtn').disabled = true;
    $('.live-tools').hidden = false;
    $('#captureLabel').textContent = state.retake == null ? 'Get ready' : `Retake photo ${state.retake + 1}`;
    renderDots(state.retake == null ? 0 : state.retake);
    show('capture');
    try {
      await startCamera();
      $('#shootBtn').disabled = false;
    } catch (e) {
      $('#camErrorText').textContent = cameraMessage(e);
      $('#camError').hidden = false;
      $('#shootBtn').hidden = true;
      $('.live-tools').hidden = true;
    }
  }

  function cameraMessage(e) {
    if (e && e.name === 'NotAllowedError') return 'Camera access was blocked. Allow the camera for this app, then try again.';
    if (e && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError')) return 'No camera was found. Plug one in, then try again.';
    if (e && e.name === 'NotReadableError') return 'The camera is in use by another app. Close it, then try again.';
    return (e && e.message) || 'The camera could not be opened.';
  }

  async function runSequence() {
    const L = curLayout();
    const indices = state.retake == null ? Array.from({ length: L.count }, (_, i) => i) : [state.retake];
    const tok = ++state.seq;
    state.running = true;
    $('#shootBtn').hidden = true;
    const count = $('#count'), frozen = $('#frozen'), flash = $('#flash');
    for (const i of indices) {
      frozen.hidden = true;
      setViewfinder(i);
      applyLive();
      $('#captureLabel').textContent = `Photo ${i + 1} of ${L.count}`;
      renderDots(i);
      const secs = Math.max(1, Number(S.countdown) || 3);
      for (let n = secs; n >= 1; n--) {
        if (tok !== state.seq) return;
        count.hidden = false;
        count.textContent = n;
        count.classList.remove('tick');
        void count.offsetWidth;
        count.classList.add('tick');
        beep(n === 1 ? 1320 : 880, 0.15);
        bumpIdle();
        await sleep(1000);
      }
      if (tok !== state.seq) return;
      count.hidden = true;
      // A slow camera may not have delivered a frame yet: give it a moment rather than save a blank.
      for (let t = 0; t < 40 && !video.videoWidth; t++) await sleep(100);
      if (tok !== state.seq) return;
      if (!video.videoWidth) {
        state.running = false;
        $('#camErrorText').textContent = 'The camera stopped sending a picture. Try again.';
        $('#camError').hidden = false;
        $('.live-tools').hidden = true;
        return;
      }
      const shot = grab();
      state.shots[i] = shot;
      state.xf[i] = freshXf();
      state.decor[i] = freshDecor();
      state.shotVer++;
      beep(0, 0.12, 'noise');
      flash.classList.remove('go');
      void flash.offsetWidth;
      flash.classList.add('go');
      frozen.src = shot.toDataURL('image/jpeg', 0.8);
      frozen.style.filter = video.style.filter;
      frozen.hidden = false;
      renderDots(-1);
      await sleep(1100);
    }
    if (tok !== state.seq) return;
    state.running = false;
    state.backup = null;
    stopCamera();
    enterReview();
  }

  function loadFiles(files) {
    const L = curLayout();
    const list = [...files].slice(0, L.count);
    if (!list.length) return;
    Promise.all(list.map((f) => loadImage(URL.createObjectURL(f)))).then((imgs) => {
      if (state.retake != null) { state.shots[state.retake] = imgs[0]; state.xf[state.retake] = freshXf(); state.decor[state.retake] = freshDecor(); }
      else for (let i = 0; i < L.count; i++) { state.shots[i] = imgs[i % imgs.length]; state.xf[i] = freshXf(); state.decor[i] = freshDecor(); }
      state.backup = null;
      state.shotVer++;
      enterReview();
    }).catch((e) => toast(e.message, true));
  }

  /* Costs one retake. index = photo number, or null for the whole set. */
  function requestRetake(index) {
    if (state.retakesLeft <= 0) { toast('No retakes left for this session.', true); return; }
    state.retakesLeft--;
    state.backup = { shots: state.shots.slice(), xf: state.xf.slice(), decor: state.decor.slice() };
    if (index == null) { state.shots = []; state.xf = []; state.decor = []; }
    enterCapture(index);
  }

  /* ---------- result ---------- */
  function buildOpts(extra) {
    return Object.assign({
      dots: effDots(), frame: state.frame, decor: state.decor,
      paperWidth: S.paperWidth, layout: state.layout, theme: state.theme, photos: state.shots, xf: state.xf,
      look: imaging.FILTERS[state.filter].css, beauty: state.beauty, logo: brand.logo, s: S,
      orderNo: state.orderNo, date: state.date,
    }, extra || {});
  }

  async function renderReceipt() {
    await compose.loadFonts(S);
    const extra = {};
    if (shareReady() && state.shareId) {
      try { extra.qr = RPB.qr.encode(share.pageUrl(state.shareId)); } catch (e) { /* print without the QR */ }
    }
    const built = compose.build(buildOpts(extra));
    state.bitmap = compose.toBitmap(built.canvas, built.rects, S, state.filter, built);
    compose.paint(state.bitmap, $('#preview'));
    fitPreview();
    swapIn($('#preview'));
  }

  /* ---------- sharing ---------- */
  const sessionSig = () => JSON.stringify([state.tplKey, state.filter, state.beauty, state.xf, state.decor, state.shotVer]);

  /* Queues the colour copy for upload; a changed photo or filter replaces the earlier version. */
  function ensureUpload() {
    if (!shareReady() || !state.hasOrder || !state.shots.length) return;
    const sig = sessionSig();
    if (state.upSig === sig) return;
    try {
      const { canvas } = compose.build(buildOpts({ dots: 960, flatten: true }));
      const event = String(S.eventCode || '').trim();
      share.enqueue({
        id: state.shareId, sig,
        payload: {
          id: state.shareId, name: `photobooth-${String(state.orderNo).padStart(4, '0')}.jpg`,
          event, gallery: !!S.galleryOn && !!event,
          jpeg: canvas.toDataURL('image/jpeg', 0.9).split(',')[1],
        },
      });
      state.upSig = sig;
    } catch (e) { /* tried again on the next print */ }
  }

  function updateShareStatus() {
    if (!$('#shareDlg').open) return;
    $('#shareStatus').textContent = {
      done: 'Uploaded. The link is ready.',
      uploading: 'Uploading your photo…',
      waiting: 'Waiting for the internet. The link works once the upload finishes.',
      none: '',
    }[share.status(state.shareId, state.upSig)];
  }

  function openShare(msg) {
    if (!shareReady() || !state.shareId) return;
    ensureUpload();
    RPB.qr.toCanvas(RPB.qr.encode(share.pageUrl(state.shareId)), $('#shareQr'), 6);
    $('#shareMsg').textContent = msg || 'Scan this code with your phone camera to download your photo.';
    $('#shareEmail').value = '';
    $('#shareNote').textContent = '';
    if (!$('#shareDlg').open) $('#shareDlg').showModal();
    updateShareStatus();
  }

  function updateResultUi() {
    const freeLeft = Math.max(0, (Number(S.copiesMax) || 1) - state.printed);
    state.copies = clamp(state.copies, 1, Math.max(1, freeLeft));
    $('#copies').textContent = state.copies;
    $('#copiesBox').hidden = freeLeft === 0;
    const btn = $('#printBtn');
    btn.disabled = state.printing || (freeLeft === 0 && !S.printMore);
    btn.textContent = state.printing ? 'Printing…' : freeLeft > 0 ? 'Print' : S.printMore ? 'Print more' : 'Printed';
    $('#shareBtn').hidden = !shareReady();
  }

  /* ---------- review ("Love these?"): pick a photo, mirror, retake, filter ---------- */
  function drawReview() {
    const i = state.sel;
    const shot = state.shots[i];
    if (!shot) return;
    const c = $('#reviewCanvas');
    c.width = 900;
    c.height = Math.round(900 / slotAspect(i));
    const r = { x: 0, y: 0, w: c.width, h: c.height };
    const ctx = c.getContext('2d');
    const look = imaging.FILTERS[state.filter].css;
    compose.drawPhoto(ctx, shot, r, state.xf[i], look, state.beauty);
    compose.drawDecor(ctx, r, state.decor[i]);
    // The small photos follow the same filter, mirror and edits as the big one.
    $$('#reviewThumbs button').forEach((b, n) => {
      b.setAttribute('aria-pressed', String(n === i));
      const tc = b.querySelector('canvas');
      if (!tc || !state.shots[n]) return;
      const tr = { x: 0, y: 0, w: tc.width, h: tc.height };
      const tx = tc.getContext('2d');
      compose.drawPhoto(tx, state.shots[n], tr, state.xf[n], look, state.beauty);
      compose.drawDecor(tx, tr, state.decor[n]);
    });
    swapIn(c);
  }

  function updateReviewUi() {
    const limit = Number(S.retakeLimit) || 0;
    const left = state.retakesLeft;
    $('#reviewNote').textContent = limit === 0 ? '' : left > 0 ? `Retakes left: ${left}` : 'No retakes left';
    $('#reviewRetake').hidden = limit === 0;
    $('#startOverBtn').hidden = limit === 0;
    $('#reviewRetake').disabled = left <= 0;
    $('#startOverBtn').disabled = left <= 0;
  }

  function enterReview() {
    if (!state.hasOrder) {
      state.hasOrder = true;
      state.orderNo = nextOrderNo();
      state.date = new Date();
      state.copies = 1;
      state.printed = 0;
      state.saved = false;
      state.shareId = share.newId();
      state.upSig = '';
      // Always leave time to review and print, even if the session clock is nearly out.
      if (state.sessionEnd) state.sessionEnd = Math.max(state.sessionEnd, Date.now() + 60000);
    }
    state.retake = null;
    state.sel = clamp(state.sel || 0, 0, Math.max(0, state.shots.length - 1));
    const box = $('#reviewThumbs');
    box.innerHTML = '';
    box.hidden = state.shots.length < 2;
    state.shots.forEach((shot, i) => {
      const b = document.createElement('button');
      b.setAttribute('aria-label', `Photo ${i + 1}`);
      const tc = document.createElement('canvas');
      tc.width = tc.height = 160;
      b.append(tc);
      b.onclick = () => { state.sel = i; drawReview(); buildFilterStrip(); };
      box.append(b);
    });
    updateReviewUi();
    show('review');
    drawReview();
    buildFilterStrip();
  }

  /* ---------- result ("Looking great!"): receipt preview beside the frames that fit ---------- */
  function pickTemplate(T) {
    Object.assign(state, { tplKey: T.key, layout: T.layout, theme: T.theme, frame: T.frame || null });
  }

  /* Frames with the same number of photo spots, each drawn with the guest's own photos. */
  function buildTemplateSide() {
    const box = $('#tplSide');
    box.innerHTML = '';
    const fits = allTemplates(false).filter((t) => t.poses === state.shots.length || t.key === state.tplKey);
    for (const T of fits) {
      const b = document.createElement('button');
      b.className = 'tpl-opt';
      b.setAttribute('aria-pressed', String(T.key === state.tplKey));
      let canvas;
      try {
        canvas = compose.build(buildOpts({ dots: 240, flatten: true, layout: T.layout, theme: T.theme, frame: T.frame || null })).canvas;
      } catch (e) { continue; }
      const name = document.createElement('span');
      name.textContent = T.label;
      b.append(canvas, name);
      b.onclick = () => {
        pickTemplate(T);
        $$('#tplSide .tpl-opt').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        renderReceipt();
      };
      box.append(b);
    }
  }

  /* Scales the receipt preview so the whole strip fits beside the frame list, with no scrolling. */
  function fitPreview() {
    const wrap = $('.paper-wrap'), cv = $('#preview');
    if (!cv.width || !wrap.clientHeight) return;
    const k = Math.min((wrap.clientWidth - 8) / cv.width, (wrap.clientHeight - 30) / cv.height, 1.4);
    cv.style.width = Math.max(40, Math.floor(cv.width * k)) + 'px';
    cv.style.height = Math.max(40, Math.floor(cv.height * k)) + 'px';
  }

  async function enterResult() {
    updateResultUi();
    show('result');
    try {
      await compose.loadFonts(S);
      await sleep(30); // let the screen start sliding in before the heavier drawing work
      if (state.screen !== 'result') return;
      buildTemplateSide();
      await renderReceipt();
    } catch (e) { toast('Could not build the receipt: ' + e.message, true); }
  }

  function goHome() {
    state.seq++;
    state.running = false;
    stopCamera();
    if (state.hasOrder && state.printed > 0) ensureUpload(); // last edits still reach the download page
    ['#editDlg', '#moreDlg', '#shareDlg'].forEach((d) => { if ($(d).open) $(d).close(); });
    Object.assign(state, {
      shots: [], xf: [], decor: [], frame: null, layout: 'strip3', theme: 'classic', tplKey: '',
      backup: null, filter: 'normal', beauty: 0, bitmap: null,
      hasOrder: false, sessionEnd: 0, printed: 0, printing: false, editing: -1, sel: 0,
    });
    // Wipe every canvas that showed this guest's photos, so nothing of theirs can flash up
    // for the next guest.
    ['#reviewCanvas', '#preview', '#editCanvas', '#fxPaper'].forEach((id) => {
      const c = $(id);
      c.getContext('2d').clearRect(0, 0, c.width, c.height);
    });
    ['#reviewThumbs', '#filterStrip', '#tplSide'].forEach((id) => { $(id).innerHTML = ''; });
    $('#frozen').removeAttribute('src');
    syncChips();
    applyBranding();
    show('welcome');
  }

  function startSession() {
    // A voucher can only be checked online; with no server and no PIN set, asking for a code
    // would lock every guest out, so the session simply starts.
    const canCheck = share.configured() || !!S.pin;
    if (!S.requireVoucher || !canCheck) { beginSession(); return; }
    if ($('#moreDlg').open) return;
    askCode({
      title: 'Enter your voucher',
      text: 'Type your 6-digit voucher code to start.' + (S.pin ? ' Staff can enter the PIN instead.' : ''),
      copies: false, needCode: true,
    }).then((r) => { if (r) beginSession(); });
  }

  function beginSession() {
    const limit = Number(S.sessionLimit) || 0;
    state.sessionEnd = limit > 0 ? Date.now() + limit * 1000 : 0;
    state.retakesLeft = Number(S.retakeLimit) || 0;
    show('layout');
  }

  /* ---------- edit one photo: move / zoom / turn, stickers, drawing ---------- */
  const editCanvas = $('#editCanvas');
  const edit = { mode: 'move', sel: -1, white: false };
  const HINTS = {
    move: 'Drag to move the photo. Pinch or use the buttons to zoom and turn.',
    sticker: 'Tap a sticker to add it, then drag it into place. The buttons resize and turn it.',
    draw: 'Draw with your finger. White ink shows up on dark areas.',
  };
  const curDecor = () => state.decor[state.editing] || (state.decor[state.editing] = freshDecor());

  function drawEdit() {
    const i = state.editing;
    if (i < 0 || !state.shots[i]) return;
    const ctx = editCanvas.getContext('2d');
    const r = { x: 0, y: 0, w: editCanvas.width, h: editCanvas.height };
    compose.drawPhoto(ctx, state.shots[i], r, state.xf[i], imaging.FILTERS[state.filter].css, state.beauty);
    compose.drawDecor(ctx, r, state.decor[i]);
    const k = edit.mode === 'sticker' ? curDecor().stickers[edit.sel] : null;
    if (k) {
      // Marching ring around the selected sticker.
      ctx.save();
      ctx.setLineDash([8, 6]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(k.x * r.w, k.y * r.h, k.size * r.w * 0.62, 0, Math.PI * 2);
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.lineDashOffset = 7;
      ctx.strokeStyle = '#000';
      ctx.stroke();
      ctx.restore();
    }
  }

  function setEditMode(mode) {
    edit.mode = mode;
    edit.sel = -1;
    $$('#editModes .chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.mode === mode)));
    $$('[data-pen]').forEach((c) => c.setAttribute('aria-pressed', String((c.dataset.pen === 'white') === edit.white)));
    $('#editHint').textContent = HINTS[mode];
    $('#stickerTray').hidden = mode !== 'sticker';
    $('#shapeTools').hidden = mode === 'draw';
    $('#drawTools').hidden = mode !== 'draw';
    $('#editReset').hidden = mode !== 'move';
    $('#editRemove').hidden = mode !== 'sticker';
    editCanvas.style.cursor = mode === 'draw' ? 'crosshair' : 'grab';
    drawEdit();
  }

  function openEdit(i) {
    state.editing = i;
    if (!state.xf[i]) state.xf[i] = freshXf();
    if (!state.decor[i]) state.decor[i] = freshDecor();
    editCanvas.width = 640;
    editCanvas.height = Math.round(640 / slotAspect(i));
    $('#editNo').textContent = i + 1;
    const canRetake = (Number(S.retakeLimit) || 0) > 0;
    $('#editRetake').hidden = !canRetake;
    $('#editRetake').disabled = state.retakesLeft <= 0;
    $('#editRetake').textContent = state.retakesLeft > 0 ? `Retake this photo (${state.retakesLeft} left)` : 'No retakes left';
    setEditMode('move');
    $('#editDlg').showModal();
  }

  /* ---------- the operator's own stickers (PNG uploads) ---------- */
  const BUILTIN_STICKERS = Object.keys(compose.STICKERS);
  let myStickers = []; // [{ id, name, data }]

  /* Makes an uploaded PNG drawable like a built-in sticker: fitted into the unit box. */
  function registerSticker(st, img) {
    const k = 1 / Math.max(img.width, img.height);
    const w = img.width * k, h = img.height * k;
    compose.STICKERS['my_' + st.id] = (ctx) => ctx.drawImage(img, -w / 2, -h / 2, w, h);
  }
  function saveStickers() {
    try { localStorage.setItem('rpb.stickers', JSON.stringify(myStickers)); return true; } catch (e) { return false; }
  }
  async function loadStickers() {
    let list = [];
    try { list = JSON.parse(localStorage.getItem('rpb.stickers') || '[]') || []; } catch (e) { list = []; }
    const ok = [];
    for (const st of list) {
      try { registerSticker(st, await loadImage(st.data)); ok.push(st); } catch (e) { /* skip a damaged entry */ }
    }
    myStickers = ok;
  }
  async function addSticker(file) {
    if (file.type !== 'image/png') throw new Error(`${file.name} is not a PNG file.`);
    if (myStickers.length >= 30) throw new Error('That is the most stickers the booth can hold. Delete one first.');
    const st = { id: Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36), name: file.name, data: await shrinkImage(file, 320, 'image/png') };
    const img = await loadImage(st.data);
    myStickers.push(st);
    if (!saveStickers()) {
      myStickers.pop();
      throw new Error('There is no storage left for another sticker. Delete one first.');
    }
    registerSticker(st, img);
  }

  /* Tray in the photo editor: the operator's stickers first, then the built-in ones. */
  function buildStickerTray() {
    const tray = $('#stickerTray');
    tray.innerHTML = '';
    const types = myStickers.map((s) => 'my_' + s.id).concat(S.hideBuiltinStickers && myStickers.length ? [] : BUILTIN_STICKERS);
    for (const type of types) {
      const draw = compose.STICKERS[type];
      if (!draw) continue;
      const b = document.createElement('button');
      b.setAttribute('aria-label', 'Add sticker');
      const c = document.createElement('canvas');
      c.width = c.height = 96;
      const x = c.getContext('2d');
      x.translate(48, 48);
      x.scale(80, 80);
      draw(x);
      b.append(c);
      b.onclick = () => {
        const d = curDecor();
        if (d.stickers.length >= 12) { toast('That is the most stickers one photo can hold.', true); return; }
        d.stickers.push({ type, x: 0.5, y: 0.5, size: 0.32, rot: 0 });
        edit.sel = d.stickers.length - 1;
        drawEdit();
      };
      tray.append(b);
    }
  }

  /* Settings list of uploaded stickers, each with a delete button. */
  function renderStickerList() {
    const box = $('#stickerList');
    box.innerHTML = '';
    for (const st of myStickers) {
      const cell = document.createElement('div');
      cell.className = 'sticker-cell';
      const img = document.createElement('img');
      img.src = st.data;
      img.alt = st.name;
      const del = document.createElement('button');
      del.className = 'btn btn-ghost';
      del.textContent = 'Delete';
      del.setAttribute('aria-label', `Delete sticker ${st.name}`);
      del.onclick = () => {
        myStickers = myStickers.filter((s) => s !== st);
        delete compose.STICKERS['my_' + st.id];
        saveStickers();
        renderStickerList();
        buildStickerTray();
      };
      cell.append(img, del);
      box.append(cell);
    }
    $('#stickerNote').textContent = myStickers.length ? `${myStickers.length} of 30 stickers added.` : 'No stickers added yet.';
  }

  function wireEdit() {
    loadStickers().then(buildStickerTray);
    $('#stickerFile').onchange = async (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      let added = 0, problem = '';
      for (const f of files) {
        try { await addSticker(f); added++; } catch (err) { problem = err.message; }
      }
      renderStickerList();
      buildStickerTray();
      if (problem) toast(problem, true);
      else if (added) toast(added > 1 ? `${added} stickers added.` : 'Sticker added.');
    };

    const ptrs = new Map();
    let base = null, stroke = null;
    const onSticker = () => edit.mode === 'sticker';
    const pos = (e) => {
      const r = editCanvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    };
    const spread = () => {
      const [a, b] = [...ptrs.values()];
      return Math.hypot(a.x - b.x, a.y - b.y) || 0.001;
    };
    // What the gestures and buttons act on: the selected sticker, or the photo itself.
    const target = () => (onSticker() ? curDecor().stickers[edit.sel] : state.xf[state.editing]);
    const rebase = () => {
      const t = target();
      const first = [...ptrs.values()][0];
      base = first && t
        ? { p: first, a: onSticker() ? t.x : t.dx, b: onSticker() ? t.y : t.dy, s: onSticker() ? t.size : t.scale, d: ptrs.size > 1 ? spread() : 0 }
        : null;
    };
    const hit = (p) => {
      const list = curDecor().stickers;
      const ar = editCanvas.height / editCanvas.width;
      for (let n = list.length - 1; n >= 0; n--) {
        if (Math.hypot(p.x - list[n].x, (p.y - list[n].y) * ar) < list[n].size * 0.6) return n;
      }
      return -1;
    };
    const scaleTo = (t, v) => { if (onSticker()) t.size = clamp(v, 0.08, 1.2); else t.scale = clamp(v, 1, 4); };

    editCanvas.addEventListener('pointerdown', (e) => {
      try { editCanvas.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
      const p = pos(e);
      ptrs.set(e.pointerId, p);
      if (edit.mode === 'draw') {
        const d = curDecor();
        if (d.strokes.length >= 150) d.strokes.shift();
        stroke = { pts: [[p.x, p.y]], w: 0.014, white: edit.white };
        d.strokes.push(stroke);
        drawEdit();
        return;
      }
      if (onSticker() && ptrs.size === 1) { edit.sel = hit(p); drawEdit(); }
      rebase();
    });
    editCanvas.addEventListener('pointermove', (e) => {
      if (!ptrs.has(e.pointerId)) return;
      const p = pos(e);
      ptrs.set(e.pointerId, p);
      bumpIdle();
      if (edit.mode === 'draw') {
        if (!stroke) return;
        const last = stroke.pts[stroke.pts.length - 1];
        if (Math.hypot(p.x - last[0], p.y - last[1]) > 0.004 && stroke.pts.length < 600) { stroke.pts.push([p.x, p.y]); drawEdit(); }
        return;
      }
      const t = target();
      if (!base || !t) return;
      if (ptrs.size > 1 && base.d) {
        scaleTo(t, base.s * (spread() / base.d));
      } else if (onSticker()) {
        t.x = clamp(base.a + (p.x - base.p.x), 0, 1);
        t.y = clamp(base.b + (p.y - base.p.y), 0, 1);
      } else {
        t.dx = clamp(base.a + (p.x - base.p.x), -1, 1);
        t.dy = clamp(base.b + (p.y - base.p.y), -1, 1);
      }
      drawEdit();
    });
    const end = (e) => { ptrs.delete(e.pointerId); if (!ptrs.size) stroke = null; rebase(); };
    editCanvas.addEventListener('pointerup', end);
    editCanvas.addEventListener('pointercancel', end);
    editCanvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const t = target();
      if (!t || edit.mode === 'draw') return;
      scaleTo(t, (onSticker() ? t.size : t.scale) * (e.deltaY < 0 ? 1.08 : 0.93));
      drawEdit();
    }, { passive: false });

    const grow = (f) => { const t = target(); if (t) scaleTo(t, (onSticker() ? t.size : t.scale) * f); };
    const turn = (deg) => { const t = target(); if (t) t.rot = ((t.rot || 0) + deg) % 360; };
    const actions = {
      zoomIn: () => grow(1.15),
      zoomOut: () => grow(1 / 1.15),
      rotL: () => turn(-15),
      rotR: () => turn(15),
      reset: () => Object.assign(state.xf[state.editing], freshXf()),
      remove: () => {
        const d = curDecor();
        if (edit.sel >= 0) d.stickers.splice(edit.sel, 1); else d.stickers.pop();
        edit.sel = -1;
      },
      undo: () => curDecor().strokes.pop(),
      clear: () => { curDecor().strokes = []; },
    };
    $$('[data-edit]').forEach((b) => (b.onclick = () => { actions[b.dataset.edit](); drawEdit(); }));
    $$('#editModes .chip').forEach((c) => (c.onclick = () => setEditMode(c.dataset.mode)));
    $$('[data-pen]').forEach((c) => (c.onclick = () => { edit.white = c.dataset.pen === 'white'; setEditMode('draw'); }));
    $('#editDone').onclick = () => { $('#editDlg').close(); drawReview(); };
    $('#editRetake').onclick = () => { const i = state.editing; $('#editDlg').close(); requestRetake(i); };
    $('#editDlg').addEventListener('cancel', () => drawReview());
  }

  /* ---------- printing ---------- */
  function bitmapDataUrl(bitmap) {
    return compose.paint(bitmap, document.createElement('canvas')).toDataURL('image/png');
  }

  function browserPrint(bitmap) {
    let style = $('#pageStyle');
    if (!style) { style = document.createElement('style'); style.id = 'pageStyle'; document.head.append(style); }
    const mm = Number(S.paperWidth) === 80 ? 80 : 58;
    const hmm = Math.ceil((bitmap.h / bitmap.w) * mm) + 4;
    style.textContent = `@page { size: ${mm}mm ${hmm}mm; margin: 0; }`;
    const img = $('#printImg');
    img.onload = () => window.print();
    img.src = bitmapDataUrl(bitmap);
  }

  async function ensurePrinter() {
    if (printer.connected() && printer.type === S.connection) return;
    await printer.connect(S.connection, S);
    updatePrinterStatus();
  }

  const PAPER_OUT = 'The printer is out of paper. Load a new roll, then print again.';

  /* paperChecked: the caller has already asked the printer about paper for this copy. */
  async function printBitmap(bitmap, copies, paperChecked) {
    if (S.connection === 'browser' && !NATIVE) { browserPrint(bitmap); return; }
    await ensurePrinter();
    if (!paperChecked && S.paperCheck && (await printer.status()) === 'out') throw new Error(PAPER_OUT);
    bitmap = compose.padBitmap(bitmap, fullDots(), Number(S.printShift) || 0);
    const data = escpos.encodeRaster(bitmap, { chunkRows: Number(S.chunkRows), feedLines: Number(S.feedLines), cut: !!S.cut });
    for (let i = 0; i < copies; i++) await printer.write(data);
  }

  function printError(e) {
    if (e && e.name === 'NotFoundError') return 'No printer was chosen.';
    return (e && e.message) || 'Printing failed.';
  }

  /* Prints n copies of the session receipt and counts them against the free allowance. */
  /* Printing screen: the receipt slides out of an on-screen printer while the real one prints.
     A thermal printer does not report its progress, so the pace is estimated from the strip's
     length; the paper only finishes emerging once the printer has taken all the data. */
  function printFx(bitmap) {
    const box = $('#printFx');
    const paper = $('#fxPaper');
    const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const est = clamp(1.6 + bitmap.h / 420, 2.6, 12); // seconds for one copy
    let p = 0, sent = false, raf = 0, last = 0, onDone = null;
    compose.paint(bitmap, paper);
    const place = () => { paper.style.transform = `translateY(${-(1 - p) * 100}%)`; };
    const tick = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      // Hold just short of the end until the printer has everything, then finish briskly.
      const rate = sent ? Math.max(1 / est, (1 - p) / 0.7) : 1 / est;
      p = Math.min(sent ? 1 : 0.9, p + rate * dt);
      place();
      if (p >= 1) { raf = 0; if (onDone) { const f = onDone; onDone = null; f(); } return; }
      raf = requestAnimationFrame(tick);
    };
    return {
      /* Starts the paper for copy i of n. */
      begin(i, n) {
        $('#fxTitle').textContent = 'Your photos are ready!';
        $('#fxText').textContent = n > 1 ? `Printing copy ${i} of ${n}…` : 'Printing your copy…';
        box.classList.remove('out');
        box.hidden = false;
        p = still ? 1 : 0;
        sent = false;
        place();
        last = performance.now();
        if (!still) raf = requestAnimationFrame(tick);
      },
      /* The printer has the whole copy: let the paper finish coming out. */
      finish() {
        sent = true;
        if (still || p >= 1) return Promise.resolve();
        // The timer is a safety net: animation frames stop while the screen is hidden or off.
        return new Promise((res) => {
          const timer = setTimeout(() => { onDone = null; p = 1; place(); res(); }, 1500);
          onDone = () => { clearTimeout(timer); res(); };
        });
      },
      async done() {
        $('#fxTitle').textContent = 'All done!';
        $('#fxText').textContent = 'Take your receipt from the printer.';
        await sleep(1700);
        this.close();
      },
      close() {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        onDone = null;
        if (box.hidden) return;
        // Fade out instead of vanishing.
        box.classList.add('out');
        setTimeout(() => { box.hidden = true; box.classList.remove('out'); }, still ? 0 : 260);
      },
    };
  }

  async function printSession(n) {
    if (!state.bitmap || state.printing) return;
    state.printing = true;
    updateResultUi();
    // Preparing the upload copy is heavy; doing it a moment later keeps the print animation
    // from stuttering at its start. (A failed print calls it again through the share dialog.)
    setTimeout(ensureUpload, 500);
    const viaDialog = S.connection === 'browser' && !NATIVE;
    const fx = S.printAnim && !viaDialog ? printFx(state.bitmap) : null;
    let done = 0;
    try {
      // Connect and check paper before the animation starts, so a problem never shows a fake print.
      if (!viaDialog) await ensurePrinter();
      for (let i = 1; i <= n; i++) {
        if (!viaDialog && S.paperCheck && (await printer.status()) === 'out') throw new Error(PAPER_OUT);
        if (fx) fx.begin(i, n);
        await printBitmap(state.bitmap, 1, true);
        if (fx) await fx.finish();
        done++;
        if (viaDialog) { done = n; break; }
      }
      playThanks();
      if (fx) await fx.done();
      else if (!viaDialog) toast(n > 1 ? `${n} copies sent to the printer.` : 'Sent to the printer.');
      if (S.autoSave && !state.saved) saveCopy(true);
    } catch (e) {
      if (fx) fx.close();
      toast(printError(e), true);
      // The strip could not print: offer the photo on screen instead.
      openShare('The strip could not print. Scan this code to get your photo instead.');
    }
    state.printed += done;
    state.printing = false;
    state.copies = 1;
    updateResultUi();
    bumpIdle();
  }

  /* Asks for the staff PIN or a 6-digit voucher code. Resolves { n } (copies chosen) or null.
     o: { title, text, copies (show the stepper), needCode (never pass without a code) } */
  function askCode(o) {
    return new Promise((resolve) => {
      const dlg = $('#moreDlg');
      const input = $('#morePin');
      const max = Number(S.printMoreMax) || 1;
      let n = 1, settled = false;
      const setN = (v) => { n = clamp(v, 1, max); $('#moreCopies').textContent = n; };
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        dlg.onclose = null;
        if (dlg.open) dlg.close();
        resolve(ok ? { n } : null);
      };
      const fail = (msg) => { $('#moreErr').textContent = msg; $('#moreErr').hidden = false; input.value = ''; };
      const open = !S.pin && !o.needCode; // no PIN set: nothing to check
      setN(1);
      $('#moreTitle').textContent = o.title;
      $('#moreText').textContent = o.text;
      $('#moreStepper').hidden = !o.copies;
      input.hidden = open;
      input.value = '';
      $('#moreErr').hidden = true;
      $('#moreMinus').onclick = () => setN(n - 1);
      $('#morePlus').onclick = () => setN(n + 1);
      $('#moreCancel').onclick = () => finish(false);
      dlg.onclose = () => finish(false);
      $('#moreOk').onclick = async (e) => {
        e.preventDefault();
        const v = input.value.trim();
        if (open || (S.pin && v === S.pin)) { finish(true); return; }
        if (/^\d{6}$/.test(v) && share.configured()) {
          $('#moreOk').disabled = true;
          try { await share.redeem(v); finish(true); } catch (err) { fail(err.message); }
          $('#moreOk').disabled = false;
          return;
        }
        fail(share.configured() ? 'Wrong PIN or voucher code.' : 'Wrong PIN.');
      };
      dlg.showModal();
    });
  }

  function openMore() {
    const how = S.pin ? 'Pay the attendant, who will enter the PIN' : 'Pay the attendant before printing';
    askCode({
      title: 'Print more',
      text: `Extra copies cost ${S.printMorePrice || 'extra'}. ${how}${share.configured() ? ', or enter a voucher code.' : '.'}`,
      copies: true,
    }).then((r) => { if (r) printSession(r.n); });
  }

  /* Prints vouchers the operator queued from their phone. Runs only while the booth is idle. */
  let voucherBusy = false;
  async function pollVouchers() {
    if (voucherBusy || !S.voucherPrint || !share.configured()) return;
    if (state.screen !== 'welcome' || $('#settingsDlg').open || $('#moreDlg').open) return;
    if (S.connection === 'browser' && !NATIVE) return;
    voucherBusy = true;
    const printed = [];
    try {
      let codes = [];
      try { codes = await share.vouchers(); } catch (e) { codes = []; } // offline: try again next time
      if (codes.length) {
        await compose.loadFonts(S);
        for (const code of codes) {
          await printBitmap(compose.voucherSlip(S.paperWidth, S, code, effDots()), 1);
          printed.push(code);
        }
        toast(printed.length > 1 ? `${printed.length} vouchers printed.` : 'Voucher printed.');
      }
    } catch (e) {
      toast('A voucher is waiting but could not print: ' + printError(e), true);
    }
    if (printed.length) { try { await share.voucherAck(printed); } catch (e) { /* reprinted next time */ } }
    voucherBusy = false;
  }

  /* Colour copy of the receipt at three times print resolution. */
  async function saveCopy(silent) {
    if (!state.shots.length) return;
    try {
      const { canvas } = compose.build(buildOpts({ dots: 960, flatten: true }));
      const url = canvas.toDataURL('image/jpeg', 0.92);
      const name = `photobooth-${String(state.orderNo).padStart(4, '0')}.jpg`;
      if (NATIVE) {
        await RPB.nativeCall('saveImage', url.split(',')[1], name);
      } else {
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
      }
      state.saved = true;
      if (!silent) toast(NATIVE ? 'Saved to the photo album.' : 'Colour copy saved.');
    } catch (e) {
      toast((e && e.message) || 'The copy could not be saved.', true);
    }
  }

  function updatePrinterStatus() {
    $('#printerStatus').textContent = S.connection === 'browser'
      ? 'Uses the printer picked in the browser print dialog.'
      : printer.connected() ? 'Connected: ' + printer.name : 'Not connected.';
    $('#connectBtn').disabled = S.connection === 'browser';
  }

  /* ---------- settings ---------- */
  function fillBluetooth() {
    const sel = $('#btSel');
    if (!NATIVE || !sel) return;
    sel.innerHTML = '';
    let raw = 'NONE';
    try { raw = RPB.native.listBluetooth(); } catch (e) { /* keep NONE */ }
    const note = { PERMISSION: 'Allow Bluetooth, then reopen settings', OFF: 'Bluetooth is off', NONE: 'No Bluetooth on this tablet' }[raw];
    if (note) { sel.add(new Option(note, '')); return; }
    let list = [];
    try { list = JSON.parse(raw); } catch (e) { /* empty */ }
    sel.add(new Option(list.length ? 'Choose a printer…' : 'No paired devices yet', ''));
    list.forEach((d) => sel.add(new Option(d.name, d.address)));
  }

  function fillSettings() {
    $$('[data-k]').forEach((el) => {
      const v = S[el.dataset.k];
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = v;
      const out = el.closest('label') && el.closest('label').querySelector('output');
      if (out) out.textContent = v;
    });
    updatePrinterStatus();
    updateAdminLink();
  }

  function updateAdminLink() {
    const url = String(S.shareUrl || '').trim();
    $('#adminLink').textContent = /^https:\/\//.test(url)
      ? `Voucher page for your phone: ${url}${url.includes('?') ? '&' : '?'}admin=1`
      : '';
  }

  function readSetting(el) {
    const k = el.dataset.k;
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.type === 'number' || el.type === 'range' || 'num' in el.dataset) {
      v = Number(el.value);
      if (!Number.isFinite(v)) v = DEFAULTS[k];
      if (el.min !== '' && el.min != null && el.type !== 'select-one') v = Math.max(Number(el.min), v);
      if (el.max !== '' && el.max != null && el.type !== 'select-one') v = Math.min(Number(el.max), v);
    } else v = el.value;
    if (k === 'pin') v = String(v).replace(/\D/g, '').slice(0, 4);
    S[k] = v;
    const out = el.closest('label') && el.closest('label').querySelector('output');
    if (out) out.textContent = v;
    if (k === 'accent') document.documentElement.style.setProperty('--accent', v);
    if (k === 'shareUrl') updateAdminLink();
    saveSettings();
  }

  let testTimer;
  function testBitmap() {
    const { canvas, rects } = compose.build({
      paperWidth: S.paperWidth, dots: effDots(), layout: 'single', theme: 'classic', photos: [compose.testPhoto()],
      logo: brand.logo, s: S, orderNo: 0, date: new Date(),
    });
    return compose.toBitmap(canvas, rects, S, 'normal');
  }
  function refreshTestPreview() {
    clearTimeout(testTimer);
    testTimer = setTimeout(async () => {
      await compose.loadFonts(S);
      compose.paint(testBitmap(), $('#testPreview'));
    }, 80);
  }

  /* Template gallery: each card is the real receipt layout with tinted stand-in photos. */
  async function renderTemplates() {
    await compose.loadFonts(S);
    const box = $('#layouts');
    box.innerHTML = '';
    for (const T of allTemplates(false)) {
      const { canvas } = compose.build({
        paperWidth: 58, layout: T.layout, theme: T.theme, frame: T.frame, s: S, logo: brand.logo, orderNo: 1, date: new Date(),
        photos: Array.from({ length: T.poses }, (_, i) => compose.placeholder(i + 1)),
      });
      const b = document.createElement('button');
      b.className = 'tpl-card';
      b.dataset.t = T.key;
      const name = document.createElement('span');
      name.className = 'tpl-name';
      const label = document.createElement('span');
      label.textContent = T.label;
      const poses = document.createElement('small');
      poses.textContent = `${T.poses} pose${T.poses > 1 ? 's' : ''}`;
      name.append(label, poses);
      b.append(canvas, name);
      if (S.tplPinned.includes(T.key)) {
        const pin = document.createElement('span');
        pin.className = 'tpl-pin';
        pin.textContent = 'TOP PICK';
        b.append(pin);
      }
      b.onclick = () => {
        pickTemplate(T);
        Object.assign(state, { shots: [], xf: [], decor: [], sel: 0 });
        enterCapture(null);
      };
      box.append(b);
    }
    if (!box.children.length) box.textContent = 'No frames are switched on. Open the settings to show some.';
  }

  /* Settings list: pin, show or delete each frame. */
  function renderFrameList() {
    const box = $('#frameList');
    box.innerHTML = '';
    const toggle = (arr, key, on) => {
      const i = arr.indexOf(key);
      if (on && i < 0) arr.push(key);
      if (!on && i >= 0) arr.splice(i, 1);
      saveSettings();
    };
    const check = (text, on, fn) => {
      const l = document.createElement('label');
      l.className = 'check';
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.checked = on;
      c.onchange = () => fn(c.checked);
      l.append(c, text);
      return l;
    };
    for (const T of allTemplates(true)) {
      const row = document.createElement('div');
      row.className = 'frame-row';
      const name = document.createElement('span');
      name.textContent = `${T.label} (${T.poses})`;
      row.append(
        name,
        check('Pin', S.tplPinned.includes(T.key), (on) => toggle(S.tplPinned, T.key, on)),
        check('Show', !S.tplHidden.includes(T.key), (on) => toggle(S.tplHidden, T.key, !on)),
      );
      if (T.frame) {
        const del = document.createElement('button');
        del.className = 'btn btn-ghost';
        del.textContent = 'Delete';
        del.onclick = () => {
          frames = frames.filter((f) => f !== T.frame);
          saveFrames();
          toggle(S.tplPinned, T.key, false);
          toggle(S.tplHidden, T.key, false);
          renderFrameList();
        };
        row.append(del);
      } else {
        row.append(document.createElement('span'));
      }
      box.append(row);
    }
  }

  /* Reads a frame PNG, scales it to print width, and finds its transparent photo spots. */
  async function addFrame(file) {
    const src = await loadImage(await readDataUrl(file));
    const k = Math.min(1, 576 / src.width);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(src.width * k));
    c.height = Math.max(1, Math.round(src.height * k));
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    const slots = compose.detectSlots(c);
    if (!slots.length) throw new Error('No transparent photo spots were found in that PNG. Cut out the photo areas so they are see-through.');
    const data = c.toDataURL('image/png');
    const frame = {
      id: Date.now().toString(36), name: file.name.replace(/\.[^.]+$/, '').slice(0, 28) || 'My frame',
      data, w: c.width, h: c.height, slots, img: await loadImage(data),
    };
    frames.push(frame);
    if (!saveFrames()) {
      frames.pop();
      throw new Error('There is no storage left for another frame. Delete one first, or use a smaller PNG.');
    }
    return frame;
  }

  /* Settings are grouped into tabs; each fieldset names its tab in data-tab. */
  let settingsTab = 'printer';
  function showTab(name) {
    settingsTab = name;
    $$('#settingsTabs .tab').forEach((b) => {
      const on = b.dataset.tab === name;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    $$('.settings-form fieldset').forEach((f) => (f.hidden = f.dataset.tab !== name));
    // The live test pattern only helps where the print itself is being changed.
    const withPreview = name === 'printer' || name === 'design';
    $('.settings-preview').hidden = !withPreview;
    $('.settings-body').classList.toggle('no-preview', !withPreview);
    $('.settings-form').scrollTop = 0;
  }

  let settingsOpen = false;
  function openSettings() {
    settingsOpen = true;
    showTab(settingsTab);
    renderFrameList();
    renderStickerList();
    fillBluetooth();
    fillSettings();
    fillCameras();
    refreshTestPreview();
    $('#settingsDlg').showModal();
  }

  /* ---------- opening animation ---------- */
  /* Plays media/splash.mp4 once at start-up, then fades to the welcome page. Any problem with
     the video (missing file, blocked playback) skips straight to the app instead of blocking it. */
  function runSplash() {
    const box = $('#splash'), v = $('#splashVideo');
    if (!box) return;
    if (!S.splash) { box.remove(); return; }
    let over = false;
    let guard = setTimeout(() => end(), 5000);
    function end() {
      if (over) return;
      over = true;
      clearTimeout(guard);
      box.classList.add('out');
      restartTicket(); // the first strip starts printing as the logo fades
      try { v.pause(); } catch (e) { /* ignore */ }
      setTimeout(() => box.remove(), 650);
    }
    v.addEventListener('ended', end);
    v.addEventListener('error', end);
    box.addEventListener('click', end); // tap to skip
    v.addEventListener('loadedmetadata', () => {
      clearTimeout(guard);
      guard = setTimeout(end, (Math.min(30, v.duration || 6) + 1.5) * 1000);
    });
    v.addEventListener('loadeddata', () => {
      // Match the backdrop to the video's own edge colour, so any letterbox bars disappear.
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 8;
        const x = c.getContext('2d');
        x.drawImage(v, 0, 0, 8, 8);
        const d = x.getImageData(0, 0, 1, 1).data;
        box.style.background = `rgb(${d[0]},${d[1]},${d[2]})`;
      } catch (e) { /* keep the default backdrop */ }
    });
    // The whole file is fetched first and played from memory: inside the Android app, a video
    // streamed straight from the bundled files cannot be seeked and may refuse to start.
    fetch('media/splash.mp4')
      .then((r) => { if (!r.ok) throw new Error('missing'); return r.blob(); })
      .then((blob) => {
        v.src = URL.createObjectURL(blob);
        // With sound where the device allows it (the Android app does); silent otherwise.
        v.muted = false;
        return v.play().catch(() => { v.muted = true; return v.play(); });
      })
      .catch(end);
  }

  /* ---------- wiring ---------- */
  function init() {
    runSplash();
    // Drop the controls that do not apply to this runtime (Android app vs browser).
    $$(NATIVE ? '[data-web]' : '[data-native]').forEach((el) => el.remove());

    for (const [k, label] of Object.entries(imaging.DITHERS)) $('#ditherSel').add(new Option(label, k));
    for (const k of Object.keys(compose.TITLE_FONTS)) $('#fontSel').add(new Option(k, k));
    buildChips();
    wireEdit();
    loadBrand();
    loadFrames().then(renderTemplates);
    loadWelcome();
    dressTicket();
    // The loop restarts while the paper is out of sight, which is when the strip is swapped.
    $('#ticketMover').addEventListener('animationiteration', (e) => {
      if (e.target.id !== 'ticketMover') return;
      ticketNo++;
      dressTicket();
    });

    $('#welcomeFile').onchange = async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try { await setWelcome(file); toast('Welcome screen updated.'); }
      catch (err) { toast(err.message, true); }
    };
    $('#welcomeClear').onclick = async () => {
      try { await BIG.set('welcome', null); } catch (e) { /* nothing stored */ }
      loadWelcome();
    };

    $('#frameFile').onchange = async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const f = await addFrame(file);
        toast(`Frame added with ${f.slots.length} photo spot${f.slots.length > 1 ? 's' : ''}.`);
        renderFrameList();
      } catch (err) { toast(err.message, true); }
    };
    $('#calBtn').onclick = async () => {
      if (S.connection === 'browser' && !NATIVE) {
        toast('The calibration page needs a directly connected printer (USB, Bluetooth or Serial).', true);
        return;
      }
      try {
        await ensurePrinter();
        const page = compose.calibrationPage(fullDots(), effDots(), Number(S.printShift) || 0);
        await printer.write(escpos.encodeRaster(page, { chunkRows: Number(S.chunkRows), feedLines: Number(S.feedLines), cut: !!S.cut }));
        toast('Calibration page sent to the printer.');
      } catch (e) { toast(printError(e), true); }
      updatePrinterStatus();
    };

    $('#welcomeScreen').onclick = startSession;
    $$('[data-go]').forEach((b) => (b.onclick = () => (b.dataset.go === 'welcome' ? goHome() : show(b.dataset.go))));
    $('#shootBtn').onclick = () => { if (!state.running) runSequence(); };
    $('#captureCancel').onclick = () => {
      if (!state.hasOrder) { goHome(); return; }
      // A cancelled retake goes back to the receipt with the previous photos and refunds the retake.
      state.seq++;
      state.running = false;
      stopCamera();
      if (state.backup) { state.shots = state.backup.shots; state.xf = state.backup.xf; state.decor = state.backup.decor; state.backup = null; state.retakesLeft++; }
      enterReview();
    };
    $('#camRetry').onclick = () => { stopCamera(); enterCapture(state.retake); };
    $('#fileInput').onchange = (e) => { loadFiles(e.target.files); e.target.value = ''; };

    $('#doneBtn').onclick = goHome;
    // Review screen
    $('#reviewCancel').onclick = goHome;
    $('#mirrorBtn').onclick = () => {
      const t = state.xf[state.sel] || (state.xf[state.sel] = freshXf());
      t.flip = !t.flip;
      drawReview();
    };
    $('#reviewEdit').onclick = () => openEdit(state.sel);
    $('#reviewRetake').onclick = () => requestRetake(state.sel);
    $('#startOverBtn').onclick = () => requestRetake(null);
    $('#useBtn').onclick = enterResult;
    $('#backReview').onclick = enterReview;
    window.addEventListener('resize', fitPreview);
    $('#copiesMinus').onclick = () => { state.copies--; updateResultUi(); };
    $('#copiesPlus').onclick = () => { state.copies++; updateResultUi(); };
    $('#printBtn').onclick = () => {
      const freeLeft = (Number(S.copiesMax) || 1) - state.printed;
      if (freeLeft > 0) printSession(Math.min(state.copies, freeLeft));
      else if (S.printMore) openMore();
    };
    $('#saveBtn').onclick = () => saveCopy(false);

    // Sharing
    share.watch(updateShareStatus);
    $('#shareBtn').onclick = () => openShare();
    $('#shareClose').onclick = () => $('#shareDlg').close();
    $('#shareSend').onclick = async () => {
      const to = $('#shareEmail').value.trim();
      const id = state.shareId;
      if (!to || !id) return;
      const btn = $('#shareSend');
      btn.disabled = true;
      $('#shareNote').textContent = 'Sending…';
      try {
        await share.email(id, to);
        $('#shareNote').textContent = 'Sent. Check your inbox.';
        $('#shareEmail').value = '';
      } catch (e) { $('#shareNote').textContent = e.message; }
      btn.disabled = false;
      bumpIdle();
    };
    $('#shareTest').onclick = async () => {
      configShare();
      try { await share.ping(); toast('Connected to the sharing server.'); }
      catch (e) { toast(e.message, true); }
    };
    setInterval(pollVouchers, 20000);

    // Settings tabs: tap to switch; left and right arrow keys move between them.
    const tabs = $$('#settingsTabs .tab');
    tabs.forEach((b, i) => {
      b.onclick = () => showTab(b.dataset.tab);
      b.onkeydown = (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        showTab(next.dataset.tab);
        next.focus();
      };
    });

    // Settings + PIN
    $('#gear').onclick = () => {
      if (!S.pin) return openSettings();
      $('#pinInput').value = '';
      $('#pinErr').hidden = true;
      $('#pinDlg').showModal();
      $('#pinInput').focus();
    };
    $('#pinCancel').onclick = () => $('#pinDlg').close();
    $('#pinOk').onclick = (e) => {
      if ($('#pinInput').value !== S.pin) {
        e.preventDefault();
        $('#pinErr').hidden = false;
        $('#pinInput').value = '';
        return;
      }
      setTimeout(openSettings, 0);
    };
    // Applied on every way of closing: the Close button calls it directly, and the dialog's own
    // close event covers Esc and the system back gesture. The flag stops it running twice.
    const applySettings = () => {
      if (!settingsOpen) return;
      settingsOpen = false;
      if (cameraLive() && state.camId !== S.cameraId) {
        // A different camera was chosen: reopen with it.
        stopCamera();
        if (state.screen === 'capture') startCamera().catch(() => {});
      }
      buildStickerTray();
      configShare();
      styleWelcome();
      applyBranding();
      renderTemplates();
      applyLive();
      if (state.screen === 'result' && state.shots.length) { updateResultUi(); buildTemplateSide(); renderReceipt(); }
      if (state.screen === 'review' && state.shots.length) { updateReviewUi(); drawReview(); }
    };
    $('#settingsClose').onclick = () => { $('#settingsDlg').close(); applySettings(); };
    $('#settingsDlg').addEventListener('close', applySettings);
    $$('[data-k]').forEach((el) => {
      const handler = () => { readSetting(el); refreshTestPreview(); if (el.dataset.k === 'connection') updatePrinterStatus(); };
      el.addEventListener('input', handler);
      el.addEventListener('change', handler);
    });
    $$('[data-asset]').forEach((inp) => (inp.onchange = async () => {
      const file = inp.files[0];
      const k = inp.dataset.asset;
      inp.value = '';
      if (!file) return;
      try {
        let data;
        if (k === 'thanks') {
          if (file.size > 1500000) throw new Error('That sound is too large. Use a file under 1.5 MB.');
          data = await readDataUrl(file);
        } else {
          data = await shrinkImage(file, k === 'logo' ? 600 : 1600, k === 'logo' ? 'image/png' : 'image/jpeg');
        }
        if (!ASSET.set(k, data)) throw new Error('Not enough storage for that file. Try a smaller one.');
        loadBrand();
        refreshTestPreview();
      } catch (e) { toast(e.message, true); }
    }));
    $$('[data-asset-clear]').forEach((b) => (b.onclick = () => { ASSET.set(b.dataset.assetClear, ''); loadBrand(); renderTemplates(); refreshTestPreview(); }));
    $('#connectBtn').onclick = async () => {
      try { await printer.connect(S.connection, S); toast('Printer connected.'); }
      catch (e) { toast(printError(e), true); }
      updatePrinterStatus();
    };
    $('#testBtn').onclick = async () => {
      try {
        await compose.loadFonts(S);
        await printBitmap(testBitmap(), 1);
        if (S.connection !== 'browser' || NATIVE) toast('Test page sent to the printer.');
      } catch (e) { toast(printError(e), true); }
      updatePrinterStatus();
    };
    if ($('#fsBtn')) $('#fsBtn').onclick = () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => toast('Full screen is not available here.', true));
    };
    $('#resetBtn').onclick = () => { S = freshDefaults(); saveSettings(); renderFrameList(); fillSettings(); loadBrand(); refreshTestPreview(); };

    // Session clock, idle return and screen wake lock
    ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, bumpIdle, true));
    setInterval(() => {
      const now = Date.now();
      const idleLeft = Math.ceil((state.idleAt - now) / 1000);
      const sessLeft = state.sessionEnd ? Math.ceil((state.sessionEnd - now) / 1000) : Infinity;
      // With a session limit the clock always shows. Without one, a countdown appears only in the
      // last 30 seconds before an untouched booth returns to the welcome page.
      const idleSoon = idleLeft <= 30;
      const useIdle = idleSoon && idleLeft < sessLeft;
      const shown = Math.max(0, useIdle ? idleLeft : sessLeft);
      const visible = state.screen !== 'welcome' && (state.sessionEnd || idleSoon) && Number.isFinite(shown);
      const label = useIdle ? 'Closing in' : 'Session left';
      const pill = visible ? `${label} ${Math.floor(shown / 60)}:${String(shown % 60).padStart(2, '0')}` : '';
      $$('.session').forEach((el) => (el.textContent = pill));
      if (state.screen === 'welcome' || state.printing) return;
      if ($('#settingsDlg').open || $('#pinDlg').open) {
        bumpIdle();
        if (state.sessionEnd) state.sessionEnd += 1000;
        return;
      }
      if (sessLeft <= 0) { goHome(); toast('Session time is up.'); return; }
      if (idleLeft <= 0 && !state.running) goHome();
    }, 1000);
    let lock = null;
    const keepAwake = async () => {
      try { if (navigator.wakeLock && !lock) { lock = await navigator.wakeLock.request('screen'); lock.onrelease = () => (lock = null); } }
      catch (e) { /* not critical */ }
    };
    document.addEventListener('pointerdown', keepAwake);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('resize', () => { if (state.screen === 'capture') applyLive(); });

    if (!NATIVE && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

    applyBranding();
    bumpIdle();
    printer.restore(S.connection, S).then(updatePrinterStatus);
  }

  init();
})();
