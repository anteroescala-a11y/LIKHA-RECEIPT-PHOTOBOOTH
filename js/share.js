/* Talks to the sharing server (server/Code.gs on Google Apps Script) and keeps an upload queue
   so a slow or missing connection never holds up printing. */
(function () {
  const RPB = (window.RPB = window.RPB || {});
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let cfg = { url: '', key: '' };
  const queue = [];        // { id, sig, payload, tries }
  const uploaded = {};     // id -> sig of the version on the server
  const watchers = new Set();
  let pumping = false;

  const configure = (c) => { cfg = { url: String(c.url || '').trim(), key: String(c.key || '') }; };
  const configured = () => /^https:\/\//.test(cfg.url);

  async function call(action, payload, timeoutMs) {
    if (!configured()) throw new Error('Sharing is not set up yet.');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs || 30000);
    let res;
    try {
      // text/plain keeps this a "simple" request, which Apps Script web apps accept cross-origin.
      res = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action, key: cfg.key }, payload || {})),
        signal: ctl.signal,
        redirect: 'follow',
      });
    } catch (e) {
      throw new Error('No answer from the sharing server. Check the internet connection.');
    } finally {
      clearTimeout(timer);
    }
    let j;
    try { j = await res.json(); } catch (e) { throw new Error('The sharing server address looks wrong. It should end in /exec.'); }
    if (!j.ok) throw new Error(j.error || 'The sharing server refused the request.');
    return j;
  }

  /* Ids are made on the booth so the QR can be printed before the upload finishes. */
  function newId() {
    const letters = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
    const all = letters + '23456789';
    const rnd = crypto.getRandomValues(new Uint8Array(10));
    let id = letters[rnd[0] % letters.length];
    for (let i = 1; i < 10; i++) id += all[rnd[i] % all.length];
    return id;
  }
  const pageUrl = (id) => cfg.url + (cfg.url.includes('?') ? '&' : '?') + 'p=' + id;
  const galleryUrl = (event) => cfg.url + (cfg.url.includes('?') ? '&' : '?') + 'g=' + encodeURIComponent(event);

  function status(id, sig) {
    if (uploaded[id] && (sig == null || uploaded[id] === sig)) return 'done';
    const job = queue.find((q) => q.id === id);
    if (!job) return 'none';
    return job.tries ? 'waiting' : 'uploading';
  }
  const notify = () => watchers.forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } });
  const watch = (fn) => { watchers.add(fn); return () => watchers.delete(fn); };

  /* A newer version of the same session replaces the queued one. */
  function enqueue(job) {
    const i = queue.findIndex((q) => q.id === job.id);
    if (i > 0 || (i === 0 && !pumping)) queue.splice(i, 1);
    queue.push(Object.assign({ tries: 0 }, job));
    notify();
    pump();
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    while (queue.length) {
      const job = queue[0];
      try {
        await call('upload', job.payload, 90000);
        uploaded[job.id] = job.sig;
        queue.shift();
        notify();
      } catch (e) {
        job.tries++;
        notify();
        if (job.tries > 60) { queue.shift(); continue; }
        await sleep(20000);
      }
    }
    pumping = false;
  }

  async function whenUploaded(id, timeoutMs) {
    const until = Date.now() + (timeoutMs || 60000);
    while (!uploaded[id]) {
      if (Date.now() > until) throw new Error('The photo is still uploading. Try again in a moment.');
      await sleep(400);
    }
  }

  async function email(id, to) {
    await whenUploaded(id, 60000);
    return call('email', { id, to }, 45000);
  }

  RPB.share = {
    configure, configured, call, newId, pageUrl, galleryUrl, enqueue, status, watch, email,
    ping: () => call('ping', null, 20000),
    vouchers: () => call('vouchers', null, 20000).then((j) => j.codes || []),
    voucherAck: (codes) => call('voucherAck', { codes }, 20000),
    redeem: (code) => call('redeem', { code }, 20000),
    pending: () => queue.length,
  };
})();
