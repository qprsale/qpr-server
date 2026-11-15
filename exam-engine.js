'use strict';
/* =====================================================================
   ONLINE TEST ENGINE - shared by the desktop app (exam-room mode) and the company server.
   Plain Node.js, no packages needed.

   The answer key never reaches this engine: it receives the questions only, collects the
   candidates' answers, enforces the time of each part, and hands the answers back to the
   desktop app, which marks them.

   Candidate API (token = "Authorization: Bearer <token>")
     POST /api/join     { code, name, iga }            -> { token }
     GET  /api/me                                      -> the candidate's exam, parts, answers, time
     POST /api/start    { part }
     POST /api/answer   { part, qid, value }
     POST /api/upload   { part, qid, name, mime, b64 }
     POST /api/unupload { part, qid, index }
     POST /api/submit   { part }
     POST /api/event    { type }                       (left the page / came back)
     GET  /api/doc/<id>?t=<token>                      (reference document, for example charts)
   Admin API ("X-Admin-Key: <key>")
     GET  /admin/ping
     POST /admin/sessions               <exam package> -> { id, code }
     GET  /admin/sessions
     GET  /admin/sessions/<id>          progress of every candidate
     GET  /admin/sessions/<id>/results  every answer and photo
     POST /admin/sessions/<id>/extend   { token, minutes }
     POST /admin/sessions/<id>/close
     DELETE /admin/sessions/<id>
   ===================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GRACE_MS = 15 * 1000;              /* answers that were on their way when the time ran out */
const MAX_BODY = 12 * 1024 * 1024;       /* one photo of working, comfortably */
const MAX_PHOTO = 8 * 1024 * 1024;
const MAX_PHOTOS_PER_Q = 6;

const rid = (n = 16) => crypto.randomBytes(n).toString('hex');
const now = () => Date.now();
const codeChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.randomBytes(6), b => codeChars[b % codeChars.length]).join('');
const cleanIga = s => String(s || '').trim().toUpperCase().replace(/\s+/g, '');

