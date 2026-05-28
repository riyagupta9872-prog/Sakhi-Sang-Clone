// Natural-language query interface over Firestore data, powered by Gemini.
// Requests are proxied through a Cloudflare Worker so the API key never
// leaves Cloudflare's servers (deployed at AI_PROXY_BASE below). Update this
// constant if you redeploy the Worker under a new name.
const _AI_PROXY_BASE = 'https://old-truth-f7e0sakhi-ai.riyagupta9872.workers.dev';

// Models tried in order — if one returns "quota exceeded" with limit: 0
// (no free-tier access), we automatically try the next.
const _GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash-exp',
  'gemini-1.5-flash-8b',
  'gemini-1.5-flash-latest',
];
let _activeModel = _GEMINI_MODELS[0];

function _geminiUrl(model) {
  // Worker forwards path 1:1 to Gemini, injecting the API key from its secret.
  return `${_AI_PROXY_BASE}/v1beta/models/${model}:generateContent`;
}

// Show FAB only when authenticated; init drag on first show.
// Guard against the Firebase SDK not being ready yet at script-eval time
// (avoids "firebase is not defined") — retry until it's available.
(function _aiFabAuthInit() {
  if (typeof firebase === 'undefined' || !firebase.auth) {
    setTimeout(_aiFabAuthInit, 200);
    return;
  }
  firebase.auth().onAuthStateChanged(user => {
    const fab = document.getElementById('ai-fab');
    if (!fab) return;
    fab.style.display = user ? 'flex' : 'none';
    if (user) _initAiFabDrag();
  });
})();

function _initAiFabDrag() {
  const fab = document.getElementById('ai-fab');
  if (!fab || fab._dragInit) return;
  fab._dragInit = true;

  // Restore saved position (stored as { left, top } in px from viewport top-left)
  const saved = (() => { try { return JSON.parse(localStorage.getItem('ai-fab-pos')); } catch { return null; } })();
  if (saved && saved.left != null && saved.top != null) {
    const S = fab.offsetWidth || 52;
    const clampedLeft = Math.min(Math.max(0, saved.left), window.innerWidth  - S);
    const clampedTop  = Math.min(Math.max(0, saved.top),  window.innerHeight - S);
    fab.style.left   = clampedLeft + 'px';
    fab.style.top    = clampedTop  + 'px';
    fab.style.bottom = 'auto';
    fab.style.right  = 'auto';
  }

  let _startX, _startY, _originLeft, _originTop, _moved = false;
  const DRAG_THRESHOLD = 6; // px movement before we consider it a drag

  function _dragStart(x, y) {
    const rect = fab.getBoundingClientRect();
    _startX = x; _startY = y;
    _originLeft = rect.left; _originTop = rect.top;
    _moved = false;
    // Switch to top/left absolute so we can freely position during drag
    fab.style.left   = _originLeft + 'px';
    fab.style.top    = _originTop  + 'px';
    fab.style.bottom = 'auto';
    fab.style.right  = 'auto';
    fab.classList.add('dragging');
  }

  function _dragMove(x, y) {
    const dx = x - _startX, dy = y - _startY;
    if (!_moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    _moved = true;
    const S = fab.offsetWidth;
    const newLeft = Math.min(Math.max(0, _originLeft + dx), window.innerWidth  - S);
    const newTop  = Math.min(Math.max(0, _originTop  + dy), window.innerHeight - S);
    fab.style.left = newLeft + 'px';
    fab.style.top  = newTop  + 'px';
  }

  function _dragEnd() {
    fab.classList.remove('dragging');
    if (!_moved) {
      openAiChat();
      return;
    }
    localStorage.setItem('ai-fab-pos', JSON.stringify({
      left: parseInt(fab.style.left),
      top:  parseInt(fab.style.top)
    }));
  }

  // Mouse
  fab.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    _dragStart(e.clientX, e.clientY);
    const onMove = e => _dragMove(e.clientX, e.clientY);
    const onUp   = () => { _dragEnd(); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });

  // Touch
  fab.addEventListener('touchstart', e => {
    const t = e.touches[0];
    _dragStart(t.clientX, t.clientY);
  }, { passive: true });

  fab.addEventListener('touchmove', e => {
    const t = e.touches[0];
    _dragMove(t.clientX, t.clientY);
    if (_moved) e.preventDefault(); // block page scroll while dragging
  }, { passive: false });

  fab.addEventListener('touchend', e => {
    if (_moved) e.preventDefault(); // block ghost click after drag
    _dragEnd();
  }, { passive: false });
}

function openAiChat() {
  openModal('ai-chat-modal');
  setTimeout(() => document.getElementById('ai-chat-input')?.focus(), 100);
}

function closeAiChat() {
  closeModal('ai-chat-modal');
}

// ── Intent detection ──────────────────────────────────────────────────────────

function _aiNeedsAttendance(q) {
  return /attend|came|present|absent|miss|session|sunday|didn.t come|not come|\d+\s*week/i.test(q);
}

