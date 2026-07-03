/* ══ UI-MEET-IMPORT.JS – Google Meet attendance report import + reconciliation ══ */
/* Attendance tab > Import & Review sub-tab. Reuses excel.js's XLSX parsing
   conventions (importCol, the global XLSX object) but lives in its own file
   since the target collection, matching algorithm and review UI are unrelated
   to the devotee-roster importer in excel.js. */

// Declarative column-alias table, same pattern as excel.js's IMPORT_FIELDS.
// "Joined at(beta)"/"Attendance Started at"/"Attendance Stopped at"/"Attended"
// are Google Meet's actual native attendance-report column headers.
const MEET_IMPORT_FIELDS = {
  participantName:  ['Name', 'Participant Name', 'Full Name'],
  participantEmail: ['Email', 'Participant Email', 'Email Address'],
  joinTime:         ['Joined at(beta)', 'Joined at', 'Attendance Started at', 'Join Time', 'First Join', 'First Seen'],
  leaveTime:        ['Attendance Stopped at', 'Leave Time', 'Last Leave', 'Last Seen'],
  durationMinutes:  ['Attended', 'Duration (Minutes)', 'Duration', 'Total Duration (Minutes)'],
};

// Auto-match threshold for fuzzy name similarity — a starting default, hand-tune
// against a real exported CSV if it over/under-matches in practice.
const MEET_FUZZY_THRESHOLD = 0.82;

function _meetLevenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = [];
  for (let i = 0; i <= m; i++) dp.push(new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}
function _meetSimilarity(a, b) {
  a = (a || '').trim().toLowerCase();
  b = (b || '').trim().toLowerCase();
  if (!a || !b) return 0;
  return 1 - _meetLevenshtein(a, b) / Math.max(a.length, b.length);
}
function _meetNormName(s)  { return (s || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function _meetNormEmail(s) { return (s || '').trim().toLowerCase(); }

function _meetParseDateTime(val, fallbackDateStr) {
  const baseDateStr = fallbackDateStr || getToday();
  if (val) {
    const s = String(val).trim();
    // Google Meet's export gives a bare time like "1:27:09 pm", not a full
    // date. Relying on new Date(bareTime) is unreliable across browsers (it
    // may silently assume "today" instead of the session date, or fail to
    // parse at all) — parse it explicitly and anchor to the session date.
    const timeMatch = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1], 10);
      const minutes = parseInt(timeMatch[2], 10);
      const seconds = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0;
      const meridiem = timeMatch[4] ? timeMatch[4].toLowerCase().replace(/\./g, '') : null;
      if (meridiem === 'pm' && hours < 12) hours += 12;
      if (meridiem === 'am' && hours === 12) hours = 0;
      const d = new Date(baseDateStr + 'T00:00:00');
      d.setHours(hours, minutes, seconds, 0);
      return d;
    }
    // Otherwise try a full date-time string (ISO, "MM/DD/YYYY HH:MM", etc.)
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d;
  }
  return new Date(baseDateStr + 'T00:00:00');
}

