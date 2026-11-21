/* Booth Bots: runs the photobooth business. Bookings, inquiries, follow-ups and marketing posts.
   Everything is stored on this device (localStorage); use Bot Manager > Backup to move it. */
(function () {
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => [...(el || document).querySelectorAll(s)];
  const STORE = 'bb.data.v1';

  /* ---------- data ---------- */
  const DEFAULT_SETTINGS = {
    business: 'AI Bots Agency', city: 'Manila', currency: '₱', deposit: 30, extraHour: 2000, travelFee: 1500,
    perDay: 1, lang: 'en', slots: '12:00, 18:00, 20:00', page: '',
    hashtags: '#photobooth #receiptphotobooth #AIphotobooth #eventsph',
    syncUrl: '', syncKey: '', autoSync: true,
    packages: [
      { id: 'basic', name: 'Bot Starter', hours: 2, price: 6000, includes: 'unlimited receipt prints, 2 frame designs, digital copies via QR' },
      { id: 'standard', name: 'Agent Pro', hours: 3, price: 8500, includes: 'unlimited receipt prints, custom event frame, robot props, digital copies via QR' },
      { id: 'premium', name: 'Full AI Agency', hours: 4, price: 11000, includes: 'unlimited receipt prints, custom frame + welcome screen, robot props, online gallery, booth attendant' },
    ],
  };
  const EVENT_TYPES = ['wedding', 'debut', 'birthday', 'christening', 'corporate', 'school event', 'reunion', 'party', 'other'];
  const STATUSES = ['inquiry', 'confirmed', 'paid', 'done', 'cancelled'];

  function load() {
    let d = {};
    try { d = JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (e) { d = {}; }
    d.settings = Object.assign(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), d.settings || {});
    d.bookings = Array.isArray(d.bookings) ? d.bookings : [];
    d.posts = Array.isArray(d.posts) ? d.posts : [];
    d.acks = Array.isArray(d.acks) ? d.acks : [];
    d.log = Array.isArray(d.log) ? d.log : [];
    d.deleted = Array.isArray(d.deleted) ? d.deleted : [];
    d.sync = d.sync || {};
    d.bookings.forEach((b) => { if (!b.updated) b.updated = b.created || 1; });
    return d;
  }
  let D = load();
  const S = () => D.settings;
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(D)); } catch (e) { toast('Could not save on this device.'); }
    if (typeof scheduleSync === 'function') scheduleSync();
  }
  /* Marks a booking as changed now, so the newer copy wins when syncing with the sheet. */
  const touch = (b) => { b.updated = Date.now(); return b; };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  /* ---------- helpers ---------- */
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const p2 = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const parseIso = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1, 12); };
  const today = () => iso(new Date());
  const addDays = (s, n) => { const d = parseIso(s); d.setDate(d.getDate() + n); return iso(d); };
  const daysBetween = (a, b) => Math.round((parseIso(b) - parseIso(a)) / 86400000);
  const fmtDate = (s) => (s ? parseIso(s).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : 'TBA');
  const fmtShort = (s) => parseIso(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const fmtTime = (t) => {
    if (!t) return '';
    const [h, m] = t.split(':').map(Number);
    return `${((h + 11) % 12) + 1}${m ? ':' + p2(m) : ''} ${h < 12 ? 'AM' : 'PM'}`;
  };
  const money = (n) => S().currency + Math.round(Number(n) || 0).toLocaleString('en-US');
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const pkgById = (id) => S().packages.find((p) => p.id === id) || S().packages[0];
  const slots = () => String(S().slots).split(/[,\s]+/).filter((t) => /^\d{1,2}:\d{2}$/.test(t)).map((t) => p2(t.split(':')[0]) + ':' + t.split(':')[1]);
  const active = (b) => b.status === 'confirmed' || b.status === 'paid';

  function priceOf(b) {
    const p = pkgById(b.pkg);
    if (!p) return 0;
    const extra = Math.max(0, (Number(b.hours) || p.hours) - p.hours);
    return p.price + extra * (Number(S().extraHour) || 0) + (b.travel ? Number(S().travelFee) || 0 : 0);
  }
  const depositOf = (b) => Math.round((priceOf(b) * (Number(S().deposit) || 0)) / 100);
  const bookedOn = (date, exceptId) => D.bookings.filter((b) => b.date === date && active(b) && b.id !== exceptId);
  const isFree = (date, exceptId) => bookedOn(date, exceptId).length < (Number(S().perDay) || 1);
  function openDates(from, days, weekendsOnly) {
    const out = [];
    for (let i = 0; i < days; i++) {
      const d = addDays(from, i);
      const dow = parseIso(d).getDay();
      if (weekendsOnly && !(dow === 0 || dow === 5 || dow === 6)) continue;
      if (isFree(d)) out.push(d);
    }
    return out;
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 2400);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); }
    catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.append(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e2) { /* ignore */ }
      ta.parentNode.removeChild(ta);
    }
    toast('Copied. Paste it into Messenger.');
  }
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.parentNode.removeChild(a); }, 500);
  }

  /* ---------- bots ---------- */
  const BOTS = {
    inquiry: { name: 'Inquiry Bot', color: '#5b8def', face: '• •' },
    booking: { name: 'Booking Bot', color: '#ef5d7a', face: '◦ ◦' },
    scheduler: { name: 'Scheduler Bot', color: '#9b7bf0', face: '^ ^' },
    followup: { name: 'Follow-up Bot', color: '#b88a5a', face: '• •' },
    marketing: { name: 'Marketing Bot', color: '#e8b04a', face: '• •' },
    manager: { name: 'Bot Manager', color: '#3ecf8e', face: '˘ ˘' },
  };
  const face = (k, cls) => `<span class="bot ${cls || ''}" style="--c:${BOTS[k].color}"><b>${BOTS[k].face}</b></span>`;
  function log(bot, text) {
    D.log.unshift({ bot, text, at: Date.now() });
    D.log = D.log.slice(0, 40);
    save();
    renderLog();
  }
  function renderLog() {
    $('#log').innerHTML = D.log.slice(0, 5).map((l) => {
      const t = new Date(l.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      return `<li>${face(l.bot, 'sm')}<div><strong>${BOTS[l.bot].name}</strong><time>${t}</time><p>${esc(l.text)}</p></div></li>`;
    }).join('') || `<li>${face('manager', 'sm')}<div><strong>Bot Manager</strong><p>No activity yet. Paste a customer message into the Inquiry Bot to begin.</p></div></li>`;
  }

  /* ---------- Inquiry Bot: reads a customer message ---------- */
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const MONTH_RE = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|enero|pebrero|marso|abril|mayo|hunyo|hulyo|agosto|setyembre|oktubre|nobyembre|disyembre)[a-z]*\\.?';
  const TL_MONTHS = { enero: 0, pebrero: 1, marso: 2, abril: 3, mayo: 4, hunyo: 5, hulyo: 6, agosto: 7, setyembre: 8, oktubre: 9, nobyembre: 10, disyembre: 11 };
  const monthIndex = (w) => (w in TL_MONTHS ? TL_MONTHS[w] : MONTHS.indexOf(w.slice(0, 3)));
  function makeDate(y, m, d) {
    if (m < 0 || m > 11 || d < 1 || d > 31) return '';
    const now = new Date();
    let year = y ? Number(y) : now.getFullYear();
    if (year < 100) year += 2000;
    let dt = new Date(year, m, d, 12);
    if (!y && iso(dt) < today()) dt = new Date(year + 1, m, d, 12);
    return iso(dt);
  }
  function parseInquiry(text) {
    const t = text.toLowerCase();
    const r = {};
    let m;
    if ((m = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/))) r.date = makeDate(m[1], m[2] - 1, +m[3]);
    else if ((m = t.match(new RegExp(MONTH_RE + '\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?')))) r.date = makeDate(m[3], monthIndex(m[1]), +m[2]);
    else if ((m = t.match(new RegExp('(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?' + MONTH_RE + '(?:,?\\s*(\\d{4}))?')))) r.date = makeDate(m[3], monthIndex(m[2]), +m[1]);
    else if ((m = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))) r.date = makeDate(m[3], m[1] - 1, +m[2]);
    const types = [['wedding', /wedding|kasal/], ['debut', /debut|18th/], ['christening', /christening|baptism|binyag/],
      ['birthday', /birthday|bday|b-day|kaarawan|\d+(st|nd|rd|th) bday/], ['corporate', /corporate|company|office|christmas party|team ?building|launch|conference/],
      ['school event', /school|prom|graduation|recognition|acquaintance/], ['reunion', /reunion/], ['party', /party|celebration/]];
    for (const [k, re] of types) if (re.test(t)) { r.type = k; break; }
    if ((m = t.match(/(\d+(?:\.\d)?)\s*(?:hours?|hrs?|oras)\b/))) r.hours = Number(m[1]);
    if ((m = t.match(/(\d+)\s*(?:pax|guests?|people|persons|katao|bisita)/))) r.guests = Number(m[1]);
    if ((m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/))) r.time = `${p2((+m[1] % 12) + (m[3] === 'pm' ? 12 : 0))}:${m[2] || '00'}`;
    if ((m = text.match(/(?:\bat|\bsa|venue(?: is|:)?)\s+((?:the\s+)?[A-Z][\w'&.-]*(?:\s+[A-Z][\w'&.-]*){0,5})/))) r.venue = m[1].trim();
    if ((m = text.match(/(?:i am|i'm|this is|ako si|my name is)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/i))) r.name = m[1].replace(/\b\w/g, (c) => c.toUpperCase());
    if ((m = text.match(/(\+?63\s?9\d{2}[\s-]?\d{3}[\s-]?\d{4}|09\d{2}[\s-]?\d{3}[\s-]?\d{4})/))) r.contact = m[1];
    for (const p of S().packages) if (t.includes(p.name.toLowerCase())) r.pkg = p.id;
    return r;
  }
  function recommend(r) {
    const list = [...S().packages].sort((a, b) => a.hours - b.hours);
    if (r.pkg) return pkgById(r.pkg);
    if (r.hours) return list.find((p) => p.hours >= r.hours) || list[list.length - 1];
    if (/wedding|debut|corporate/.test(r.type || '') || (r.guests || 0) >= 150) return list[list.length - 1];
    return list[Math.min(1, list.length - 1)];
  }
  function draftReply(r, lang) {
    const s = S();
    const p = recommend(r);
    const b = { pkg: p.id, hours: Math.max(r.hours || 0, p.hours), travel: false };
    const price = priceOf(b);
    const dep = Math.round((price * s.deposit) / 100);
    const extraH = b.hours - p.hours;
    const tl = lang === 'tl';
    const L = [];
    const hi = r.name ? r.name.split(' ')[0] : '';
    L.push(tl ? `Hi${hi ? ' ' + hi : ''}! Salamat po sa pag-message sa ${s.business} 🤖📸` : `Hi${hi ? ' ' + hi : ''}! Thanks for reaching out to ${s.business} 🤖📸`);
    if (r.date) {
      if (isFree(r.date)) L.push(tl ? `Good news po, available pa ang ${fmtDate(r.date)}! ✅` : `Good news: ${fmtDate(r.date)} is still open! ✅`);
      else {
        const alt = openDates(addDays(r.date, -14), 29).filter((d) => d >= today()).sort((a, c) => Math.abs(daysBetween(r.date, a)) - Math.abs(daysBetween(r.date, c))).slice(0, 3);
        L.push(tl ? `Sorry po, fully booked na kami sa ${fmtDate(r.date)}. 😢 Open pa po kami sa: ${alt.map(fmtShort).join(', ') || 'ibang petsa'}.`
          : `Sorry, we're fully booked on ${fmtDate(r.date)}. 😢 Nearby open dates: ${alt.map(fmtShort).join(', ') || 'please suggest another date'}.`);
      }
    }
    const what = r.type ? (tl ? `Para sa ${r.type} ninyo` : `For your ${r.type}`) : (tl ? 'Para sa event ninyo' : 'For your event');
    L.push('');
    L.push(tl ? `${what}, recommended po namin ang ${p.name} package (${p.hours} hrs): ${p.includes}.` : `${what}, we recommend our ${p.name} package (${p.hours} hrs): ${p.includes}.`);
    L.push(tl ? `Rate: ${money(price)}${extraH > 0 ? ` (kasama na ang ${extraH} extra hr${extraH > 1 ? 's' : ''})` : ''}.` : `Rate: ${money(price)}${extraH > 0 ? ` (includes ${extraH} extra hour${extraH > 1 ? 's' : ''})` : ''}.`);
    L.push(tl ? `Other packages: ${s.packages.filter((x) => x.id !== p.id).map((x) => `${x.name} ${money(x.price)}`).join(' · ')}` : `Other packages: ${s.packages.filter((x) => x.id !== p.id).map((x) => `${x.name} ${money(x.price)}`).join(' · ')}`);
    L.push('');
    L.push(tl ? `Para ma-reserve ang date, ${s.deposit}% downpayment lang po (${money(dep)}), balance sa mismong event day.` : `To lock the date we take a ${s.deposit}% downpayment (${money(dep)}); the balance is paid on the event day.`);
    const missing = [];
    if (!r.date) missing.push(tl ? 'petsa ng event' : 'event date');
    if (!r.time) missing.push(tl ? 'oras ng start' : 'start time');
    if (!r.venue) missing.push(tl ? 'venue' : 'venue');
    if (!r.contact) missing.push(tl ? 'contact number' : 'contact number');
    if (missing.length) L.push(tl ? `Pa-send na lang po ng ${missing.join(', ')} para ma-finalize natin. Salamat po! 🙏` : `Could you send your ${missing.join(', ')} so we can finalize? Thank you! 🙏`);
    else L.push(tl ? 'Salamat po! 🙏' : 'Thank you! 🙏');
    return { text: L.join('\n'), pkg: p, price };
  }

  /* ---------- message templates for one booking ---------- */
  function bookingDetails(b) {
    const p = pkgById(b.pkg);
    return [
      `📅 ${fmtDate(b.date)}${b.time ? ' · ' + fmtTime(b.time) : ''}`,
      `📍 ${b.venue || 'Venue TBA'}`,
      `🤖 ${p.name} package, ${b.hours || p.hours} hours`,
      `💰 Total ${money(priceOf(b))} · Downpayment ${money(depositOf(b))}`,
    ].join('\n');
  }
  const MSG = {
    confirm: (b, tl) => tl
      ? `Hi ${first(b)}! Confirmed na po ang booking ninyo sa ${S().business} 🎉\n\n${bookingDetails(b)}\n\nPara ma-lock ang date, pa-send po ng downpayment na ${money(depositOf(b))}. Salamat po! 🤖📸`
      : `Hi ${first(b)}! Your booking with ${S().business} is confirmed 🎉\n\n${bookingDetails(b)}\n\nTo lock the date, please send the ${money(depositOf(b))} downpayment. Thank you! 🤖📸`,
    followInquiry: (b, tl) => tl
      ? `Hi ${first(b)}! Follow up lang po sa inquiry ninyo para sa ${fmtDate(b.date)}. Available pa po ang date pero first come, first served po kami. Gusto n'yo na po bang i-reserve? 😊`
      : `Hi ${first(b)}! Just following up on your inquiry for ${fmtDate(b.date)}. The date is still open, but we book first come, first served. Would you like us to reserve it for you? 😊`,
    deposit: (b, tl) => tl
      ? `Hi ${first(b)}! Friendly reminder po: ${money(depositOf(b))} downpayment para ma-lock ang ${fmtDate(b.date)}. Pa-send na lang po ng screenshot kapag nakapagbayad na. Salamat po! 🙏`
      : `Hi ${first(b)}! Friendly reminder: a ${money(depositOf(b))} downpayment locks in ${fmtDate(b.date)}. Just send a screenshot once it's paid. Thank you! 🙏`,
    reminder: (b, tl) => tl
      ? `Hi ${first(b)}! Excited na po ang bots namin para sa event ninyo 🤖✨\n\n${bookingDetails(b)}\n\nDarating po kami 1 hour before para mag-setup. May kailangan po ba kaming malaman (parking, power outlet, theme)?`
      : `Hi ${first(b)}! Our bots are excited for your event 🤖✨\n\n${bookingDetails(b)}\n\nWe'll arrive 1 hour early to set up. Anything we should know (parking, power outlet, theme)?`,
    thanks: (b, tl) => tl
      ? `Hi ${first(b)}! Maraming salamat po sa pag-book sa ${S().business}! 💚 Sana nag-enjoy kayo sa photobooth.\n\nKung may 1 minute po kayo, malaking tulong ang review sa page namin${S().page ? ' (' + S().page + ')' : ''}. At i-tag n'yo po kami sa photos! 📸`
      : `Hi ${first(b)}! Thank you so much for booking ${S().business}! 💚 We hope your guests loved the photobooth.\n\nIf you have a minute, a quick review on our page${S().page ? ' (' + S().page + ')' : ''} would mean a lot. And please tag us in your photos! 📸`,
  };
  const first = (b) => (b.client || 'there').split(' ')[0];
  function ics(b) {
    const p = pkgById(b.pkg);
    const d = b.date.replace(/-/g, '');
    const [h, m] = (b.time || '10:00').split(':').map(Number);
    const endH = h + (Number(b.hours) || p.hours);
    const dt = (hh, mm) => `${d}T${p2(Math.min(23, hh))}${p2(mm)}00`;
    const txt = (t) => String(t).replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Booth Bots//EN', 'BEGIN:VEVENT', `UID:${b.id}@boothbots`,
      `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`, `DTSTART:${dt(h, m)}`, `DTEND:${dt(endH, m)}`,
      `SUMMARY:${txt(`Photobooth: ${b.client} (${b.type})`)}`, `LOCATION:${txt(b.venue || '')}`,
      `DESCRIPTION:${txt(bookingDetails(b) + (b.contact ? '\nContact: ' + b.contact : '') + (b.notes ? '\n' + b.notes : ''))}`,
      'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  }

  /* ---------- Follow-up Bot: what needs sending ---------- */
  function tasks() {
    const t0 = today();
    const out = [];
    for (const b of D.bookings) {
      const until = daysBetween(t0, b.date);
      const age = b.created ? Math.floor((Date.now() - b.created) / 86400000) : 99;
      if (b.status === 'inquiry' && until >= 0 && age >= 1) out.push({ id: 'inq:' + b.id, kind: 'followInquiry', label: 'Follow up inquiry', b, due: until });
      if (b.status === 'confirmed' && until >= 0) out.push({ id: 'dep:' + b.id, kind: 'deposit', label: 'Downpayment reminder', b, due: until });
      if (active(b) && until >= 0 && until <= 3) out.push({ id: 'rem:' + b.id, kind: 'reminder', label: until === 0 ? 'Event is today' : `Event in ${until} day${until > 1 ? 's' : ''}`, b, due: until });
      if ((b.status === 'done' || active(b)) && until < 0 && until >= -14) out.push({ id: 'thx:' + b.id, kind: 'thanks', label: 'Thank-you + review request', b, due: -until, markDone: active(b) });
    }
    return out.filter((x) => !D.acks.includes(x.id)).sort((a, c) => a.due - c.due);
  }

  /* ---------- Bot Manager: checks ---------- */
  function checks() {
    const t0 = today();
    const res = [];
    const dates = {};
    D.bookings.filter(active).forEach((b) => (dates[b.date] = (dates[b.date] || 0) + 1));
    const clash = Object.entries(dates).filter(([d, n]) => d >= t0 && n > (Number(S().perDay) || 1));
    res.push(clash.length ? { ok: false, text: `Double booking on ${clash.map(([d]) => fmtShort(d)).join(', ')}.` } : { ok: true, text: 'No double bookings.' });
    const unpaid = D.bookings.filter((b) => b.status === 'confirmed' && daysBetween(t0, b.date) >= 0 && daysBetween(t0, b.date) <= 14);
    res.push(unpaid.length ? { ok: false, text: `${unpaid.length} confirmed event${unpaid.length > 1 ? 's' : ''} in the next 2 weeks without a downpayment.` } : { ok: true, text: 'Downpayments are in for the next 2 weeks.' });
    const stale = D.bookings.filter((b) => b.status === 'inquiry' && b.created && Date.now() - b.created > 2 * 86400000 && b.date >= t0);
    res.push(stale.length ? { ok: false, text: `${stale.length} inquir${stale.length > 1 ? 'ies' : 'y'} waiting more than 2 days.` } : { ok: true, text: 'No inquiries left waiting.' });
    const posts = D.posts.filter((p) => p.status !== 'posted' && p.date >= t0 && p.date <= addDays(t0, 6));
    res.push(posts.length ? { ok: true, text: `${posts.length} post${posts.length > 1 ? 's' : ''} planned this week.` } : { ok: false, text: 'No posts planned this week. Ask the Marketing Bot to plan one.' });
    const past = D.bookings.filter((b) => active(b) && b.date < t0);
    res.push(past.length ? { ok: false, text: `${past.length} past event${past.length > 1 ? 's' : ''} not marked done.` } : { ok: true, text: 'Past events are all closed.' });
    return res;
  }

  /* ---------- Marketing Bot ---------- */
  function tags(platform, extra) {
    const city = String(S().city || '').replace(/\s+/g, '');
    let t = `${S().hashtags} ${city ? '#' + city + 'Events #' + city + 'Photobooth' : ''} ${extra || ''}`.trim().split(/\s+/);
    t = [...new Set(t)];
    if (platform === 'facebook') t = t.slice(0, 4);
    if (platform === 'tiktok') t = t.slice(0, 5).concat('#fyp');
    return t.join(' ');
  }
  function monthName(off) { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + (off || 0)); return d.toLocaleDateString('en-US', { month: 'long' }); }
  function caption(type, platform, b) {
    const s = S();
    const cheapest = [...s.packages].sort((a, c) => a.price - c.price)[0];
    const end = new Date(); end.setMonth(end.getMonth() + 1, 0);
    const leftThis = openDates(today(), daysBetween(today(), iso(end)) + 1, true);
    const nextStart = iso(new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1));
    const leftNext = openDates(nextStart, 31, true).filter((d) => parseIso(d).getMonth() === parseIso(nextStart).getMonth());
    const cta = pick(['Message us to book! 💬', 'DM us to check your date 📩', 'Book now while dates are open! 🗓️', 'Send us a message for a quote 💬']);
    let body;
    if (type === 'promo') {
      body = pick([
        `🤖📸 Your guests pose. Our bots print. ${s.business} brings the receipt photobooth that turns every smile into an "Agent ID" print, a bot invoice or a boot log!`,
        `Forget boring photo strips. 🧾 Our AI-themed receipt photobooth prints every guest their own robot agent ID, in seconds!`,
        `Beep boop! 🤖 Looking for a photobooth that guests actually talk about? Receipt prints, robot props and instant QR copies.`,
      ]) + `\n\nPackages start at ${money(cheapest.price)} for ${cheapest.hours} hours:\n` + s.packages.map((p) => `• ${p.name}: ${p.hours} hrs, ${money(p.price)}`).join('\n');
    } else if (type === 'dates') {
      const useNext = leftThis.length < 2 && leftNext.length;
      const list = useNext ? leftNext : leftThis;
      const mon = useNext ? monthName(1) : monthName(0);
      const n = list.length, sN = n > 1 ? 's' : '';
      body = list.length
        ? pick([`🚨 Only ${n} weekend date${sN} left in ${mon}!`, `🗓️ ${mon} is filling up fast. ${n} weekend slot${sN} left!`,
            `🤖 Bot Manager report: ${n} open weekend${sN} in ${mon}. After that, the bots are fully booked!`, `⏳ Last call for ${mon}! Our booth is free on just ${n} weekend${sN}.`]) +
          `\n\n📅 Open: ${list.slice(0, 8).map(fmtShort).join(', ')}\n\n` +
          pick(['Our bots are ready to print memories at your wedding, debut, birthday or company party. 🤖🧾',
            'Grab a date before it is gone, and your guests go home with their own robot agent ID receipt. 🪪',
            'Weddings, debuts, birthdays, office parties: one message and the Booking Bot holds your date. 💬'])
        : `🎉 Every ${mon} weekend is booked. Thank you! Now booking ${monthName(1)} and beyond. 🤖`;
    } else if (type === 'recap') {
      const who = b ? `${b.client}'s ${b.type}` : 'last weekend\'s event';
      body = pick([
        `💚 What a night at ${who}${b && b.venue ? ' at ' + b.venue : ''}! Our bots printed agent IDs all night and the guests loved every receipt. 🧾🤖`,
        `Throwback to ${who}! 📸 Smiles, robot props and a whole lot of receipts. Thank you for letting our bots be part of your celebration!`,
      ]);
    } else if (type === 'feature') {
      body = pick([
        `How it works 🤖\n1️⃣ Pick your frame: Agent ID, Bot Invoice or Boot Log\n2️⃣ Strike a pose (we count down)\n3️⃣ Add robot stickers\n4️⃣ Your receipt prints in seconds, plus a QR code for the digital copy 📲`,
        `Every guest becomes an AI agent 🤖🪪 Our receipt photobooth gives each one a bot name, a model and a clearance level, printed right on their photo!`,
        `No ink, no mess, no waiting. 🧾 Our thermal receipt photobooth prints in seconds, and guests scan a QR code to keep the colour copy.`,
      ]);
    } else {
      body = pick([
        `Planning a celebration this ${monthName(0)}? 🎉 Tell us your date and our Inquiry Bot (yes, really 🤖) will send your quote in minutes.`,
        `Weddings, debuts, birthdays, company parties: our bots have printed them all. 🧾 Which event should we print next? Comment below! 👇`,
      ]);
    }
    if (platform === 'tiktok') body = body.split('\n\n')[0];
    return `${body}\n\n${cta}\n\n${tags(platform, type === 'recap' ? '#eventrecap' : '')}`;
  }
  function nextSlot() {
    const sl = slots().length ? slots() : ['18:00'];
    const now = new Date();
    for (let i = 0; i < 60; i++) {
      const d = addDays(today(), i);
      for (const t of sl) {
        if (i === 0 && t <= `${p2(now.getHours())}:${p2(now.getMinutes())}`) continue;
        if (!D.posts.some((p) => p.date === d && p.time === t && p.status !== 'posted')) return { date: d, time: t };
      }
    }
    return { date: today(), time: sl[0] };
  }

  /* ---------- Google Sheet sync (server/Code.gs, action bookingsSync) ---------- */
  function syncCfg() {
    let url = S().syncUrl, key = S().syncKey;
    if (!url || !key) {
      // Reuse the booth's sharing server when this console runs on the same device.
      try {
        const r = JSON.parse(localStorage.getItem('rpb.settings.v1') || '{}') || {};
        url = url || r.shareUrl || '';
        key = key || r.shareKey || '';
      } catch (e) { /* ignore */ }
    }
    return { url: String(url || '').trim(), key: String(key || '') };
  }
  const syncReady = () => /^https:\/\/script\.google(usercontent)?\.com\//.test(syncCfg().url) && !!syncCfg().key;
  const syncSig = () => D.bookings.concat(D.deleted).map((b) => b.id + ':' + b.updated).sort().join('|');
  const sync = { busy: false, timer: 0, again: false, err: '' };
  function scheduleSync() {
    if (!S().autoSync || !syncReady() || syncSig() === D.sync.sig) return;
    clearTimeout(sync.timer);
    sync.timer = setTimeout(() => syncNow(false), 4000);
  }
  function fromSheet(x) {
    const byName = S().packages.find((p) => p.name.toLowerCase() === String(x.pkgName || '').toLowerCase());
    const pkg = S().packages.some((p) => p.id === x.pkg) ? x.pkg : byName ? byName.id : S().packages[0].id;
    const status = STATUSES.includes(x.status) ? x.status : 'inquiry';
    const b = { id: x.id, client: x.client, contact: x.contact, type: x.type || 'other', date: x.date, time: x.time, venue: x.venue,
      pkg, hours: Number(x.hours) || pkgById(pkg).hours, travel: !!x.travel, status, notes: x.notes, created: x.created || x.updated, updated: x.updated };
    if (x.deleted) b.deleted = true;
    return b;
  }
  async function syncNow(manual) {
    if (!syncReady()) { if (manual) toast('Add the server address and booth key first.'); return; }
    if (sync.busy) { sync.again = true; return; }
    sync.busy = true;
    if (manual) toast('Syncing with Google Sheets…');
    const { url, key } = syncCfg();
    const out = D.bookings.concat(D.deleted).map((b) => Object.assign({}, b, { pkgName: pkgById(b.pkg).name, total: priceOf(b), downpayment: depositOf(b) }));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 45000);
    try {
      let res;
      try {
        // text/plain keeps this a simple request, which Apps Script web apps accept cross-origin.
        res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'bookingsSync', key, bookings: out }), signal: ctl.signal, redirect: 'follow' });
      } catch (e) { throw new Error('No answer from the server. Check the internet connection.'); }
      let j;
      try { j = await res.json(); } catch (e) { throw new Error('The server address looks wrong. It should end in /exec.'); }
      if (!j.ok) throw new Error(/unknown action/i.test(j.error || '') ? 'The server is an older version. Update Code.gs and deploy a new version.' : j.error || 'The server refused the sync.');
      // Newer copy of each booking wins; the sheet's hand edits come back here.
      const local = new Map(D.bookings.concat(D.deleted).map((b) => [b.id, b]));
      let fromSheetCount = 0;
      for (const x of j.bookings || []) {
        if (!x.id) continue;
        const mine = local.get(x.id);
        if (!mine || (Number(x.updated) || 0) > (Number(mine.updated) || 0)) { local.set(x.id, fromSheet(x)); fromSheetCount++; }
      }
      const all = [...local.values()];
      D.bookings = all.filter((b) => !b.deleted);
      D.deleted = all.filter((b) => b.deleted);
      // After taking changes from the sheet, send once more so it gets the totals worked out here.
      D.sync = { at: Date.now(), url: j.sheetUrl || D.sync.url || '', sig: fromSheetCount ? '' : syncSig() };
      if (fromSheetCount) sync.again = true;
      sync.err = '';
      try { localStorage.setItem(STORE, JSON.stringify(D)); } catch (e) { /* ignore */ }
      if (manual || fromSheetCount) log('booking', `Synced ${D.bookings.length} booking${D.bookings.length === 1 ? '' : 's'} with Google Sheets${fromSheetCount ? ` · ${fromSheetCount} change${fromSheetCount > 1 ? 's' : ''} from the sheet` : ''}.`);
      else renderNodes();
      if (fromSheetCount && current) render();
      else if (current === 'manager') render();
    } catch (e) {
      const msg = e.name === 'AbortError' ? 'The server took too long to answer.' : e.message;
      if (manual || msg !== sync.err) log('manager', 'Sheet sync failed: ' + msg);
      sync.err = msg;
      if (manual) toast(msg);
    } finally {
      clearTimeout(timer);
      sync.busy = false;
      if (sync.again) { sync.again = false; scheduleSync(); }
    }
  }
  const ago = (t) => {
    const s = Math.round((Date.now() - t) / 1000);
    return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : new Date(t).toLocaleDateString();
  };

  /* ---------- panels ---------- */
  let current = '';
  const ui = { inquiry: { text: '', lang: '' }, editing: null, calMonth: null, mkt: { type: 'promo', platform: 'facebook', booking: '', drafts: [] } };
  const head = (k, sub, extra) => `<div class="p-head">${face(k)}<div><h2>${BOTS[k].name}</h2><p>${sub}</p></div><span class="grow"></span>${extra || ''}</div>`;
  const opts = (list, val) => list.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o[0].toUpperCase() + o.slice(1)]; return `<option value="${esc(v)}"${String(v) === String(val) ? ' selected' : ''}>${esc(l)}</option>`; }).join('');
  const langSel = (id, val) => `<select id="${id}" style="width:auto">${opts([['en', 'English'], ['tl', 'Taglish']], val || S().lang)}</select>`;

  const PANELS = {
    inquiry() {
      const lang = ui.inquiry.lang || S().lang;
      const r = ui.inquiry.text ? parseInquiry(ui.inquiry.text) : null;
      let result = '';
      if (r) {
        const dr = draftReply(r, lang);
        ui.inquiry.draft = dr;
        const chip = (k, v) => `<span class="${v ? 'ok' : 'warn'}">${k}: ${esc(v || 'missing')}</span>`;
        result = `<div class="card"><h3>What the bot understood</h3><div class="tags">
          ${chip('Name', r.name)}${chip('Date', r.date && fmtDate(r.date))}${chip('Event', r.type)}${chip('Time', r.time && fmtTime(r.time))}
          ${chip('Venue', r.venue)}${chip('Hours', r.hours)}${r.guests ? chip('Guests', r.guests) : ''}${chip('Contact', r.contact)}
          ${r.date ? `<span class="${isFree(r.date) ? 'ok' : 'bad'}">${isFree(r.date) ? 'Date is open' : 'Date is booked'}</span>` : ''}</div></div>
          <div class="card"><h3>Drafted reply</h3><div class="out" id="draftOut">${esc(dr.text)}</div>
          <div class="row"><button class="btn go" data-act="copyDraft">Copy reply</button><button class="btn" data-act="saveInquiry">Save as inquiry &rarr; Booking Bot</button></div></div>`;
      }
      return head('inquiry', 'Paste a customer message from Messenger, SMS or email. The bot reads it and writes your reply.', langSel('inqLang', lang)) +
        `<label>Customer message<textarea id="inqText" placeholder="Hi! I'm Bea. Is Dec 12 available for my debut at Casa Real, 6pm? How much for 4 hours? 150 pax po. 0917 123 4567">${esc(ui.inquiry.text)}</textarea></label>
        <div class="row"><button class="btn amber" data-act="readInquiry">Read message</button><span class="muted small">Works with English and Taglish, and dates like "Dec 12", "12/12" or "Disyembre 12".</span></div>${result}`;
    },

    booking() {
      const b = ui.editing || { status: 'inquiry', pkg: S().packages[0].id, type: 'birthday' };
      const t0 = today();
      const list = [...D.bookings].sort((a, c) => (a.date < c.date ? -1 : 1));
      const up = list.filter((x) => x.date >= t0 && x.status !== 'cancelled');
      const old = list.filter((x) => !(x.date >= t0 && x.status !== 'cancelled')).reverse();
      const item = (x) => `<div class="item"><div class="date">${parseIso(x.date).toLocaleDateString('en-US', { month: 'short' }).toUpperCase()}<b>${parseIso(x.date).getDate()}</b></div>
        <div><h4>${esc(x.client)} · ${esc(x.type)} <span class="pill ${x.status}">${x.status}</span></h4>
        <p>${fmtDate(x.date)}${x.time ? ' · ' + fmtTime(x.time) : ''} · ${esc(x.venue || 'venue TBA')} · ${esc(pkgById(x.pkg).name)} · <b>${money(priceOf(x))}</b>${x.contact ? ' · ' + esc(x.contact) : ''}</p></div>
        <div class="acts"><select data-status="${x.id}" style="width:auto;min-height:32px;padding:4px 8px">${opts(STATUSES, x.status)}</select>
        <button class="btn small" data-act="confirmMsg" data-id="${x.id}">Message</button><button class="btn small" data-act="ics" data-id="${x.id}">.ics</button>
        <button class="btn small" data-act="edit" data-id="${x.id}">Edit</button><button class="btn small danger" data-act="del" data-id="${x.id}">Delete</button></div></div>`;
      const price = b.pkg ? priceOf(b) : 0;
      const clash = b.date && !isFree(b.date, b.id) && (b.status === 'confirmed' || b.status === 'paid');
      return head('booking', 'Add and track events. Prices, downpayments and date clashes are worked out for you.', `<button class="btn" data-act="exportCsv">Export CSV</button>`) +
        `<div class="card"><h3>${ui.editing && ui.editing.id ? 'Edit booking' : 'New booking'}</h3><div class="grid3" id="bkForm">
          <label>Client name<input data-f="client" value="${esc(b.client || '')}" placeholder="Bea Santos"></label>
          <label>Contact<input data-f="contact" value="${esc(b.contact || '')}" placeholder="0917 123 4567 / Messenger"></label>
          <label>Event<select data-f="type">${opts(EVENT_TYPES, b.type)}</select></label>
          <label>Date<input type="date" data-f="date" value="${esc(b.date || '')}"></label>
          <label>Start time<input type="time" data-f="time" value="${esc(b.time || '')}"></label>
          <label>Venue<input data-f="venue" value="${esc(b.venue || '')}" placeholder="Casa Real, Quezon City"></label>
          <label>Package<select data-f="pkg">${opts(S().packages.map((p) => [p.id, `${p.name} · ${p.hours} hrs · ${money(p.price)}`]), b.pkg)}</select></label>
          <label>Hours<input type="number" min="1" max="12" step="0.5" data-f="hours" value="${esc(b.hours || pkgById(b.pkg).hours)}"></label>
          <label>Status<select data-f="status">${opts(STATUSES, b.status)}</select></label>
          <label class="check"><input type="checkbox" data-f="travel"${b.travel ? ' checked' : ''}> Add travel fee (${money(S().travelFee)})</label>
          <label class="span2">Notes<input data-f="notes" value="${esc(b.notes || '')}" placeholder="Theme, custom frame text, parking…"></label>
        </div>
        <p id="bkQuote">${b.pkg ? `Total <b>${money(price)}</b> · Downpayment <b>${money(Math.round((price * S().deposit) / 100))}</b>` : ''}${b.date ? (clash ? ' · <span style="color:var(--bad)">⚠ Already booked that day</span>' : (isFree(b.date, b.id) ? ' · <span style="color:var(--ok)">Date is open</span>' : '')) : ''}</p>
        <div class="row"><button class="btn go" data-act="saveBooking">Save booking</button>${ui.editing ? '<button class="btn" data-act="cancelEdit">Clear form</button>' : ''}</div></div>
        <div class="card"><h3>Upcoming (${up.length})</h3><div class="list">${up.map(item).join('') || '<p class="muted">No upcoming events yet.</p>'}</div></div>
        ${old.length ? `<div class="card"><h3>Past &amp; cancelled (${old.length})</h3><div class="list">${old.slice(0, 20).map(item).join('')}</div></div>` : ''}`;
    },

    scheduler() {
      const base = ui.calMonth || today().slice(0, 7);
      const [y, m] = base.split('-').map(Number);
      const firstDay = new Date(y, m - 1, 1, 12);
      const start = addDays(iso(firstDay), -firstDay.getDay());
      const t0 = today();
      let cells = '';
      for (let i = 0; i < 42; i++) {
        const d = addDays(start, i);
        const inMonth = parseIso(d).getMonth() === m - 1;
        const evs = D.bookings.filter((b) => b.date === d && b.status !== 'cancelled');
        const ps = D.posts.filter((p) => p.date === d && p.status !== 'posted');
        const free = inMonth && d >= t0 && isFree(d) && [0, 5, 6].includes(parseIso(d).getDay());
        cells += `<div class="day${inMonth ? '' : ' out'}${d === t0 ? ' today' : ''}${free ? ' free' : ''}"><span class="n">${parseIso(d).getDate()}</span>
          ${evs.map((b) => `<span class="ev ${b.status === 'inquiry' ? 'inquiry' : ''}" title="${esc(b.client)}">${esc(b.client)}</span>`).join('')}
          ${ps.map((p) => `<span class="ev post">📣 ${fmtTime(p.time)}</span>`).join('')}</div>`;
      }
      const open = openDates(t0, 60, true);
      const label = firstDay.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      return head('scheduler', 'Your month at a glance: events, inquiries, planned posts and open weekend dates (green).',
        `<button class="btn small" data-act="calPrev">&larr;</button><b>${label}</b><button class="btn small" data-act="calNext">&rarr;</button>`) +
        `<div class="cal">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div class="dow">${d}</div>`).join('')}${cells}</div>
        <div class="card"><h3>Open weekend dates, next 60 days (${open.length})</h3><div class="tags">${open.map((d) => `<span class="ok">${fmtShort(d)} ${parseIso(d).toLocaleDateString('en-US', { weekday: 'short' })}</span>`).join('') || '<span class="bad">All booked!</span>'}</div>
        <div class="row"><button class="btn" data-act="copyOpen">Copy open dates</button><button class="btn amber" data-act="toMarketing">Ask Marketing Bot to post them</button></div></div>`;
    },

    followup() {
      const lang = ui.fuLang || S().lang;
      const list = tasks();
      return head('followup', 'Messages your clients should get today: follow-ups, downpayment reminders, event reminders and thank-yous.', langSel('fuLang', lang)) +
        (list.length ? `<div class="list">${list.map((t) => `<div class="card"><div class="p-head"><div><h2 style="font-size:16px">${esc(t.label)} · ${esc(t.b.client)}</h2><p>${fmtDate(t.b.date)} · ${esc(t.b.type)} · <span class="pill ${t.b.status}">${t.b.status}</span></p></div></div>
          <div class="out">${esc(MSG[t.kind](t.b, lang === 'tl'))}</div>
          <div class="row"><button class="btn go" data-act="copyTask" data-id="${t.id}">Copy message</button><button class="btn" data-act="ack" data-id="${t.id}">Sent ✓</button>
          ${t.markDone ? `<button class="btn" data-act="markDone" data-id="${t.b.id}">Mark event done</button>` : ''}
          ${t.kind === 'deposit' ? `<button class="btn" data-act="markPaid" data-id="${t.b.id}">Downpayment received</button>` : ''}</div></div>`).join('')}</div>`
          : '<p class="muted">Nothing to send right now. 🎉</p>');
    },

    marketing() {
      const m = ui.mkt;
      const done = D.bookings.filter((b) => b.status === 'done' || (active(b) && b.date < today()));
      const queue = [...D.posts].sort((a, c) => (a.date + a.time < c.date + c.time ? -1 : 1)).filter((p) => p.status !== 'posted' && p.date >= addDays(today(), -1));
      return head('marketing', 'Writes captions from your real packages, open dates and past events, then plans when to post.', `<button class="btn amber" data-act="planWeek">Plan my week</button>`) +
        `<div class="card"><div class="grid3">
          <label>Post type<select id="mkType">${opts([['promo', 'Promo: packages'], ['dates', 'Dates left'], ['recap', 'Event recap'], ['feature', 'How it works'], ['engage', 'Engagement question']], m.type)}</select></label>
          <label>Platform<select id="mkPlat">${opts([['facebook', 'Facebook'], ['instagram', 'Instagram'], ['tiktok', 'TikTok caption']], m.platform)}</select></label>
          <label${m.type === 'recap' ? '' : ' hidden'}>Event to feature<select id="mkBook">${opts([['', 'Any recent event']].concat(done.map((b) => [b.id, `${b.client} · ${b.type} · ${fmtShort(b.date)}`])), m.booking)}</select></label>
        </div><div class="row"><button class="btn go" data-act="writePosts">Write 3 captions</button><span class="muted small">Posting slots: ${slots().map(fmtTime).join(', ')} (change them in Bot Manager)</span></div></div>
        ${m.drafts.map((d, i) => `<div class="card"><h3>Caption ${i + 1}</h3><div class="out">${esc(d)}</div><div class="row"><button class="btn" data-act="copyPost" data-i="${i}">Copy</button><button class="btn go" data-act="schedPost" data-i="${i}">Schedule next slot</button></div></div>`).join('')}
        <div class="card"><h3>Post queue (${queue.length})</h3><div class="list">${queue.map((p) => `<div class="item"><div class="date">${fmtShort(p.date).toUpperCase()}<b style="font-size:14px">${fmtTime(p.time)}</b></div>
          <div><h4>${esc(p.platform)} · ${esc(p.type)}</h4><p>${esc(p.caption.split('\n')[0])}</p></div>
          <div class="acts"><button class="btn small" data-act="copyQueued" data-id="${p.id}">Copy</button><button class="btn small" data-act="posted" data-id="${p.id}">Posted ✓</button><button class="btn small danger" data-act="delPost" data-id="${p.id}">Delete</button></div></div>`).join('') || '<p class="muted">Nothing queued. Write captions or press "Plan my week".</p>'}</div></div>`;
    },

    manager() {
      const s = S();
      const t0 = today();
      const mon = t0.slice(0, 7);
      const monthB = D.bookings.filter((b) => b.date.startsWith(mon) && active(b));
      const pipe = D.bookings.filter((b) => b.status === 'inquiry' && b.date >= t0);
      const next = D.bookings.filter((b) => active(b) && b.date >= t0).sort((a, c) => (a.date < c.date ? -1 : 1))[0];
      const ch = checks();
      return head('manager', 'Runs every check, keeps the numbers and holds the settings all the bots use.', `<button class="btn go" data-act="runAll">Run all checks</button>`) +
        `<div class="grid3"><div class="card stat"><b>${money(monthB.reduce((a, b) => a + priceOf(b), 0))}</b><span>Booked this month (${monthB.length} event${monthB.length === 1 ? '' : 's'})</span></div>
        <div class="card stat"><b>${money(pipe.reduce((a, b) => a + priceOf(b), 0))}</b><span>In open inquiries (${pipe.length})</span></div>
        <div class="card stat"><b>${next ? fmtShort(next.date) : '—'}</b><span>${next ? `Next event: ${esc(next.client)}` : 'No upcoming events'}</span></div></div>
        <div class="card"><h3>Checks</h3><div class="tags" style="display:grid;gap:6px">${ch.map((c) => `<span class="${c.ok ? 'ok' : 'warn'}" style="white-space:normal">${c.ok ? '✓' : '!'} ${esc(c.text)}</span>`).join('')}</div></div>
        <div class="card"><h3>Business settings</h3><div class="grid3" id="setForm">
          <label>Business name<input data-s="business" value="${esc(s.business)}"></label>
          <label>City (for hashtags)<input data-s="city" value="${esc(s.city)}"></label>
          <label>Facebook page / link<input data-s="page" value="${esc(s.page)}" placeholder="facebook.com/yourpage"></label>
          <label>Currency<input data-s="currency" value="${esc(s.currency)}" maxlength="4"></label>
          <label>Downpayment %<input type="number" min="0" max="100" data-s="deposit" value="${esc(s.deposit)}"></label>
          <label>Extra hour rate<input type="number" min="0" data-s="extraHour" value="${esc(s.extraHour)}"></label>
          <label>Travel fee<input type="number" min="0" data-s="travelFee" value="${esc(s.travelFee)}"></label>
          <label>Events per day<input type="number" min="1" max="10" data-s="perDay" value="${esc(s.perDay)}"></label>
          <label>Reply language<select data-s="lang">${opts([['en', 'English'], ['tl', 'Taglish']], s.lang)}</select></label>
          <label>Posting slots (24h)<input data-s="slots" value="${esc(s.slots)}"></label>
          <label class="span2">Hashtags<input data-s="hashtags" value="${esc(s.hashtags)}"></label>
        </div></div>
        <div class="card"><h3>Packages</h3><div class="list">${s.packages.map((p, i) => `<div class="grid3" style="grid-template-columns:1.2fr .5fr .7fr 2fr auto;align-items:end">
          <label>Name<input data-p="${i}" data-pf="name" value="${esc(p.name)}"></label><label>Hours<input type="number" min="1" data-p="${i}" data-pf="hours" value="${esc(p.hours)}"></label>
          <label>Price<input type="number" min="0" data-p="${i}" data-pf="price" value="${esc(p.price)}"></label><label>Includes<input data-p="${i}" data-pf="includes" value="${esc(p.includes)}"></label>
          <button class="btn small danger" data-act="delPkg" data-i="${i}"${s.packages.length < 2 ? ' disabled' : ''}>Remove</button></div>`).join('')}</div>
          <div class="row"><button class="btn" data-act="addPkg">Add package</button></div></div>
        <div class="card"><h3>Google Sheet sync</h3>
          <p class="muted small">Keeps every booking in a "Bookings" tab of your Google spreadsheet, both ways: bookings made here appear in the sheet, and changes you type in the sheet come back here. Phones and tablets that sync to the same sheet share the same bookings. Uses the sharing server from server/Code.gs (run <b>setupBookings</b> once, then deploy a new version).</p>
          <div class="grid3">
            <label class="span2">Server address (ends in /exec)<input data-s="syncUrl" value="${esc(s.syncUrl)}" placeholder="${esc(syncCfg().url || 'https://script.google.com/macros/s/…/exec')}"></label>
            <label>Booth key<input type="password" data-s="syncKey" value="${esc(s.syncKey)}" placeholder="${syncCfg().key && !s.syncKey ? 'using the booth\'s key' : ''}" autocomplete="off"></label>
            <label class="check span3"><input type="checkbox" data-s="autoSync"${s.autoSync ? ' checked' : ''}> Sync automatically (after every change and every 2 minutes)</label>
          </div>
          <p class="small ${sync.err ? '' : 'muted'}" style="${sync.err ? 'color:var(--bad)' : ''}">${sync.err ? '⚠ ' + esc(sync.err) : D.sync.at ? `Last synced ${ago(D.sync.at)} · ${D.bookings.length} bookings` : syncReady() ? 'Not synced yet.' : 'Not set up.'}</p>
          <div class="row"><button class="btn go" data-act="syncNow">Sync now</button>${D.sync.url ? `<a class="btn" href="${esc(D.sync.url)}" target="_blank" rel="noopener">Open the spreadsheet ↗</a>` : ''}</div></div>
        <div class="card"><h3>Backup</h3><p class="muted small">Without Google Sheet sync, bookings live on this device only. A backup file also keeps your posts and settings.</p>
          <div class="row"><button class="btn" data-act="exportJson">Export backup</button><button class="btn" data-act="importJson">Import backup</button><button class="btn" data-act="exportCsv">Export bookings CSV</button>
          ${D.bookings.length ? '' : '<button class="btn amber" data-act="sample">Load sample data</button>'}<button class="btn danger" data-act="wipe">Erase everything</button></div></div>`;
    },
  };

  function open(k) {
    current = current === k ? '' : k;
    $$('.node').forEach((n) => n.setAttribute('aria-pressed', String(n.dataset.bot === current)));
    render();
    if (current) $('#panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function render() {
    $('#panel').innerHTML = current ? `<div class="panel">${PANELS[current]()}</div>` : '';
    renderNodes();
  }

  /* Live numbers on each bot card + the manager status line. */
  function renderNodes() {
    const t0 = today();
    const up = D.bookings.filter((b) => active(b) && b.date >= t0).length;
    const inq = D.bookings.filter((b) => b.status === 'inquiry' && b.date >= t0).length;
    const open = openDates(t0, 60, true).length;
    const q = D.posts.filter((p) => p.status !== 'posted' && p.date >= t0).length;
    const tk = tasks().length;
    const bad = checks().filter((c) => !c.ok).length;
    const set = (id, html) => ($('#tag-' + id).innerHTML = html);
    set('inquiry', `<span>paste a message</span><span>${S().lang === 'tl' ? 'Taglish' : 'English'}</span>`);
    set('booking', `<span class="ok">${up} upcoming</span><span class="${inq ? 'warn' : ''}">${inq} inquir${inq === 1 ? 'y' : 'ies'}</span>`);
    set('scheduler', `<span class="ok">${open} open weekend${open === 1 ? '' : 's'}</span><span>60 days</span>`);
    set('followup', `<span class="${tk ? 'warn' : 'ok'}">${tk ? tk + ' to send' : 'all caught up'}</span>`);
    set('marketing', slots().slice(0, 3).map((t) => `<span class="ok">${fmtTime(t)}</span>`).join('') + `<span>${q} queued</span>`);
    set('manager', `<span class="${bad ? 'warn' : 'ok'}">${bad ? bad + ' need you' : 'all checks passed'}</span>` +
      (syncReady() ? `<span class="${sync.err ? 'bad' : 'ok'}">${sync.err ? 'sheet sync failed' : D.sync.at ? 'sheet ' + ago(D.sync.at) : 'sheet not synced'}</span>` : '<span>no sheet yet</span>'));
    $('#bizName').textContent = S().business;
    $('#statusText').textContent = bad ? `${bad} thing${bad > 1 ? 's' : ''} need${bad > 1 ? '' : 's'} your attention. Open the Bot Manager.` : 'All checks passed. Bots are on duty.';
    $('#statusDot').classList.toggle('warn', !!bad);
    $('#statusDot span').textContent = bad ? 'Needs you' : 'Online';
  }

  function runAll() {
    const t0 = today();
    const tk = tasks();
    const open = openDates(t0, 60, true);
    const inq = D.bookings.filter((b) => b.status === 'inquiry' && b.date >= t0);
    const week = D.bookings.filter((b) => active(b) && b.date >= t0 && b.date <= addDays(t0, 6));
    log('inquiry', inq.length ? `${inq.length} open inquir${inq.length > 1 ? 'ies' : 'y'} worth ${money(inq.reduce((a, b) => a + priceOf(b), 0))}.` : 'No open inquiries. Paste a new message any time.');
    log('scheduler', `${week.length} event${week.length === 1 ? '' : 's'} this week · ${open.length} open weekend dates in the next 60 days.`);
    log('followup', tk.length ? `${tk.length} message${tk.length > 1 ? 's' : ''} ready to send: ${[...new Set(tk.map((t) => t.label))].slice(0, 3).join(', ')}.` : 'All clients are up to date.');
    const q = D.posts.filter((p) => p.status !== 'posted' && p.date >= t0 && p.date <= addDays(t0, 6)).length;
    log('marketing', q ? `${q} post${q > 1 ? 's' : ''} planned this week. Next slot ${fmtTime(nextSlot().time)} on ${fmtShort(nextSlot().date)}.` : 'No posts planned this week. Press "Plan my week".');
    const bad = checks().filter((c) => !c.ok);
    log('manager', bad.length ? `${bad.length} check${bad.length > 1 ? 's' : ''} need you: ${bad[0].text}` : 'All checks passed. Ready for bookings.');
    renderNodes();
    if (current) render();
  }

  /* ---------- actions ---------- */
  function readForm() {
    const b = Object.assign({}, ui.editing || {});
    $$('#bkForm [data-f]').forEach((el) => (b[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value.trim()));
    b.hours = Number(b.hours) || pkgById(b.pkg).hours;
    return b;
  }
  function samples() {
    const t0 = today();
    const mk = (n, client, type, venue, pkg, status, time, contact) => ({ id: uid(), created: Date.now() - 3 * 86400000, client, type, venue, pkg, status, time, contact, date: addDays(t0, n), hours: pkgById(pkg).hours, travel: false, notes: '', updated: Date.now() });
    D.bookings.push(
      mk(-5, 'Carla Reyes', 'wedding', 'Glass Garden, Pasig', 'premium', 'paid', '16:00', '0917 555 0101'),
      mk(2, 'Mark Villanueva', 'corporate', 'BGC Office, Taguig', 'standard', 'confirmed', '18:00', '0918 555 0102'),
      mk(9, 'Bea Santos', 'debut', 'Casa Real, Quezon City', 'premium', 'paid', '18:00', '0919 555 0103'),
      mk(16, 'Jun dela Cruz', 'birthday', 'Clubhouse, Antipolo', 'basic', 'inquiry', '14:00', ''),
      mk(23, 'Ana & Paolo', 'wedding', 'Tagaytay Highlands', 'premium', 'confirmed', '15:00', '0920 555 0104'),
    );
    save();
    log('booking', 'Loaded 5 sample bookings so you can try the bots.');
  }

  const ACT = {
    readInquiry() {
      ui.inquiry.text = $('#inqText').value;
      if (!ui.inquiry.text.trim()) return toast('Paste a customer message first.');
      const r = parseInquiry(ui.inquiry.text);
      log('inquiry', `Read a message${r.name ? ' from ' + r.name : ''}${r.date ? ' for ' + fmtShort(r.date) : ''}${r.date ? (isFree(r.date) ? ' (open)' : ' (booked)') : ''}. Reply drafted.`);
      render();
    },
    copyDraft() { copy($('#draftOut').textContent); },
    saveInquiry() {
      const r = parseInquiry(ui.inquiry.text);
      const p = recommend(r);
      ui.editing = { client: r.name || '', contact: r.contact || '', type: r.type || 'other', date: r.date || '', time: r.time || '', venue: r.venue || '', pkg: p.id, hours: Math.max(r.hours || 0, p.hours), status: 'inquiry', notes: r.guests ? r.guests + ' guests' : '' };
      current = '';
      open('booking');
    },
    saveBooking() {
      const b = readForm();
      if (!b.client) return toast('Add the client name.');
      if (!b.date) return toast('Pick the event date.');
      if ((b.status === 'confirmed' || b.status === 'paid') && !isFree(b.date, b.id) && !confirm(`${fmtDate(b.date)} is already booked. Save anyway?`)) return;
      const isNew = !b.id;
      touch(b);
      if (isNew) { b.id = uid(); b.created = Date.now(); D.bookings.push(b); }
      else D.bookings[D.bookings.findIndex((x) => x.id === b.id)] = b;
      ui.editing = null;
      save();
      log('booking', `${isNew ? 'Booked' : 'Updated'} ${b.client}'s ${b.type} on ${fmtShort(b.date)} (${b.status}, ${money(priceOf(b))}).`);
      render();
    },
    cancelEdit() { ui.editing = null; render(); },
    edit(id) { ui.editing = Object.assign({}, D.bookings.find((b) => b.id === id)); render(); $('#bkForm').scrollIntoView({ behavior: 'smooth', block: 'center' }); },
    del(id) {
      const b = D.bookings.find((x) => x.id === id);
      if (!b || !confirm(`Delete ${b.client}'s booking on ${fmtDate(b.date)}?`)) return;
      D.bookings = D.bookings.filter((x) => x.id !== id);
      D.deleted.push(touch(Object.assign({}, b, { deleted: true })));
      save();
      log('booking', `Deleted ${b.client}'s booking.`);
      render();
    },
    confirmMsg(id) { const b = D.bookings.find((x) => x.id === id); copy(MSG.confirm(b, S().lang === 'tl')); log('booking', `Copied the confirmation for ${b.client}.`); },
    ics(id) { const b = D.bookings.find((x) => x.id === id); download(`${b.date}-${b.client.replace(/\W+/g, '-')}.ics`, ics(b), 'text/calendar'); },
    exportCsv() {
      const cols = ['date', 'time', 'client', 'contact', 'type', 'venue', 'package', 'hours', 'status', 'total', 'downpayment', 'notes'];
      const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
      const rows = D.bookings.map((b) => [b.date, b.time, b.client, b.contact, b.type, b.venue, pkgById(b.pkg).name, b.hours, b.status, priceOf(b), depositOf(b), b.notes].map(q).join(','));
      download(`bookings-${today()}.csv`, [cols.join(',')].concat(rows).join('\n'), 'text/csv');
    },
    calPrev() { const [y, m] = (ui.calMonth || today().slice(0, 7)).split('-').map(Number); const d = new Date(y, m - 2, 1); ui.calMonth = `${d.getFullYear()}-${p2(d.getMonth() + 1)}`; render(); },
    calNext() { const [y, m] = (ui.calMonth || today().slice(0, 7)).split('-').map(Number); const d = new Date(y, m, 1); ui.calMonth = `${d.getFullYear()}-${p2(d.getMonth() + 1)}`; render(); },
    copyOpen() { copy('Open dates: ' + openDates(today(), 60, true).map(fmtShort).join(', ')); },
    toMarketing() { ui.mkt.type = 'dates'; ui.mkt.drafts = [0, 1, 2].map(() => caption('dates', ui.mkt.platform)); current = ''; open('marketing'); log('marketing', 'Wrote 3 "dates left" captions from the Scheduler Bot\'s open dates.'); },
    copyTask(id) { const t = tasks().find((x) => x.id === id); if (t) copy(MSG[t.kind](t.b, (ui.fuLang || S().lang) === 'tl')); },
    ack(id) { const t = tasks().find((x) => x.id === id); D.acks.push(id); save(); if (t) log('followup', `Sent "${t.label}" to ${t.b.client}.`); render(); },
    markDone(id) { const b = D.bookings.find((x) => x.id === id); b.status = 'done'; touch(b); save(); log('followup', `Closed ${b.client}'s event as done.`); render(); },
    markPaid(id) { const b = D.bookings.find((x) => x.id === id); b.status = 'paid'; touch(b); save(); log('booking', `${b.client} paid the ${money(depositOf(b))} downpayment. Date locked.`); render(); },
    writePosts() {
      const m = ui.mkt;
      const b = m.type === 'recap' ? (D.bookings.find((x) => x.id === m.booking) || D.bookings.filter((x) => x.status === 'done').sort((a, c) => (a.date > c.date ? -1 : 1))[0]) : null;
      const seen = new Set();
      m.drafts = [];
      for (let i = 0; i < 12 && m.drafts.length < 3; i++) { const c = caption(m.type, m.platform, b); if (!seen.has(c)) { seen.add(c); m.drafts.push(c); } }
      log('marketing', `Wrote ${m.drafts.length} ${m.platform} caption${m.drafts.length > 1 ? 's' : ''} (${m.type}).`);
      render();
    },
    copyPost(_, i) { copy(ui.mkt.drafts[i]); },
    schedPost(_, i) {
      const sl = nextSlot();
      D.posts.push({ id: uid(), date: sl.date, time: sl.time, platform: ui.mkt.platform, type: ui.mkt.type, caption: ui.mkt.drafts[i], status: 'planned' });
      ui.mkt.drafts.splice(i, 1);
      save();
      log('marketing', `Scheduled a ${ui.mkt.platform} post for ${fmtShort(sl.date)} at ${fmtTime(sl.time)}.`);
      render();
    },
    planWeek() {
      const plan = ['promo', 'feature', 'dates', 'engage', 'recap', 'promo', 'feature'];
      const plats = ['facebook', 'instagram', 'tiktok'];
      const sl = slots().length ? slots() : ['18:00'];
      const recent = D.bookings.filter((x) => x.status === 'done').sort((a, c) => (a.date > c.date ? -1 : 1))[0];
      let n = 0;
      for (let i = 0; i < 7; i++) {
        const d = addDays(today(), i + 1);
        if (D.posts.some((p) => p.date === d && p.status !== 'posted')) continue;
        let type = plan[i];
        if (type === 'recap' && !recent) type = 'promo';
        const platform = plats[i % plats.length];
        D.posts.push({ id: uid(), date: d, time: sl[i % sl.length], platform, type, caption: caption(type, platform, recent), status: 'planned' });
        n++;
      }
      save();
      log('marketing', n ? `Planned ${n} posts for the next 7 days across Facebook, Instagram and TikTok.` : 'This week is already planned.');
      render();
    },
    copyQueued(id) { copy(D.posts.find((p) => p.id === id).caption); },
    posted(id) { const p = D.posts.find((x) => x.id === id); p.status = 'posted'; save(); log('marketing', `Marked the ${p.platform} post for ${fmtShort(p.date)} as posted.`); render(); },
    delPost(id) { D.posts = D.posts.filter((x) => x.id !== id); save(); render(); },
    addPkg() { S().packages.push({ id: uid(), name: 'New package', hours: 3, price: 8000, includes: 'unlimited receipt prints' }); save(); render(); },
    delPkg(_, i) {
      const p = S().packages[i];
      if (D.bookings.some((b) => b.pkg === p.id) && !confirm(`Some bookings use "${p.name}". Remove it anyway?`)) return;
      S().packages.splice(i, 1);
      save();
      render();
    },
    exportJson() { download(`booth-bots-backup-${today()}.json`, JSON.stringify(D, null, 2), 'application/json'); log('manager', 'Exported a backup.'); },
    importJson() { $('#importFile').click(); },
    sample() { samples(); render(); },
    wipe() {
      if (!confirm('Erase all bookings, posts and settings on this device? Export a backup first if you need it.')) return;
      try { localStorage.removeItem(STORE); } catch (e) { /* ignore */ }
      D = load();
      log('manager', 'Started fresh.');
      render();
    },
    runAll() { runAll(); },
    syncNow() { syncNow(true); },
  };

  /* ---------- wiring ---------- */
  function init() {
    $$('.node').forEach((n) => (n.onclick = () => open(n.dataset.bot)));
    $('#runAll').onclick = runAll;
    const panel = $('#panel');
    panel.addEventListener('click', (e) => {
      const el = e.target.closest('[data-act]');
      if (!el) return;
      const fn = ACT[el.dataset.act];
      if (fn) fn(el.dataset.id, Number(el.dataset.i));
    });
    panel.addEventListener('input', (e) => {
      const el = e.target;
      if (el.closest('#bkForm')) {
        ui.editing = readForm();
        const b = ui.editing;
        const price = priceOf(b);
        const clash = b.date && !isFree(b.date, b.id) && (b.status === 'confirmed' || b.status === 'paid');
        $('#bkQuote').innerHTML = `Total <b>${money(price)}</b> · Downpayment <b>${money(Math.round((price * S().deposit) / 100))}</b>` +
          (b.date ? (clash ? ' · <span style="color:var(--bad)">⚠ Already booked that day</span>' : isFree(b.date, b.id) ? ' · <span style="color:var(--ok)">Date is open</span>' : '') : '');
      }
      if (el.id === 'inqText') ui.inquiry.text = el.value;
    });
    panel.addEventListener('change', (e) => {
      const el = e.target;
      if (el.dataset.status) {
        const b = D.bookings.find((x) => x.id === el.dataset.status);
        b.status = el.value;
        touch(b);
        save();
        log('booking', `${b.client}'s ${b.type} on ${fmtShort(b.date)} is now ${b.status}.`);
        render();
      } else if (el.dataset.s) {
        S()[el.dataset.s] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value.trim();
        save();
        renderNodes();
        if (el.dataset.s === 'syncUrl' || el.dataset.s === 'syncKey' || el.dataset.s === 'autoSync') { D.sync.sig = ''; if (syncReady() && S().autoSync) syncNow(false); }
      } else if (el.dataset.p != null && el.dataset.pf) {
        const p = S().packages[Number(el.dataset.p)];
        p[el.dataset.pf] = el.type === 'number' ? Number(el.value) : el.value;
        save();
      } else if (el.id === 'inqLang') { ui.inquiry.lang = el.value; render(); }
      else if (el.id === 'fuLang') { ui.fuLang = el.value; render(); }
      else if (el.id === 'mkType') { ui.mkt.type = el.value; render(); }
      else if (el.id === 'mkPlat') { ui.mkt.platform = el.value; }
      else if (el.id === 'mkBook') { ui.mkt.booking = el.value; }
      else if (el.dataset.f === 'pkg' && ui.editing) { ui.editing.hours = pkgById(el.value).hours; render(); }
    });
    $('#importFile').onchange = async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        const d = JSON.parse(await f.text());
        if (!d || !Array.isArray(d.bookings)) throw new Error('bad');
        localStorage.setItem(STORE, JSON.stringify(d));
        D = load();
        D.bookings.forEach(touch);
        save();
        log('manager', `Imported a backup with ${D.bookings.length} bookings.`);
        render();
      } catch (err) { toast('That file is not a Booth Bots backup.'); }
    };
    const clock = () => {
      let tz = '';
      try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { /* ignore */ }
      $('#clock').textContent = `${tz} · ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    };
    clock();
    setInterval(clock, 30000);
    renderLog();
    render();
    if (!D.log.length) runAll();
    const autoSync = () => { if (S().autoSync && syncReady() && document.visibilityState === 'visible') syncNow(false); };
    autoSync();
    setInterval(autoSync, 120000);
    window.addEventListener('online', autoSync);
    document.addEventListener('visibilitychange', autoSync);
  }
  init();
})();