function _aiNeedsCalling(q) {
  return /call|calling|contact|promis|coming|said yes|not called|submitt|coordinator/i.test(q);
}

function _aiNeedsActivities(q) {
  return /book|distribut|donat|registr|service|seva|kirtan|activit/i.test(q);
}

// Returns { startDate, endDate } for the current fiscal year (Apr–Mar).
function _fiscalYearRange() {
  const now = new Date();
  const fy = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return {
    startDate: `${fy}-04-01`,
    endDate:   `${fy + 1}-03-31`,
  };
}

// ── Data preparation ──────────────────────────────────────────────────────────

function _compactDevotees(devotees) {
  return devotees.map(d => {
    const o = {
      name: d.name,
      team: d.team_name || d.teamName,
      status: d.devotee_status || d.devoteeStatus,
      chanting: d.chanting_rounds ?? d.chantingRounds,
      kanthi: d.kanthi,
      tilak: d.tilak,
      lifetime_att: d.lifetime_attendance ?? d.lifetimeAttendance,
      calling_by: d.calling_by || d.callingBy,
      facilitator: d.facilitator,
      joined: d.date_of_joining || d.dateOfJoining,
      dob: d.dob,
    };
    if (d.skills)                                o.skills = d.skills;
    if (d.hobbies)                               o.hobbies = d.hobbies;
    if (d.reading)                               o.reading = d.reading;
    if (d.hearing)                               o.hearing = d.hearing;
    if (d.education)                             o.education = d.education;
    if (d.profession)                            o.profession = d.profession;
    const fav = d.family_favourable || d.familyFavourable;
    if (fav)                                     o.family_favourable = fav;
    if (d.inactivity_flag || d.inactivityFlag)   o.inactive = true;
    const mode = d.calling_mode || d.callingMode;
    if (mode)                                    o.mode = mode;
    if (d.plays_instrument)                      o.plays_instrument = d.plays_instrument;
    if (d.instrument_name)                       o.instrument = d.instrument_name;
    if (d.wants_kirtan_class)                    o.wants_kirtan_class = d.wants_kirtan_class;
    // Include computed profile completion so AI can answer completion-related questions.
    o.profile_completion_pct = typeof _calcProfileCompletion === 'function'
      ? _calcProfileCompletion(d)
      : null;
    return o;
  });
}

async function _buildPrompt(question) {
  const devotees = await DevoteeCache.all();
  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const sections = [];
  sections.push(`DEVOTEES (${devotees.length} active):\n${JSON.stringify(_compactDevotees(devotees))}`);

  if (_aiNeedsAttendance(question)) {
    try {
      const sessions = (await DB.getSessions()).slice(0, 5);
      const attData = [];
      for (const s of sessions) {
        const att = await DB.getSessionAttendance(s.id);
        attData.push({
          date: s.session_date,
          cancelled: !!s.is_cancelled,
          attendees: att.map(a => ({ name: a.name, team: a.team_name }))
        });
      }
      sections.push(`RECENT ATTENDANCE (last ${sessions.length} Sundays):\n${JSON.stringify(attData)}`);
    } catch (e) { console.warn('AI: attendance fetch failed', e); }
  }

  if (_aiNeedsCalling(question)) {
    try {
      const cfg = await DB.getCallingWeekConfig();
      if (cfg) {
        const cs = await DB.getCallingStatus(cfg.callingDate);
        sections.push(`CALLING STATUS (week of ${cfg.callingDate}):\n${JSON.stringify(
          cs.map(d => ({
            name: d.name, team: d.team_name,
            calling_by: d.calling_by,
            status: d.coming_status,
            reason: d.calling_reason,
            notes: d.calling_notes
          }))
        )}`);
      }
    } catch (e) { console.warn('AI: calling fetch failed', e); }
  }

  if (_aiNeedsActivities(question)) {
    try {
      const range = _fiscalYearRange();
      const [books, donations, registrations, services] = await Promise.all([
        DB.getBookDistributions(range).catch(() => []),
        DB.getDonations(range).catch(() => []),
        DB.getRegistrations(range).catch(() => []),
        DB.getServices(range).catch(() => []),
      ]);
      if (books.length)         sections.push(`BOOK DISTRIBUTIONS (this fiscal year, ${books.length} records):\n${JSON.stringify(books.map(r => ({ name: r.devoteeName, team: r.teamName, date: r.date, qty: r.quantity })))}`);
      if (donations.length)     sections.push(`DONATIONS (this fiscal year, ${donations.length} records):\n${JSON.stringify(donations.map(r => ({ team: r.teamName, date: r.date, amount: r.amount, note: r.note })))}`);
      if (registrations.length) sections.push(`REGISTRATIONS (this fiscal year, ${registrations.length} records):\n${JSON.stringify(registrations.map(r => ({ name: r.devoteeName, team: r.teamName, date: r.date, count: r.count })))}`);
      if (services.length)      sections.push(`SERVICES / SEVA (this fiscal year, ${services.length} records):\n${JSON.stringify(services.map(r => ({ name: r.devoteeName, team: r.teamName, date: r.date, description: r.serviceDescription })))}`);
    } catch (e) { console.warn('AI: activities fetch failed', e); }
  }

  return `You are an AI assistant for "Sakhi Sang", an ISKCON community management app used by coordinators.
Today: ${today}

${sections.join('\n\n')}

Question: ${question}

Rules:
- Answer using ONLY the data above — never invent names or numbers.
- Be direct and concise.
- When listing people, format as "Name (Team)" per line.
- For counts, give the exact number from the data.
- "chanting" field means daily chanting rounds; "kanthi" means kanthi mala worn.
- "profile_completion_pct" is the percentage (0–100) of key profile fields that are filled in for each devotee.
- For activities (books, donations, registrations, service), data covers the current fiscal year (April–March).
- If data is insufficient to answer, say what's missing clearly.`;
}