// Google Meet's "Attended" column is text like "7 min 22s", not a plain number.
function _meetParseDurationMinutes(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const minMatch = s.match(/(\d+)\s*min/i);
  const secMatch = s.match(/(\d+)\s*s(?:ec)?/i);
  if (minMatch || secMatch) {
    const mins = minMatch ? parseInt(minMatch[1], 10) : 0;
    const secs = secMatch ? parseInt(secMatch[1], 10) : 0;
    return mins + secs / 60;
  }
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// All the names a devotee could plausibly join Meet under: their registered
// name plus every name-type meetingIdentities entry. Both the exact-match
// and fuzzy-suggestion steps use THIS list (not just d.name) so a devotee
// with a saved alias is found identically by either path — no gap between
// "why didn't this auto-match" and "why isn't this even suggested".
function _meetCandidateNames(d) {
  const names = [d.name];
  (d.meetingIdentities || []).forEach(mi => { if (mi.type === 'name' && mi.value) names.push(mi.value); });
  return names;
}

// Top-3 fuzzy candidates for a name, regardless of threshold — used to
// populate the Unmatched Attendees review dropdown, not for auto-matching.
// Scores each devotee by their BEST-matching candidate name (registered name
// or any saved alias), not just the registered name.
function _meetTopCandidates(name, devotees) {
  const nName = _meetNormName(name);
  if (!nName) return [];
  return devotees
    .map(d => {
      const best = _meetCandidateNames(d).reduce((acc, cand) => {
        const score = _meetSimilarity(nName, cand);
        return score > acc.score ? { score, matchedName: cand } : acc;
      }, { score: 0, matchedName: d.name });
      return { devoteeId: d.id, devoteeName: d.name, score: best.score, matchedOn: 'name' };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

// Match one CSV row against the devotee roster (devotees = raw DevoteeCache
// shape, camelCase). Returns { devotee, matchedOn, score } or null.
function _matchMeetRow(row, devotees) {
  const name   = importCol(row, MEET_IMPORT_FIELDS.participantName);
  const email  = importCol(row, MEET_IMPORT_FIELDS.participantEmail);
  const nEmail = _meetNormEmail(email);
  const nName  = _meetNormName(name);

  if (nEmail) {
    for (const d of devotees) {
      if (_meetNormEmail(d.email) === nEmail) return { devotee: d, matchedOn: 'email' };
      if ((d.meetingIdentities || []).some(mi => mi.type === 'email' && _meetNormEmail(mi.value) === nEmail)) {
        return { devotee: d, matchedOn: 'email' };
      }
    }
  }
  if (nName) {
    for (const d of devotees) {
      if (_meetCandidateNames(d).some(cand => _meetNormName(cand) === nName)) {
        return { devotee: d, matchedOn: 'name' };
      }
    }
    const scored = devotees
      .map(d => ({ d, score: Math.max(..._meetCandidateNames(d).map(cand => _meetSimilarity(nName, cand))) }))
      .filter(x => x.score >= MEET_FUZZY_THRESHOLD)
      .sort((a, b) => b.score - a.score);
    if (scored.length) {
      const unique = scored.length === 1 || (scored[0].score - scored[1].score) > 0.05;
      if (unique) return { devotee: scored[0].d, matchedOn: 'fuzzy', score: scored[0].score };
    }
  }
  return null;
}

function _resetMeetDropZone() {
  const zone = document.getElementById('meet-import-drop-zone');
  if (!zone) return;
  zone.innerHTML = `<i class="fas fa-cloud-upload-alt"></i>
    <p>Click to browse or drag &amp; drop the Meet attendance export</p>
    <small style="color:var(--text-muted)">.xlsx, .xls or .csv</small>
    <input type="file" id="meet-import-file" accept=".xlsx,.xls,.csv" style="display:none" onchange="handleMeetImportFile(event)">`;
}

async function handleMeetImportFile(e) {
  const file = e.target.files[0]; if (!file) return;
  const zone   = document.getElementById('meet-import-drop-zone');
  const result = document.getElementById('meet-import-result');
  e.target.value = '';
  result.classList.add('hidden');
  zone.innerHTML = '<i class="fas fa-spinner fa-spin" style="font-size:2rem;color:var(--secondary)"></i><p>Reading file…</p>';
  try {
    const ab = await file.arrayBuffer();
    const wb = XLSX.read(ab, { type: 'array', cellDates: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    if (!rows.length) throw new Error('No data rows found in the file.');
    await processMeetImport(rows, file.name);
  } catch (err) {
    result.className = 'import-result error';
    result.innerHTML = `<strong>Import failed:</strong> ${err.message || 'Unknown error'}`;
    result.classList.remove('hidden');
    console.error('Meet import error', err);
  } finally {
    _resetMeetDropZone();
  }
}

async function processMeetImport(rows, fileName) {
  const result = document.getElementById('meet-import-result');
  const sessionId   = AppState.currentSessionId;
  const sessionDate = AppState.filters?.sessionId;
  if (!sessionId || !sessionDate) {
    showToast('Pick a session in the master filter bar first', 'error');
    return;
  }
  const devotees = await DevoteeCache.all(); // raw camelCase shape

  const matchedRows = [];
  const unmatchedRows = [];
  const realJoinTimes = [];  // only rows with an actual parsed join-time column — used to derive the meeting's start time
  const realLeaveTimes = []; // same, for the meeting's end time
  rows.forEach(row => {
    const name    = importCol(row, MEET_IMPORT_FIELDS.participantName);
    const email   = importCol(row, MEET_IMPORT_FIELDS.participantEmail);
    const joinRaw = importCol(row, MEET_IMPORT_FIELDS.joinTime);
    const leaveRaw = importCol(row, MEET_IMPORT_FIELDS.leaveTime);
    const durRaw  = importCol(row, MEET_IMPORT_FIELDS.durationMinutes);
    if (!name && !email) return; // skip genuinely blank rows

    const match = _matchMeetRow(row, devotees);
    const joinTime = _meetParseDateTime(joinRaw, sessionDate);
    const durationMinutes = _meetParseDurationMinutes(durRaw);
    if (joinRaw) realJoinTimes.push(joinTime);
    if (leaveRaw) realLeaveTimes.push(_meetParseDateTime(leaveRaw, sessionDate));
    if (match) {
      matchedRows.push({ devotee: toSnake(match.devotee), joinTime, isNewDevotee: false, durationMinutes });
    } else {
      unmatchedRows.push({
        rawName: name || '', rawEmail: email || null,
        joinTime: joinRaw ? joinTime : null,
        leaveTime: leaveRaw ? _meetParseDateTime(leaveRaw, sessionDate) : null,
        durationMinutes,
        suggestedMatches: _meetTopCandidates(name, devotees),
      });
    }
  });

  // Auto-derive the session's start/end time from the earliest join / latest
  // leave time in this sheet — "fetch attendance start time from the imported
  // sheet" — but never overwrite a time the admin already set manually or
  // from a prior import (the onlyIfUnset guard handles that).
  if (realJoinTimes.length) {
    const earliest = new Date(Math.min(...realJoinTimes.map(d => d.getTime())));
    try { await DB.setSessionStartTime(sessionId, earliest, { onlyIfUnset: true }); } catch (_) {}
  }
  if (realLeaveTimes.length) {
    const latest = new Date(Math.max(...realLeaveTimes.map(d => d.getTime())));
    try { await DB.setSessionEndTime(sessionId, latest, { onlyIfUnset: true }); } catch (_) {}
  }

  let written = 0;
  if (matchedRows.length) {
    const res = await DB.bulkMarkPresentFromImport(sessionId, matchedRows);
    written = res.written;
  }
  const batchId = await DB.createMeetImportBatch({
    sessionId, fileName: fileName || '', totalRows: rows.length,
    matchedCount: matchedRows.length, unmatchedCount: unmatchedRows.length,
  });
  for (const u of unmatchedRows) {
    await DB.saveUnmatchedAttendee({
      sessionId, batchId,
      rawName: u.rawName, rawEmail: u.rawEmail,
      joinTime: u.joinTime ? firebase.firestore.Timestamp.fromDate(u.joinTime) : null,
      leaveTime: u.leaveTime ? firebase.firestore.Timestamp.fromDate(u.leaveTime) : null,
      durationMinutes: u.durationMinutes, suggestedMatches: u.suggestedMatches,
    });
  }

  result.className = 'import-result success';
  result.innerHTML = `<strong>Import complete.</strong> ${matchedRows.length} matched and marked present (${written} new — already-present rows were skipped), ${unmatchedRows.length} need review below.`;
  result.classList.remove('hidden');
  showToast('Meet attendance imported!', 'success');
  if (AppState._attSubTab === 'live' && typeof loadAttendanceTab === 'function') loadAttendanceTab();
  await loadUnmatchedAttendeesList();
}

async function loadMeetImportTab() {
  _resetMeetDropZone();
  document.getElementById('meet-import-result')?.classList.add('hidden');
  await loadUnmatchedAttendeesList();
}

async function loadUnmatchedAttendeesList() {
  const el = document.getElementById('meet-unmatched-list');
  if (!el) return;
  const sessionId = AppState.currentSessionId;
  if (!sessionId) {
    el.innerHTML = '<div class="empty-state"><i class="fas fa-calendar-times"></i><p>Pick a session in the master filter bar first</p></div>';
    return;
  }
  el.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';
  try {
    const rows = await DB.getUnmatchedAttendees(sessionId);
    if (!rows.length) {
      el.innerHTML = '<div class="empty-state"><i class="fas fa-check-circle"></i><p>No unmatched attendees for this session</p></div>';
      return;
    }
    const devotees = await DevoteeCache.all();
    window._meetUnmatchedDevotees = devotees; // used by _meetLink/_meetSearch below
    window._meetUnmatchedRows = {};
    rows.forEach(r => { window._meetUnmatchedRows[r.id] = r; });
    el.innerHTML = rows.map(r => _renderUnmatchedRow(r)).join('');
  } catch (e) {
    el.innerHTML = '<div class="empty-state"><p>Failed to load</p></div>';
    console.error('loadUnmatchedAttendeesList', e);
  }
}

function _renderUnmatchedRow(r) {
  const fmt = ts => ts?.toDate ? ts.toDate().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }) : '—';
  const suggestions = (r.suggestedMatches || []).map(s =>
    `<option value="${s.devoteeId}">${s.devoteeName} (${Math.round(s.score * 100)}% match)</option>`
  ).join('');
  return `
    <div class="mu-row" id="mu-row-${r.id}" style="border:1px solid var(--border);border-radius:8px;padding:.7rem .9rem;margin-bottom:.6rem;display:flex;flex-wrap:wrap;gap:.6rem;align-items:center">
      <div style="flex:1;min-width:180px">
        <div style="font-weight:700">${r.rawName || '(no name)'}</div>
        <div style="font-size:.78rem;color:var(--text-muted)">
          ${r.rawEmail ? r.rawEmail + ' · ' : ''}Joined ${fmt(r.joinTime)} · Left ${fmt(r.leaveTime)}${r.durationMinutes ? ' · ' + Math.round(r.durationMinutes) + ' min' : ''}
        </div>
      </div>
      <select id="mu-select-${r.id}" class="filter-select" style="min-width:180px">
        ${suggestions || '<option value="">No suggestions</option>'}
        <option value="__search__">Search other devotee…</option>
      </select>
      <input type="text" id="mu-search-${r.id}" class="filter-select hidden" placeholder="Type devotee name…" oninput="_meetFilterSearch('${r.id}')" style="min-width:160px">
      <div id="mu-search-results-${r.id}" class="hidden" style="width:100%;max-height:120px;overflow:auto;border:1px solid var(--border);border-radius:6px"></div>
      <label style="display:flex;align-items:center;gap:.3rem;font-size:.78rem;color:var(--text-muted);white-space:nowrap" title="Check if you just created this devotee via the New Devotee button — flags them for the New Comers report">
        <input type="checkbox" id="mu-isnew-${r.id}"> New devotee
      </label>
      <button class="btn btn-primary" style="padding:.3rem .8rem;font-size:.8rem" onclick="_meetLinkUnmatched('${r.id}')"><i class="fas fa-link"></i> Link</button>
      <button class="btn btn-secondary" style="padding:.3rem .8rem;font-size:.8rem" onclick="_meetCreateDevoteeFromUnmatched('${r.id}')"><i class="fas fa-user-plus"></i> New Devotee</button>
      <button class="btn btn-secondary" style="padding:.3rem .8rem;font-size:.8rem" onclick="_meetIgnoreUnmatched('${r.id}')"><i class="fas fa-times"></i> Ignore</button>
    </div>`;
}

document.addEventListener('change', e => {
  if (e.target?.id?.startsWith('mu-select-')) {
    const id = e.target.id.replace('mu-select-', '');
    const searchBox = document.getElementById(`mu-search-${id}`);
    if (searchBox) searchBox.classList.toggle('hidden', e.target.value !== '__search__');
  }
});

function _meetFilterSearch(unmatchedId) {
  const input = document.getElementById(`mu-search-${unmatchedId}`);
  const box   = document.getElementById(`mu-search-results-${unmatchedId}`);
  if (!input || !box) return;
  const q = _meetNormName(input.value);
  if (!q) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const matches = (window._meetUnmatchedDevotees || [])
    .filter(d => _meetNormName(d.name).includes(q)).slice(0, 8);
  box.classList.toggle('hidden', !matches.length);
  box.innerHTML = matches.map(d =>
    `<div style="padding:.3rem .6rem;cursor:pointer" onmousedown="_meetPickSearchResult('${unmatchedId}','${d.id}','${(d.name||'').replace(/'/g,"\\'")}')">${d.name}</div>`
  ).join('');
}

function _meetPickSearchResult(unmatchedId, devoteeId, devoteeName) {
  const input = document.getElementById(`mu-search-${unmatchedId}`);
  const box   = document.getElementById(`mu-search-results-${unmatchedId}`);
  const select = document.getElementById(`mu-select-${unmatchedId}`);
  if (input) input.value = devoteeName;
  if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
  if (select) {
    let opt = select.querySelector(`option[value="${devoteeId}"]`);
    if (!opt) {
      opt = document.createElement('option');
      opt.value = devoteeId;
      opt.textContent = devoteeName;
      select.insertBefore(opt, select.firstChild);
    }
    select.value = devoteeId;
  }
}

async function _meetLinkUnmatched(unmatchedId) {
  const select = document.getElementById(`mu-select-${unmatchedId}`);
  const devoteeId = select?.value;
  if (!devoteeId || devoteeId === '__search__') {
    showToast('Pick a devotee to link first', 'error');
    return;
  }
  const sessionId = AppState.currentSessionId;
  const devotees = window._meetUnmatchedDevotees || await DevoteeCache.all();
  const devotee = devotees.find(d => d.id === devoteeId);
  if (!devotee) { showToast('Devotee not found', 'error'); return; }
  try {
    const rowEl = document.getElementById(`mu-row-${unmatchedId}`);
    if (rowEl) rowEl.style.opacity = '.5';
    const row = (window._meetUnmatchedRows || {})[unmatchedId];
    const joinTime = row?.joinTime?.toDate ? row.joinTime.toDate() : new Date();
    const isNewDevotee = !!document.getElementById(`mu-isnew-${unmatchedId}`)?.checked;
    await DB.resolveUnmatchedAttendee(unmatchedId, sessionId, toSnake(devotee), joinTime, isNewDevotee);
    showToast('Linked and marked present!', 'success');
    if (AppState._attSubTab === 'live' && typeof loadAttendanceTab === 'function') loadAttendanceTab();
    await loadUnmatchedAttendeesList();
  } catch (e) {
    showToast('Link failed: ' + (e.message || 'Error'), 'error');
    console.error('_meetLinkUnmatched', e);
  }
}

async function _meetIgnoreUnmatched(unmatchedId) {
  try {
    await DB.ignoreUnmatchedAttendee(unmatchedId);
    await loadUnmatchedAttendeesList();
  } catch (e) {
    showToast('Failed: ' + (e.message || 'Error'), 'error');
  }
}

// Opens the normal Add Devotee flow, pre-filled with this row's name/email.
// After saving, come back and hit "Link" for this row to mark them present.
function _meetCreateDevoteeFromUnmatched(unmatchedId) {
  const row = (window._meetUnmatchedRows || {})[unmatchedId];
  if (typeof openDevoteeFormModal === 'function') openDevoteeFormModal(true);
  const nameEl  = document.getElementById('f-name');
  const emailEl = document.getElementById('f-email');
  if (nameEl)  nameEl.value  = row?.rawName || '';
  if (emailEl) emailEl.value = row?.rawEmail || '';
  // Pre-check "New devotee" for this row since that's why the admin clicked here.
  const isNewCb = document.getElementById(`mu-isnew-${unmatchedId}`);
  if (isNewCb) isNewCb.checked = true;
  showToast('Fill in the rest and save, then come back, search for them, and click Link', '');
}