function createEngine(opt) {
  const dataDir = opt.dataDir;
  const adminKey = String(opt.adminKey || '');
  const pagePath = opt.pagePath || path.join(__dirname, 'test-page.html');
  const publicDir = opt.publicDir || path.join(__dirname, 'public');
  const log = opt.log || (() => {});
  if (!adminKey || adminKey.length < 12) throw new Error('An admin key of at least 12 characters is required.');
  fs.mkdirSync(dataDir, { recursive: true });

  /* ---------- sessions, kept in memory and saved as one JSON file each ---------- */
  const sessions = new Map();
  for (const f of fs.readdirSync(dataDir)) {
    if (!/^s_[0-9a-f]+\.json$/.test(f)) continue;
    try { const s = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8')); sessions.set(s.id, s); } catch (e) { log('Could not read ' + f + ': ' + e.message); }
  }
  const dirty = new Set();
  const save = s => { dirty.add(s.id); };
  const flush = () => {
    for (const id of dirty) {
      const s = sessions.get(id); dirty.delete(id);
      if (!s) continue;
      const f = path.join(dataDir, id + '.json'), tmp = f + '.tmp';
      try { fs.writeFileSync(tmp, JSON.stringify(s)); fs.renameSync(tmp, f); } catch (e) { log('Save failed: ' + e.message); }
    }
  };
  const timer = setInterval(flush, 1500); if (timer.unref) timer.unref();

  /* ---------- helpers ---------- */
  const byToken = tok => { for (const s of sessions.values()) { const c = s.candidates[tok]; if (c) return { s, c }; } return null; };
  const partOf = (s, c, k) => (s.exam.sets[c.set] || s.exam.sets[Object.keys(s.exam.sets)[0]]).parts[k];
  const startAt = s => Number(s.exam.startAt) || 0;
  /* fixed times: part k closes at the start time + the minutes of parts 0..k (+ extra time given to this candidate) */
  const windowEnd = (s, c, k) => startAt(s) && s.exam.fixed ? startAt(s) + s.exam.parts.slice(0, k + 1).reduce((m, p) => m + p.minutes, 0) * 60000 + (c ? (c.extra[k] || 0) * 60000 : 0) : null;
  const deadline = (s, c, k) => {
    if (!c.started[k]) return null;
    const own = c.started[k] + (s.exam.parts[k].minutes + (c.extra[k] || 0)) * 60000, w = windowEnd(s, c, k);
    return w ? Math.min(own, w) : own;
  };
  const isDone = (s, c, k) => !!c.submitted[k] || (c.started[k] && now() > deadline(s, c, k) + GRACE_MS);
  const stateOf = (s, c, k) => c.submitted[k] ? (c.auto[k] ? 'auto-submitted' : 'submitted') : !c.started[k] ? (windowEnd(s, c, k) && now() > windowEnd(s, c, k) ? 'missed' : 'not started') : now() > deadline(s, c, k) ? 'time up' : 'in progress';
  /* a part that ran out of time counts as submitted, at its deadline */
  const settle = (s, c) => { s.exam.parts.forEach((p, k) => { if (!c.submitted[k] && c.started[k] && now() > deadline(s, c, k) + GRACE_MS) { c.submitted[k] = deadline(s, c, k); c.auto[k] = true; save(s); } }); };
  /* the invigilator's list, answers marked "auto-submitted" when the time ran out */
  /* the same candidate always sees the same order */
  const seeded = (seed, arr) => {
    const h = crypto.createHash('sha256').update(seed).digest(); let i = 0;
    const rnd = () => { const v = h[i % h.length] / 256; i++; return v; };
    const a = arr.slice(); for (let j = a.length - 1; j > 0; j--) { const k = Math.floor(rnd() * (j + 1)); [a[j], a[k]] = [a[k], a[j]]; } return a;
  };
  const viewPart = (s, c, k) => {
    const p = partOf(s, c, k); if (!p) return [];
    let qs = p.questions.map(q => ({ qid: q.qid, no: q.no, type: q.type, text: q.text, rows: q.rows || null, marks: q.marks || null, head: q.head || null,
      options: q.type === 'obj' ? q.options.map((t, i) => ({ i, t })) : null }));
    if (s.exam.shuffleOptions) qs.forEach(q => { if (q.options) q.options = seeded(c.token + q.qid, q.options); });
    /* shuffle within each subject section, the sections keep their order */
    if (s.exam.shuffleQuestions) { const groups = []; qs.forEach(q => { const g = groups[groups.length - 1]; if (g && g.head === (q.head || '')) g.list.push(q); else groups.push({ head: q.head || '', list: [q] }); }); qs = [].concat(...groups.map((g, i) => seeded(c.token + 'q' + k + '_' + i, g.list))); }
    return qs;
  };

  /* ---------- HTTP plumbing ---------- */
  const send = (res, code, obj, headers) => {
    const body = typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj);
    res.writeHead(code, Object.assign({ 'Content-Type': typeof obj === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }, headers || {}));
    res.end(body);
  };
  const fail = (res, code, msg) => send(res, code, { error: msg });
  const readBody = req => new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', d => { n += d.length; if (n > MAX_BODY) { reject(Object.assign(new Error('Too large'), { code: 413 })); req.destroy(); } else chunks.push(d); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(Object.assign(new Error('Bad JSON'), { code: 400 })); } });
    req.on('error', reject);
  });
  const isAdmin = req => {
    const k = String(req.headers['x-admin-key'] || '');
    return k.length === adminKey.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(adminKey));
  };
  let page = null;
  const testPage = () => { try { return page || (page = fs.readFileSync(pagePath, 'utf8')); } catch (e) { return '<h1>Test page missing</h1>'; } };

  /* static files under PUBLIC_DIR: app installers + latest.yml in /updates/, data pushes in /data/.
     Streamed so a large installer does not sit in memory. Path-traversal is blocked. */
  const STATIC_MIME = { '.yml': 'text/yaml; charset=utf-8', '.yaml': 'text/yaml; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.exe': 'application/octet-stream', '.blockmap': 'application/octet-stream', '.zip': 'application/zip', '.txt': 'text/plain; charset=utf-8' };
  function serveStatic(res, pathname) {
    let rel; try { rel = decodeURIComponent(pathname).replace(/^\/+/, ''); } catch (e) { return fail(res, 400, 'Bad path'); }
    const full = path.normalize(path.join(publicDir, rel));
    if (full !== publicDir && !full.startsWith(publicDir + path.sep)) return fail(res, 403, 'Forbidden');
    fs.stat(full, (err, st) => {
      if (err || !st.isFile()) return fail(res, 404, 'Not found');
      res.writeHead(200, { 'Content-Type': STATIC_MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size,
        'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' });
      const rs = fs.createReadStream(full); rs.on('error', () => { try { res.destroy(); } catch (e) {} }); rs.pipe(res);
    });
  }

  /* ---------- requests ---------- */
  async function handle(req, res) {
    const u = new URL(req.url, 'http://x'), p = u.pathname, m = req.method;
    if (m === 'OPTIONS') return send(res, 204, '');
    try {
      if (m === 'GET' && (p === '/' || p === '/index.html')) return send(res, 200, testPage(), { 'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'" });
      if (m === 'GET' && p === '/favicon.ico') return send(res, 204, '');

      /* ----- static files for app auto-update (/updates/) and data push (/data/) ----- */
      if (m === 'GET' && (p.startsWith('/updates/') || p.startsWith('/data/'))) return serveStatic(res, p);

      /* ----- candidates ----- */
      if (p.startsWith('/api/')) {
        if (m === 'POST' && p === '/api/join') {
          const b = await readBody(req), code = String(b.code || '').trim().toUpperCase(), name = String(b.name || '').trim().slice(0, 80), iga = cleanIga(b.iga).slice(0, 30);
          if (!name || !iga) return fail(res, 400, 'Please enter your name and IGA.');
          const s = [...sessions.values()].find(x => x.code === code);
          if (!s) return fail(res, 404, 'That session code is not valid. Check it with the invigilator.');
          if (s.closed) return fail(res, 403, 'This test session has been closed.');
          /* the same IGA comes back to the same paper (for example after the battery ran out) */
          let c = Object.values(s.candidates).find(x => x.iga === iga);
          if (!c) {
            const sets = Object.keys(s.exam.sets), n = Object.keys(s.candidates).length;
            c = { token: rid(), anon: 'C-' + String(1001 + n), name, iga, set: sets[n % sets.length], joined: now(), started: [], submitted: [], auto: [], extra: [], answers: {}, uploads: {}, events: [] };
            s.candidates[c.token] = c; save(s); log(`${iga} joined ${s.exam.title} (Set ${c.set})`);
          } else c.events.push({ t: now(), type: 'rejoined' });
          return send(res, 200, { token: c.token });
        }
        const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || u.searchParams.get('t') || '';
        const hit = tok && byToken(tok);
        if (!hit) return fail(res, 401, 'Please join the test again.');
        const { s, c } = hit; settle(s, c);
        if (m === 'GET' && p === '/api/me') {
          const parts = s.exam.parts.map((pt, k) => ({ name: pt.name, minutes: pt.minutes + (c.extra[k] || 0), kind: pt.kind, instructions: pt.instructions || [],
            state: stateOf(s, c, k), deadline: deadline(s, c, k), submitted: !!c.submitted[k], auto: !!c.auto[k], windowEnd: windowEnd(s, c, k),
            docs: (s.exam.docs || []).filter(d => d.part == null || d.part === k).map(d => ({ id: d.id, name: d.name })),
            questions: c.started[k] && !c.submitted[k] ? viewPart(s, c, k) : null }));
          return send(res, 200, { code: s.code, startAt: startAt(s) || null, fixed: !!s.exam.fixed, title: s.exam.title, org: s.exam.org || '', set: Object.keys(s.exam.sets).length > 1 ? c.set : '', name: c.name, iga: c.iga, now: now(),
            closed: !!s.closed, parts, answers: c.answers, uploads: Object.fromEntries(Object.entries(c.uploads).map(([q, l]) => [q, l.map(x => ({ name: x.name }))])) });
        }
        if (m === 'GET' && p.startsWith('/api/doc/')) {
          const d = (s.exam.docs || []).find(x => x.id === p.slice(9));
          if (!d) return fail(res, 404, 'Not found');
          if (d.part != null && !c.started[d.part]) return fail(res, 403, 'Available when that part starts.');
          return send(res, 200, Buffer.from(d.b64, 'base64'), { 'Content-Type': d.mime || 'application/octet-stream', 'Content-Disposition': `inline; filename="${encodeURIComponent(d.name)}"` });
        }
        const b = m === 'POST' ? await readBody(req) : {};
        const k = Number(b.part);
        const partOk = Number.isInteger(k) && k >= 0 && k < s.exam.parts.length;
        if (m === 'POST' && p === '/api/start') {
          if (!partOk) return fail(res, 400, 'Unknown part.');
          if (s.closed) return fail(res, 403, 'This test session has been closed.');
          for (let j = 0; j < k; j++) if (!c.submitted[j] && !(windowEnd(s, c, j) && now() > windowEnd(s, c, j))) return fail(res, 409, 'Finish the earlier part first.');
          if (startAt(s) && now() < startAt(s)) return fail(res, 409, 'The test has not started yet.');
          if (!c.started[k] && windowEnd(s, c, k) && now() >= windowEnd(s, c, k)) return fail(res, 409, 'The time for this part is over.');
          if (!c.started[k]) { c.started[k] = now(); save(s); log(`${c.iga} started ${s.exam.parts[k].name}`); }
          return send(res, 200, { ok: true });
        }
        const writable = () => partOk && c.started[k] && !c.submitted[k] && now() <= deadline(s, c, k) + GRACE_MS && !s.closed;
        /* one answer, or many in one request (answers saved while offline, and the answers sent with Submit) */
        const putAnswer = (qid, value) => {
          const q = partOf(s, c, k).questions.find(x => x.qid === qid); if (!q) return false;
          let v = value;
          if (q.type === 'obj') v = v === null || v === '' ? null : Number.isInteger(v) && v >= 0 && v < q.options.length ? v : null;
          else if (v && typeof v === 'object') v = Object.fromEntries(Object.entries(v).slice(0, 20).map(([kk, vv]) => [String(kk).slice(0, 20), String(vv || '').slice(0, 20000)]));
          else v = String(v || '').slice(0, 20000);
          c.answers[qid] = v; return true;
        };
        if (m === 'POST' && p === '/api/answer') {
          if (!writable()) return fail(res, 409, 'The time for this part is over.');
          if (!putAnswer(b.qid, b.value)) return fail(res, 400, 'Unknown question.');
          save(s); return send(res, 200, { ok: true });
        }
        if (m === 'POST' && p === '/api/answers') {
          if (!writable()) return fail(res, 409, 'The time for this part is over.');
          (Array.isArray(b.items) ? b.items.slice(0, 500) : []).forEach(x => putAnswer(x.qid, x.value));
          save(s); return send(res, 200, { ok: true });
        }
        if (m === 'POST' && p === '/api/upload') {
          if (!writable()) return fail(res, 409, 'The time for this part is over.');
          if (!s.exam.allowPhotos) return fail(res, 403, 'Photos are not allowed in this test.');
          const q = partOf(s, c, k).questions.find(x => x.qid === b.qid); if (!q || q.type === 'obj') return fail(res, 400, 'Unknown question.');
          const list = c.uploads[b.qid] = c.uploads[b.qid] || [];
          if (list.length >= MAX_PHOTOS_PER_Q) return fail(res, 400, `At most ${MAX_PHOTOS_PER_Q} photos per question.`);
          const mime = /^image\/(png|jpe?g|webp|heic|heif)$/i.test(String(b.mime || '')) ? String(b.mime) : 'image/jpeg';
          const b64 = String(b.b64 || ''); if (b64.length * 0.75 > MAX_PHOTO) return fail(res, 413, 'That photo is too large.');
          list.push({ name: String(b.name || 'photo').slice(0, 80), mime, b64, t: now() }); save(s);
          return send(res, 200, { ok: true, count: list.length });
        }
        if (m === 'POST' && p === '/api/unupload') {
          if (!writable()) return fail(res, 409, 'The time for this part is over.');
          const list = c.uploads[b.qid] || []; list.splice(Number(b.index) || 0, 1); save(s);
          return send(res, 200, { ok: true });
        }
        if (m === 'POST' && p === '/api/submit') {
          if (!partOk) return fail(res, 400, 'Unknown part.');
          if (Array.isArray(b.items) && writable()) b.items.slice(0, 500).forEach(x => putAnswer(x.qid, x.value));
          if (!c.submitted[k]) { c.submitted[k] = now(); if (b.auto && c.started[k] && now() >= deadline(s, c, k) - 3000) c.auto[k] = true; save(s); log(`${c.iga} submitted ${s.exam.parts[k].name}${c.auto[k] ? ' (time over)' : ''}`); }
          return send(res, 200, { ok: true });
        }
        if (m === 'POST' && p === '/api/event') {
          if (c.events.length < 500) { c.events.push({ t: now(), type: String(b.type || '').slice(0, 30) }); save(s); }
          return send(res, 200, { ok: true });
        }
        return fail(res, 404, 'Not found');
      }

      /* ----- admin ----- */
      if (p.startsWith('/admin/')) {
        if (!isAdmin(req)) return fail(res, 401, 'Wrong admin key.');
        if (m === 'GET' && p === '/admin/ping') return send(res, 200, { ok: true, sessions: sessions.size, now: now() });
        if (m === 'POST' && p === '/admin/sessions') {
          const exam = await readBody(req);
          if (!exam || !Array.isArray(exam.parts) || !exam.parts.length || !exam.sets || !Object.keys(exam.sets).length) return fail(res, 400, 'Incomplete exam.');
          exam.parts.forEach(pt => { pt.minutes = Math.max(1, Math.min(600, Number(pt.minutes) || 60)); });
          exam.startAt = Number(exam.startAt) > 0 ? Number(exam.startAt) : null; exam.fixed = !!(exam.startAt && exam.fixed);
          let code; do { code = newCode(); } while ([...sessions.values()].some(x => x.code === code));
          const s = { id: 's_' + rid(8), code, created: now(), closed: false, exam, candidates: {} };
          sessions.set(s.id, s); save(s); flush(); log(`Session ${code} opened for ${exam.title}`);
          return send(res, 200, { id: s.id, code });
        }
        if (m === 'GET' && p === '/admin/sessions') return send(res, 200, [...sessions.values()].map(s => ({ id: s.id, code: s.code, title: s.exam.title, created: s.created, closed: s.closed, candidates: Object.keys(s.candidates).length })));
        const mm = /^\/admin\/sessions\/(s_[0-9a-f]+)(\/[a-z]+)?$/.exec(p);
        const s = mm && sessions.get(mm[1]);
        if (!s) return fail(res, 404, 'No such session.');
        const sub = mm[2] || '';
        if (m === 'GET' && !sub) {
          return send(res, 200, { id: s.id, code: s.code, closed: s.closed, now: now(), startAt: startAt(s) || null, fixed: !!s.exam.fixed, endAt: windowEnd(s, null, s.exam.parts.length - 1), title: s.exam.title, parts: s.exam.parts.map(pt => ({ name: pt.name, minutes: pt.minutes })),
            candidates: Object.values(s.candidates).map(c => { settle(s, c); return { token: c.token, anon: c.anon, name: c.name, iga: c.iga, set: c.set, joined: c.joined,
              parts: s.exam.parts.map((pt, k) => ({ state: stateOf(s, c, k), deadline: deadline(s, c, k), extra: c.extra[k] || 0,
                answered: partOf(s, c, k).questions.filter(q => { const v = c.answers[q.qid]; return v !== undefined && v !== null && v !== '' && !(typeof v === 'object' && !Object.values(v).some(Boolean)); }).length,
                total: partOf(s, c, k).questions.length })),
              left: c.events.filter(e => e.type === 'left').length, shots: c.events.filter(e => e.type === 'screenshot-key').length }; }) });
        }
        if (m === 'GET' && sub === '/results') {
          Object.values(s.candidates).forEach(c => settle(s, c));
          return send(res, 200, { id: s.id, code: s.code, title: s.exam.title, collected: now(), candidates: Object.values(s.candidates) });
        }
        if (m === 'POST' && sub === '/extend') {
          const b = await readBody(req), c = s.candidates[b.token]; if (!c) return fail(res, 404, 'No such candidate.');
          const k = s.exam.parts.findIndex((pt, j) => !c.submitted[j]); if (k < 0) return fail(res, 409, 'This candidate has finished.');
          c.extra[k] = (c.extra[k] || 0) + Math.max(-60, Math.min(120, Number(b.minutes) || 5)); save(s);
          return send(res, 200, { ok: true, part: k, extra: c.extra[k] });
        }
        if (m === 'POST' && sub === '/close') { s.closed = true; save(s); flush(); return send(res, 200, { ok: true }); }
        if (m === 'DELETE' && !sub) { sessions.delete(s.id); try { fs.unlinkSync(path.join(dataDir, s.id + '.json')); } catch (e) {} return send(res, 200, { ok: true }); }
        return fail(res, 404, 'Not found');
      }
      return fail(res, 404, 'Not found');
    } catch (e) {
      return fail(res, e.code === 413 ? 413 : e.code === 400 ? 400 : 500, e.code === 413 ? 'Too large.' : e.code === 400 ? 'Bad request.' : 'Server error.');
    }
  }
  return { handle, flush, close: () => { clearInterval(timer); flush(); } };
}

function startServer(opt) {
  const engine = createEngine(opt);
  const server = http.createServer((req, res) => engine.handle(req, res));
  server.requestTimeout = 120000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opt.port || 8080, opt.host || '0.0.0.0', () => resolve({ server, engine, port: server.address().port }));
  });
}

module.exports = { createEngine, startServer };