// ── Gemini API call ───────────────────────────────────────────────────────────

async function _callGeminiWithModel(model, prompt) {
  const res = await fetch(_geminiUrl(model), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 800 }
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error?.message || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    // limit: 0 means this model has no free-tier quota for this key — try next model.
    err.noFreeQuota = /limit:\s*0/i.test(msg);
    // 404 / "not found" → model unavailable on this key — try next.
    err.notFound = res.status === 404 || /not found/i.test(msg);
    // 503 = model overloaded, 429 = rate-limited — try next model immediately.
    err.transient = res.status === 503 || res.status === 429 || /overload|high demand|try again/i.test(msg);
    throw err;
  }
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'No response received.';
}

async function _callGemini(prompt) {
  // Start from the last model that worked; fall through the chain on quota=0 / not-found.
  const startIdx = Math.max(0, _GEMINI_MODELS.indexOf(_activeModel));
  let lastErr;
  for (let i = startIdx; i < _GEMINI_MODELS.length; i++) {
    const model = _GEMINI_MODELS[i];
    try {
      const out = await _callGeminiWithModel(model, prompt);
      if (_activeModel !== model) {
        console.info(`[AI Chat] switched to model: ${model}`);
        _activeModel = model;
      }
      return out;
    } catch (e) {
      lastErr = e;
      if (e.noFreeQuota || e.notFound || e.transient) {
        console.warn(`[AI Chat] ${model} unavailable (${e.message.split('\n')[0]}). Trying next…`);
        continue;
      }
      throw e; // real error (auth, network, etc.) — don't keep trying
    }
  }
  // All models exhausted. If the last failure was transient, surface a friendlier message.
  if (lastErr?.transient) {
    throw new Error(
      `All Gemini models are temporarily overloaded. This is a Google-side issue — please try again in a minute or two.\n\nLast error: ${lastErr.message}`
    );
  }
  throw new Error(
    `No Gemini model with free-tier access found on this API key. ` +
    `Run listGeminiModels() in the browser console to see what's available, ` +
    `or enable billing at console.cloud.google.com.\n\nLast error: ${lastErr?.message}`
  );
}

// ── Message UI ────────────────────────────────────────────────────────────────

function _aiAddMsg(role, text) {
  const el = document.createElement('div');
  el.className = `ai-msg ai-msg-${role}`;
  if (role === 'assistant') {
    // Escape HTML first to prevent XSS, then apply safe markdown
    const safe = text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    el.innerHTML = safe
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
  } else {
    el.textContent = text;
  }
  const box = document.getElementById('ai-chat-messages');
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
  return el;
}

// ── Send handler ──────────────────────────────────────────────────────────────

async function sendAiChatMessage() {
  const input = document.getElementById('ai-chat-input');
  const q = input.value.trim();
  if (!q) return;

  input.value = '';

  // Hide onboarding elements on first use
  document.getElementById('ai-chat-welcome')?.remove();
  document.getElementById('ai-examples')?.remove();

  _aiAddMsg('user', q);

  const loadEl = document.createElement('div');
  loadEl.className = 'ai-msg ai-msg-assistant ai-msg-loading';
  loadEl.innerHTML = '<span></span><span></span><span></span>';
  document.getElementById('ai-chat-messages').appendChild(loadEl);
  document.getElementById('ai-chat-messages').scrollTop = 99999;

  const btn = document.getElementById('ai-send-btn');
  btn.disabled = true;
  input.disabled = true;

  try {
    const prompt = await _buildPrompt(q);
    const answer = await _callGemini(prompt);
    loadEl.remove();
    _aiAddMsg('assistant', answer);
  } catch (e) {
    loadEl.remove();
    _aiAddMsg('assistant', `Sorry, something went wrong: ${e.message}`);
    console.error('AI Chat error:', e);
  } finally {
    btn.disabled = false;
    input.disabled = false;
    input.focus();
  }
}

function aiAskExample(text) {
  document.getElementById('ai-chat-input').value = text;
  sendAiChatMessage();
}

function _aiInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAiChatMessage(); }
}
