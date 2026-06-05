/* ══ UI-ATTENDANCE.JS – Attendance sheet, Sunday config, live session ══ */

// ── ATTENDANCE SUB-TAB ────────────────────────────────
function switchAttTab(tab, btn) {
  document.querySelectorAll('#tab-attendance .att-sub-tab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.att-sub-panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('att-panel-' + tab).classList.add('active');
  const fab = document.getElementById('register-fab');
  if (fab) fab.classList.toggle('hidden', tab !== 'live');
  if (tab === 'sheet') loadAttendanceSheet();
}


// ── ATTENDANCE SHEET ──────────────────────────────────
function getFYYears() {
  const now = new Date();
  const m = now.getMonth() + 1;
  const y = now.getFullYear();
  const fyStart = m >= 4 ? y : y - 1;
  const years = [];
  for (let i = 0; i <= 3; i++) {
    const s = fyStart - i;
    years.push({ label: `FY ${s}-${String(s + 1).slice(-2)}`, start: `${s}-04-01`, end: `${s + 1}-03-31` });
  }
  return years;
}

function initSheetYearSelector(elId) {
  const sel = document.getElementById(elId || 'sheet-year');
  if (!sel || sel.options.length > 0) return;
  getFYYears().forEach((y, i) => {
    const opt = document.createElement('option');
    opt.value = JSON.stringify({ start: y.start, end: y.end });
    opt.textContent = y.label;
    if (i === 0) opt.selected = true;
    sel.appendChild(opt);
  });
}

// Simple roster (Attendance tab) — no per-session CS/AT columns
async function loadAttendanceSheet() {
  const wrap = document.getElementById('attendance-sheet-wrap');
  const teamFilter = document.getElementById('sheet-team').value;
  wrap.innerHTML = '<div class="loading" style="padding:2rem"><i class="fas fa-spinner"></i> Loading…</div>';
  try {
    const devotees = await DevoteeCache.all();
    wrap.innerHTML = buildSimpleRoster(devotees, teamFilter);
  } catch (e) {
    console.error('Sheet error', e);
    wrap.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load</p></div>';
  }
}

function buildSimpleRoster(devotees, teamFilter) {
  let rows = [...devotees];
  if (teamFilter) rows = rows.filter(d => d.teamName === teamFilter);
  rows.sort((a, b) => (a.teamName || '').localeCompare(b.teamName || '') || a.name.localeCompare(b.name));
  if (!rows.length) return '<div class="empty-state"><i class="fas fa-users"></i><p>No devotees found</p></div>';

  let currentTeam = null;
  const bodyRows = rows.map((d, i) => {
    const isActive = d.isActive !== false;
    const total = d.lifetimeAttendance || 0;
    const totalBg = total >= 30 ? 'background:#b2ebf2;font-weight:700' : total >= 15 ? 'background:#c8e6c9;font-weight:600' : total >= 5 ? 'background:#fff9c4' : '';
    let teamRow = '';
    if (d.teamName !== currentTeam) {
      currentTeam = d.teamName;
      teamRow = `<tr style="background:#e8f5e9"><td colspan="9" style="font-weight:700;color:var(--primary);padding:.3rem .6rem;font-size:.82rem">${currentTeam || '—'}</td></tr>`;
    }
    return teamRow + `<tr style="${isActive ? 'background:#fffde7' : 'background:#ffebee'}">
      <td class="sh-cell sh-center sh-sno sh-freeze sh-f0">${i + 1}</td>
      <td class="sh-cell sh-name sh-freeze sh-f1">${d.name}${nameTags(d)}</td>
      <td class="sh-cell sh-center">${d.mobile || '—'}</td>
      <td class="sh-cell sh-ref">${d.referenceBy || ''}</td>
      <td class="sh-cell sh-center">${d.chantingRounds || 0}</td>
      <td class="sh-cell sh-center">${isActive ? '<span class="sh-active">Active</span>' : ''}</td>
      <td class="sh-cell">${d.teamName || ''}</td>
      <td class="sh-cell">${d.callingBy || ''}</td>
      <td class="sh-cell sh-center" style="${totalBg}">${total}</td>
    </tr>`;
  }).join('');

  return `<table class="attendance-sheet-table">
    <thead><tr>
      <th class="sh-header sh-sno sh-freeze sh-f0">Sno</th>
      <th class="sh-header sh-name sh-freeze sh-f1">Name</th>
      <th class="sh-header">Mobile</th>
      <th class="sh-header sh-ref">Reference</th>
      <th class="sh-header">CR</th>
      <th class="sh-header">Active</th>
      <th class="sh-header">Team</th>
      <th class="sh-header">Calling By</th>
      <th class="sh-header sh-total">Total AT</th>
    </tr></thead>
    <tbody>${bodyRows}</tbody>
  </table>`;
}

// Full CS+AT grid (Reports → Yearly Sheet tab)
function buildFullSheetTable(devotees, sessions, attMap, csMap, teamFilter, attTimeMap) {
  let rows = [...devotees];
  if (teamFilter) rows = rows.filter(d => d.teamName === teamFilter);
  rows.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  // Per-session columns: CS | AT | Time (3 cols). When attTimeMap is missing
  // (legacy callers), fall back to 2 cols (CS | AT) so older code paths still work.
  const showTime = !!attTimeMap;
  const sessSpan = showTime ? 3 : 2;

  let h1 = `<th rowspan="2" class="sh-header sh-sno sh-freeze sh-f0">Sno</th>
    <th rowspan="2" class="sh-header sh-name sh-freeze sh-f1">Name</th>
    <th rowspan="2" class="sh-header">Mobile</th>
    <th rowspan="2" class="sh-header sh-ref">Reference</th>
    <th rowspan="2" class="sh-header">CR</th>
    <th rowspan="2" class="sh-header">Active</th>
    <th rowspan="2" class="sh-header">Team</th>
    <th rowspan="2" class="sh-header">Calling By</th>`;
  sessions.forEach(s => {
    const cls = s.isCancelled ? 'sh-header sh-cancelled' : 'sh-header';
    const dateLabel = sheetFmtDate(s.sessionDate);
    const topicLine = s.topic ? `<small>${s.topic.length > 18 ? s.topic.slice(0, 18) + '…' : s.topic}</small>` : '';
    const cancelLine = s.isCancelled ? `<small>CANCELLED</small>` : '';
    h1 += `<th colspan="${sessSpan}" class="${cls}">${dateLabel}${topicLine}${cancelLine}</th>`;
  });
  h1 += `<th rowspan="2" class="sh-header sh-total">TOTAL</th>`;

  let h2 = '';
  sessions.forEach(s => {
    const sat = sheetFmtShort(shiftDateDay(s.sessionDate, -1));
    const sun = sheetFmtShort(s.sessionDate);
    h2 += `<th class="sh-sub-header">CS<small>${sat}</small></th><th class="sh-sub-header">AT<small>${sun}</small></th>`;
    if (showTime) h2 += `<th class="sh-sub-header">Time</th>`;
  });

  const fmtTime = iso => {
    if (!iso) return '';
    return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  };

  const bodyRows = rows.map((d, i) => {
    const isActive = d.isActive !== false;
    let cells = `<td class="sh-cell sh-center sh-sno sh-freeze sh-f0">${i + 1}</td>
      <td class="sh-cell sh-name sh-freeze sh-f1">${d.name}${nameTags(d)}</td>
      <td class="sh-cell sh-center">${d.mobile || '—'}</td>
      <td class="sh-cell sh-ref">${d.referenceBy || ''}</td>
      <td class="sh-cell sh-center">${d.chantingRounds || 0}</td>
      <td class="sh-cell sh-center">${isActive ? '<span class="sh-active">Active</span>' : ''}</td>
      <td class="sh-cell">${d.teamName || ''}</td>
      <td class="sh-cell">${d.callingBy || ''}</td>`;
    sessions.forEach(s => {
      if (s.isCancelled) {
        cells += `<td colspan="${sessSpan}" class="sh-cell sh-cancelled-cell sh-center">—</td>`;
      } else {
        const cs = csMap[s.sessionDate]?.[d.id] || null;
        const at = attMap[s.id]?.has(d.id) || false;
        const markedAtISO = showTime ? (attTimeMap[s.id]?.[d.id] || null) : null;
        const label = csLabel(cs);
        const safeTitle = label.replace(/"/g, '&quot;');
        const html = label.replace(/\n/g, '<br>');
        cells += `<td class="sh-cell sh-cs-cell" style="${csColor(cs)}" title="${safeTitle}">${html}</td>`;
        cells += `<td class="sh-cell sh-center" style="${at ? 'background:#a5d6a7;font-weight:700' : ''}">${at ? 'P' : ''}</td>`;
        if (showTime) {
          // Style the Time cell using the existing late-arrival color scale
          const tStyle = (typeof attTimeStyle === 'function' && markedAtISO) ? attTimeStyle(markedAtISO).card : '';
          cells += `<td class="sh-cell sh-center" style="${tStyle};font-size:.7rem;white-space:nowrap">${fmtTime(markedAtISO)}</td>`;
        }
      }
    });
    const total = d.lifetimeAttendance || 0;
    const totalBg = total >= 30 ? 'background:#b2ebf2;font-weight:700' : total >= 15 ? 'background:#c8e6c9;font-weight:600' : total >= 5 ? 'background:#fff9c4' : '';
    cells += `<td class="sh-cell sh-center" style="${totalBg}">${total}</td>`;
    return `<tr style="${isActive ? 'background:#fffde7' : 'background:#ffebee'}">${cells}</tr>`;
  }).join('');

  return `<table class="attendance-sheet-table">
    <thead><tr>${h1}</tr><tr>${h2}</tr></thead>
    <tbody>${bodyRows}</tbody>
  </table>`;
}

function shiftDateDay(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
}
function sheetFmtDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${d} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m - 1]} ${y.slice(-2)}`;
}
function sheetFmtShort(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y.slice(-2)}`;
}
function sheetFmtDDMMYY(dateStr) {
  return sheetFmtShort(dateStr);
}
function sheetFmtShortMonth(dateStr) {
  if (!dateStr) return '';
  const [, m, d] = dateStr.split('-');
  return `${+d} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m - 1]}`;
}
// Full reason labels (long-form). Used everywhere on the attendance sheet —
// the cells wrap so the entire text is visible. Hover also shows the same
// text via a title tooltip.
const _CS_REASON_LABELS = {
  did_not_pick:        'Did not pick call',
  incoming_na:         'Incoming not available',
  wrong_number:        'Wrong number',
  online_class:        'Shifted to online class',
  out_of_service:      'Temporarily out of service',
  out_of_station:      'Out of station',
  exams:               'Exams',
  festival_calling:    'Festival Calling',
  not_interested_now:  'Not Interested (this week)',
};
// status can be a legacy string ("Yes"/"Not Interested") OR an object
// { comingStatus, callingReason, callingNotes, availableFrom }.
// Returns the FULL status string — the user explicitly wants the long form.
function csLabel(status) {
  if (!status) return '';
  if (typeof status === 'string') {
    if (status === 'Yes') return 'Confirmed Coming';
    return status;
  }
  let main = '';
  if (status.comingStatus === 'Yes')      main = 'Confirmed Coming';
  else if (status.callingReason)          main = _CS_REASON_LABELS[status.callingReason] || status.callingReason;
  else if (status.comingStatus)           main = status.comingStatus;
  if (!main && !status.callingNotes)      return '';
  // Append availability date for "out of station" / "exams"
  if (status.availableFrom) {
    const af = (typeof formatDate === 'function') ? formatDate(status.availableFrom) : status.availableFrom;
    main = main ? `${main} · from ${af}` : `from ${af}`;
  }
  // Append the caller's notes verbatim
  if (status.callingNotes) {
    main = main ? `${main}\n"${status.callingNotes}"` : `"${status.callingNotes}"`;
  }
  // Late remarks (post-attendance follow-up note)
  if (status.lateRemarks) {
    main = main ? `${main}\nLate: "${status.lateRemarks}"` : `Late: "${status.lateRemarks}"`;
  }
  // Did-not-pick follow-up (tries / texted)
  const follow = [];
  if (status.triesCount) follow.push(`${status.triesCount} tr${status.triesCount === 1 ? 'y' : 'ies'}`);
  if (status.texted === 'Yes' || status.texted === true) follow.push('texted');
  if (follow.length) main = main ? `${main}\n(${follow.join(', ')})` : `(${follow.join(', ')})`;
  return main;
}
function csColor(status) {
  if (!status) return '';
  // Convert object form to comingStatus for legacy color map below
  if (typeof status === 'object') {
    if (status.comingStatus === 'Yes') return 'background:#c8e6c9';
    const r = status.callingReason;
    if (r === 'online_class')        return 'background:#bbdefb';
    if (r === 'festival_calling')    return 'background:#fff9c4';
    if (r === 'not_interested_now')  return 'background:#ffcdd2';
    if (r)                           return 'background:#ffe0b2';
    return '';
  }
  if (status === 'Yes')            return 'background:#c8e6c9';
  if (status === 'Not Interested') return 'background:#ffccbc';
  return 'background:#ffcdd2';
}
function csEntryText(entry) {
  if (!entry) return '';
  if (entry.status === 'Yes') return entry.notes ? `Coming — ${entry.notes}` : 'Coming';
  const reasonLbl = _reasonLabel(entry.reason || '');
  const avail = entry.availableFrom ? ` (from ${entry.availableFrom})` : '';
  const parts = [reasonLbl + avail, entry.notes].filter(Boolean);
  return parts.join(' | ');
}
function csEntryBg(entry) {
  if (!entry?.status) return null;
  if (entry.status === 'Yes') return 'C8E6C9';
  if (entry.reason === 'online_class') return 'E3F2FD';
  if (['out_of_station','exams'].includes(entry.reason)) return 'EDE7F6';
  if (entry.reason) return 'FFCDD2';
  return 'FFF9C4';
}

// ── LIVE SESSION ATTENDANCE ───────────────────────────
let _attTabInFlight = false;
async function loadAttendanceTab() {
  if (_attTabInFlight) return;
  _attTabInFlight = true;
  try {
    const filterDate = AppState.filters?.sessionId;   // date string e.g. '2026-05-31'
    const currentId  = AppState.currentSessionId;      // doc ID or date string or null

    console.log('[Attendance] loadAttendanceTab — currentSessionId:', currentId, '| filterDate:', filterDate);

    if (!currentId && !filterDate) {
      await initSession();
      return;
    }

    // Resolve to actual Firestore doc ID via the sessions collection
    let sessionDocId = currentId;
    if (!sessionDocId || sessionDocId === filterDate) {
      // currentId is null or is a date string — look up the actual doc
      const snap = await fdb.collection('sessions')
        .where('sessionDate', '==', filterDate || currentId).limit(1).get();
      if (!snap.empty) {
        sessionDocId = snap.docs[0].id;
        // Update AppState so future calls also use the correct doc ID
        AppState._currentSessionId = sessionDocId;
        console.log('[Attendance] resolved session doc ID:', sessionDocId);
      } else {
        await initSession();
        return;
      }
    }

    await loadAttendanceSession(sessionDocId);
  } finally {
    _attTabInFlight = false;
  }
}

async function loadAttendanceSession(sessionId) {
  if (!sessionId) return;
  AppState.currentSessionId = sessionId;
  const s = AppState.sessionsCache[sessionId];
  if (s?.session_date) _setSessionDateDisplay(s.session_date);
  showSessionInfo(sessionId);
  await Promise.all([updateAttendanceStats(), loadAttendanceCandidates()]);
}

async function updateAttendanceStats() {
  if (!AppState.currentSessionId) return;
  try {
    const s = await DB.getSessionStats(AppState.currentSessionId);
    document.getElementById('stat-confirmed').textContent = s.confirmed;
    document.getElementById('stat-present').textContent   = s.present;
    document.getElementById('stat-new').textContent       = s.newDevotees;
    document.getElementById('stat-total').textContent     = s.totalPresent;
  } catch (e) {
    console.error('[updateAttendanceStats] failed — sessionId:', AppState.currentSessionId, e);
    // Don't leave stale zeros — show a dash so user knows data failed to load
    ['stat-confirmed','stat-present','stat-new','stat-total'].forEach(id => {
      const el = document.getElementById(id);
      if (el && el.textContent === '0') el.textContent = '—';
    });
  }
}

// Opens a modal showing the devotee list behind each attendance stat card
async function openAttendanceStatList(type) {
  if (!AppState.currentSessionId) { showToast('No session selected', 'error'); return; }

  const titles = {
    confirmed: '✅ Total Confirmed (Said Coming)',
    present:   '✅ Present (Regular Attendees)',
    new:       '🌱 New Devotees',
    total:     '👥 Total Present (All)',
  };

  // Build modal immediately with loading state
  let overlay = document.getElementById('_att-stat-modal');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = '_att-stat-modal';
  overlay.className = 'modal-overlay modal-centered';
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.innerHTML = `
    <div class="modal-box" style="max-width:520px;width:95vw;max-height:82vh;display:flex;flex-direction:column;overflow:hidden">
      <div class="modal-header" style="flex-shrink:0">
        <h2 style="font-size:.95rem">${titles[type] || type}</h2>
        <button class="btn-icon close" onclick="document.getElementById('_att-stat-modal')?.remove()">
          <i class="fas fa-times"></i>
        </button>
      </div>
      <div id="_att-stat-body" style="overflow:auto;flex:1;padding:.5rem .75rem .75rem;-webkit-overflow-scrolling:touch">
        <div class="loading"><i class="fas fa-spinner"></i> Loading…</div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  try {
    const sessionId = AppState.currentSessionId;
    const [atSnap, allDevotees] = await Promise.all([
      fdb.collection('attendanceRecords').where('sessionId', '==', sessionId).get(),
      DevoteeCache.all(),
    ]);
    const devMap = Object.fromEntries(allDevotees.map(d => [d.id, d]));

    // Also fetch calling status to know who said Yes (for color coding)
    const sessSnap2 = await fdb.collection('sessions').doc(sessionId).get();
    const sessionDate2 = sessSnap2.data()?.sessionDate || '';
    const cfg2 = await DB.getCallingWeekConfig();
    const weekDate2 = (cfg2?.sessionDate === sessionDate2) ? (cfg2.callingDate || sessionDate2) : (() => {
      const d2 = new Date(sessionDate2 + 'T00:00:00'); d2.setDate(d2.getDate()-1);
      return `${d2.getFullYear()}-${String(d2.getMonth()+1).padStart(2,'0')}-${String(d2.getDate()).padStart(2,'0')}`;
    })();
    const csSnap2 = await fdb.collection('callingStatus').where('weekDate','==',weekDate2).get();
    const callingStatusMap = {};
    csSnap2.docs.forEach(d => { callingStatusMap[d.data().devoteeId] = d.data().comingStatus; });

    // Helper to safely parse Firestore Timestamp or ISO string
    const toDate = ts => {
      if (!ts) return null;
      if (ts.toDate) return ts.toDate();   // Firestore Timestamp
      const d = new Date(ts);
      return isNaN(d.getTime()) ? null : d;
    };

    let list;
    if (type === 'total' || type === 'present' || type === 'new') {
      const records = atSnap.docs.map(d => ({ ...d.data(), id: d.id }));
      list = records
        .filter(r => type === 'total' ? true : type === 'new' ? r.isNewDevotee : !r.isNewDevotee)
        .map(r => {
          const d = devMap[r.devoteeId] || {};
          const calStatus = callingStatusMap[r.devoteeId];
          // saidYes = confirmed before session; surprisePresent = came without confirming
          const saidYes = calStatus === 'Yes';
          const surprisePresent = !calStatus || (calStatus !== 'Yes');
          return {
            id: r.devoteeId, name: d.name || r.devoteeName || '—',
            mobile: d.mobile || '', teamName: d.teamName || '',
            markedAt: r.markedAt || '', saidYes, surprisePresent: surprisePresent && !r.isNewDevotee,
          };
        })
        .sort((a, b) => (a.teamName||'').localeCompare(b.teamName||'') || a.name.localeCompare(b.name));
    } else {
      // confirmed — fetch from callingStatus
      const sessSnap = await fdb.collection('sessions').doc(sessionId).get();
      const sessionDate = sessSnap.data()?.sessionDate || '';
      const cfg = await DB.getCallingWeekConfig();
      const weekDate = (cfg?.sessionDate === sessionDate) ? (cfg.callingDate || sessionDate) : (() => {
        const d = new Date(sessionDate + 'T00:00:00'); d.setDate(d.getDate()-1);
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      })();
      const csSnap = await fdb.collection('callingStatus').where('weekDate','==',weekDate).where('comingStatus','==','Yes').get();
      list = csSnap.docs.map(d => {
        const dev = devMap[d.data().devoteeId] || {};
        return { id: d.data().devoteeId, name: dev.name || '—', mobile: dev.mobile || '', teamName: dev.teamName || '' };
      }).sort((a,b) => (a.teamName||'').localeCompare(b.teamName||'') || a.name.localeCompare(b.name));
    }

    const HDR  = '#dbeafe';
    const SEP  = 'border-right:2px solid #94a3b8';
    const SNO  = 30;   // # col px
    const NM   = 130;  // Name col min-width px
    const fmtTime = ts => {
      const d = toDate(ts);
      return d ? d.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:true}) : '—';
    };
    const TH_BASE = `position:sticky;top:0;z-index:3;background:${HDR};color:#1a1a1a;font-weight:800;font-size:.75rem;padding:.42rem .5rem;border-bottom:2px solid #93c5fd`;
    const TH_SNO  = `${TH_BASE};left:0;z-index:5;width:${SNO}px;min-width:${SNO}px;text-align:center`;
    const TH_NAME = `${TH_BASE};left:${SNO}px;z-index:5;min-width:${NM}px;${SEP}`;

    document.getElementById('_att-stat-body').innerHTML = list.length ? `
      <div style="font-size:.8rem;color:#64748b;margin-bottom:.5rem;font-weight:600">
        <i class="fas fa-users" style="color:#3b82f6;margin-right:.3rem"></i><strong>${list.length}</strong> devotees
      </div>
      <div style="overflow:auto;border-radius:6px;border:1px solid #e2e8f0">
        <table style="width:max-content;min-width:100%;border-collapse:separate;border-spacing:0;font-size:.8rem">
          <thead><tr>
            <th style="${TH_SNO}">#</th>
            <th style="${TH_NAME}">Name</th>
            <th style="${TH_BASE};min-width:88px">Mobile</th>
            <th style="${TH_BASE};min-width:88px">Team</th>
            ${type !== 'confirmed' ? `<th style="${TH_BASE};min-width:64px;text-align:center">Time</th>` : ''}
          </tr></thead>
          <tbody>
            ${list.map((d,i) => {
              const showBadge = type === 'total' || type === 'present';
              const baseRowBg = showBadge
                ? (d.saidYes ? '#f0fdf4' : d.surprisePresent ? '#fff1f0' : (i%2===0?'#fff':'#f1f5f9'))
                : (i%2===0?'#fff':'#f1f5f9');
              const stickyBg = baseRowBg;
              const badge = showBadge
                ? (d.saidYes
                    ? `<span style="font-size:.62rem;font-weight:700;color:#15803d;background:#dcfce7;padding:.05rem .3rem;border-radius:4px;margin-left:.3rem;white-space:nowrap">Said Yes ✓</span>`
                    : d.surprisePresent
                      ? `<span style="font-size:.62rem;font-weight:700;color:#b91c1c;background:#fee2e2;padding:.05rem .3rem;border-radius:4px;margin-left:.3rem;white-space:nowrap">Surprise</span>`
                      : '')
                : '';
              const border = 'border-bottom:1px solid #e2e8f0';
              return `<tr style="background:${baseRowBg}">
                <td style="position:sticky;left:0;z-index:2;background:${stickyBg};width:${SNO}px;min-width:${SNO}px;${border};padding:.35rem .38rem;text-align:center;color:#94a3b8;font-size:.72rem">${i+1}</td>
                <td style="position:sticky;left:${SNO}px;z-index:2;background:${stickyBg};min-width:${NM}px;white-space:nowrap;${SEP};${border};padding:.35rem .5rem;font-weight:700;color:#0d2d5a;cursor:pointer"
                    onclick="openProfileModal('${d.id}')">${d.name}${badge}</td>
                <td style="${border};padding:.35rem .5rem;color:#374151;white-space:nowrap">${d.mobile||'—'}</td>
                <td style="${border};padding:.35rem .5rem;font-size:.75rem;white-space:nowrap">${d.teamName||'—'}</td>
                ${type !== 'confirmed' ? `<td style="${border};padding:.35rem .45rem;text-align:center;font-size:.72rem;color:#64748b;white-space:nowrap">${fmtTime(d.markedAt)}</td>` : ''}
              </tr>`;}).join('')}
          </tbody>
        </table>
      </div>`
      : `<div class="empty-state"><i class="fas fa-check-circle" style="color:#16a34a"></i><p>No devotees in this category</p></div>`;
  } catch (e) {
    document.getElementById('_att-stat-body').innerHTML = '<div class="empty-state"><p>Failed to load</p></div>';
    console.error('openAttendanceStatList', e);
  }
}
window.openAttendanceStatList = openAttendanceStatList;

async function loadAttendanceCandidates() {
  if (!AppState.currentSessionId) return;
  const search = document.getElementById('attendance-search').value.trim();
  const list   = document.getElementById('attendance-list');
  list.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';
  try {
    let candidates = await DB.getAttendanceCandidates(AppState.currentSessionId, search);
    const isServiceDev = AppState.userRole === 'serviceDevotee';
    // Past-session gate: only super admins + users with explicit
    // canBackDateAttendance flag (set in User Management) can mark / undo
    // attendance on any date other than today.
    const sessDate  = AppState.sessionsCache?.[AppState.currentSessionId]?.session_date || '';
    const todayStr  = (typeof getToday === 'function') ? getToday()
                       : (() => { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();
    const isPast    = !!sessDate && sessDate < todayStr;
    const canBackdate = AppState.userRole === 'superAdmin' || !!AppState.canBackDateAttendance;
    const sessionLocked = isPast && !canBackdate;
    AppState.attendanceCandidates = {};
    candidates.forEach(d => { AppState.attendanceCandidates[d.id] = d; });
    if (!candidates.length) {
      list.innerHTML = search
        ? `<div class="empty-state"><i class="fas fa-search"></i><p>No result for "${search}"</p></div>`
        : '<div class="empty-state"><i class="fas fa-users"></i><p>No candidates for this session</p></div>';
      return;
    }
    const lockBanner = sessionLocked ? `
      <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:.55rem .8rem;margin-bottom:.6rem;font-size:.82rem;color:#9a3412;display:flex;align-items:center;gap:.5rem">
        <i class="fas fa-lock"></i>
        <span><strong>Past session — read only.</strong> Ask a super admin for the <em>Back-date Attendance</em> permission to mark this session.</span>
      </div>` : '';
    list.innerHTML = lockBanner + candidates.map((d, idx) => {
      const isPresent = !!d.attendance_id;
      const canEdit   = (!isServiceDev || isPresent) && !sessionLocked;
      const ts        = attTimeStyle(d.marked_at);
      const cardStyle = isPresent && ts.card ? ts.card : '';
      const timeLabel = isPresent && d.marked_at
        ? ` <span style="font-size:.7rem;opacity:.85">${new Date(d.marked_at).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:true})}</span>` : '';
      return `
        <div class="attendance-card${isPresent ? ' is-present' : ''}" id="att-card-${d.id}"
             style="${cardStyle}${canEdit ? ';cursor:pointer' : ''}"
             ${canEdit ? `onclick="openProfileModal('${d.id}')"` : ''}>
          <div class="devotee-avatar" style="width:40px;height:40px;font-size:.9rem">${initials(d.name)}</div>
          <div class="attendance-card-info">
            <div class="attendance-card-name">${d.name}${nameTags(d)}
              ${isBirthdayWeek(d.dob) ? '<i class="fas fa-birthday-cake" style="color:var(--gold);margin-left:.3rem"></i>' : ''}
              ${d.coming_status === 'Yes' ? '<span class="badge badge-expected" style="font-size:.7rem">Confirmed</span>' : ''}
            </div>
            ${d.mobile ? `<div class="att-mobile" onclick="event.stopPropagation()">${contactIcons(d.mobile)}<span class="att-mobile-num">${d.mobile}</span></div>` : ''}
            <div class="attendance-card-meta">${d.reference_by ? '<span style="color:var(--brand-mid)">Ref: ' + d.reference_by + '</span> · ' : ''}${d.team_name || ''}${d.calling_by ? ' · Called: ' + d.calling_by : ''}</div>
          </div>
          <div onclick="event.stopPropagation()">
            ${isPresent
              ? `<span style="font-weight:700;font-size:.85rem;${ts.card.includes('c62828') ? 'color:#fff' : 'color:var(--success)'}"><i class="fas fa-check-circle"></i> P${timeLabel}</span>
                 ${sessionLocked ? '' : `<button class="undo-btn" onclick="undoPresent('${d.id}')">Undo</button>`}`
              : (sessionLocked
                  ? '<span style="color:var(--text-muted);font-size:.78rem">—</span>'
                  : `<button class="present-btn" onclick="markPresent('${d.id}', false)">PRESENT</button>`)}
          </div>
        </div>`;
    }).join('');
  } catch (_) {
    list.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load</p></div>';
  }
}

// ── CONNECTING × PRESENT — quick view ───────────────────────────────────────
// Shows present devotees who have a logged interaction at a chosen level.
const _CP_LEVELS = {
  0: { label: 'All Levels',                   abbr: 'All',        color: '#0d2d5a', bg: '#eef3fb' },
  1: { label: 'HG Ram Atirapriya Prabhuji',   abbr: 'L1 · Prabhuji', color: '#7c3aed', bg: '#f5f3ff' },
  2: { label: 'HG Sulakshana Sita Mataji',    abbr: 'L2 · Mataji',   color: '#0369a1', bg: '#eff6ff' },
  3: { label: 'Naveena (Senior)',              abbr: 'L3 · Senior',   color: '#0f766e', bg: '#f0fdfa' },
  4: { label: 'Team Coordinator',             abbr: 'L4 · Coord',    color: '#0d2d5a', bg: '#eef3fb' },
};
let _cpLevelFilter = 0;  // 0 = all levels

async function openConnectingPresent() {
  if (!AppState.currentSessionId) { showToast('No session selected', 'error'); return; }

  let overlay = document.getElementById('_cp-modal');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = '_cp-modal';
  overlay.className = 'modal-overlay';
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.innerHTML = `
    <div class="modal-box" style="max-width:580px;width:96vw">
      <div class="modal-header">
        <h2 style="font-size:.95rem"><i class="fas fa-link"></i> Connected & Present Today</h2>
        <button class="btn-icon close" onclick="document.getElementById('_cp-modal')?.remove()"><i class="fas fa-times"></i></button>
      </div>
      <div style="padding:.6rem 1rem 0">
        <div style="font-size:.75rem;color:#64748b;margin-bottom:.5rem">Filter by level — Connected with whom?</div>
        <div id="_cp-filters" style="display:flex;flex-wrap:wrap;gap:.35rem;margin-bottom:.75rem">
          ${Object.entries(_CP_LEVELS).map(([lv, l]) => `
            <button onclick="setConnectingPresentFilter(${lv})"
              id="_cp-btn-${lv}"
              style="padding:.3rem .75rem;border-radius:99px;border:1.5px solid ${parseInt(lv)===_cpLevelFilter?l.color:'#e2e8f0'};
                     background:${parseInt(lv)===_cpLevelFilter?l.color:'#fff'};
                     color:${parseInt(lv)===_cpLevelFilter?'#fff':l.color};
                     font-weight:700;font-size:.75rem;cursor:pointer;transition:.15s">
              ${l.abbr}
            </button>`).join('')}
        </div>
      </div>
      <div id="_cp-body" style="overflow:auto;max-height:60vh;padding:.25rem 1rem 1rem">
        <div class="loading"><i class="fas fa-spinner"></i> Loading…</div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  _cpLevelFilter = 0;
  await _renderConnectingPresent();
}
window.openConnectingPresent = openConnectingPresent;

async function setConnectingPresentFilter(level) {
  _cpLevelFilter = parseInt(level);
  // Update button styles
  Object.entries(_CP_LEVELS).forEach(([lv, l]) => {
    const btn = document.getElementById('_cp-btn-' + lv);
    if (!btn) return;
    const active = parseInt(lv) === _cpLevelFilter;
    btn.style.background    = active ? l.color : '#fff';
    btn.style.color         = active ? '#fff'  : l.color;
    btn.style.borderColor   = active ? l.color : '#e2e8f0';
  });
  await _renderConnectingPresent();
}
window.setConnectingPresentFilter = setConnectingPresentFilter;

async function _renderConnectingPresent() {
  const body = document.getElementById('_cp-body');
  if (!body) return;
  body.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';
  try {
    // Resolve actual Firestore session doc ID (currentSessionId may be a date string)
    let sessionDocId = AppState.currentSessionId;
    const filterDate = AppState.filters?.sessionId;
    if (!sessionDocId || sessionDocId === filterDate) {
      const sSnap = await fdb.collection('sessions')
        .where('sessionDate', '==', filterDate || sessionDocId).limit(1).get();
      if (!sSnap.empty) sessionDocId = sSnap.docs[0].id;
    }

    // 1. Who is present today?
    const atSnap = await fdb.collection('attendanceRecords')
      .where('sessionId', '==', sessionDocId).get();
    const presentIds = new Set(atSnap.docs.map(d => d.data().devoteeId));

    if (!presentIds.size) {
      body.innerHTML = '<div class="empty-state"><i class="fas fa-users" style="font-size:2rem;color:#cbd5e1;margin-bottom:.5rem"></i><p>No one marked present yet in this session</p></div>';
      return;
    }

    // 2. Fetch interactions from BOTH sources:
    //    a) personalMeetings (existing) — Level 1 meetings with Prabhuji
    //    b) interactions (new) — all 4 levels
    let interactions = [];

    // Source A: personalMeetings → treat completed ones as Level 1
    try {
      const pmSnap = await fdb.collection('personalMeetings')
        .where('status', '==', 'completed').get();
      pmSnap.docs.forEach(d => {
        const m = d.data();
        if (m.devoteeId) {
          interactions.push({
            devoteeId: m.devoteeId,
            level:     1,
            type:      'meet',
            by:        m.metBy || m.createdBy || '',
            atClient:  m.completedDate ? m.completedDate + 'T00:00:00' : (m.updatedAt?.toDate?.()?.toISOString() || ''),
            notes:     m.notes || '',
          });
        }
      });
    } catch (e) { console.warn('personalMeetings fetch failed:', e.message); }

    // Source B: new interactions collection (all 4 levels)
    try {
      const ixSnap = await fdb.collection('interactions').limit(500).get();
      ixSnap.docs.forEach(d => interactions.push({ id: d.id, ...d.data() }));
    } catch (e) { console.warn('interactions fetch failed (rules may not be deployed):', e.message); }

    // Also include any devotee with metPrabhuji flag (even if not in personalMeetings)
    const allDevoteesForFlags = await DevoteeCache.all();
    allDevoteesForFlags.filter(d => d.metPrabhuji && presentIds.has(d.id)).forEach(d => {
      const alreadyHasL1 = interactions.some(ix => ix.devoteeId === d.id && ix.level === 1);
      if (!alreadyHasL1) {
        interactions.push({ devoteeId: d.id, level: 1, type: 'meet', by: 'Prabhuji', atClient: '' });
      }
    });

    // Build map: devoteeId → list of interactions
    const devInteractions = {};
    interactions
      .filter(ix => presentIds.has(ix.devoteeId))
      .filter(ix => _cpLevelFilter === 0 || ix.level === _cpLevelFilter)
      .forEach(ix => {
        if (!devInteractions[ix.devoteeId]) devInteractions[ix.devoteeId] = [];
        devInteractions[ix.devoteeId].push(ix);
      });

    const allDevotees = await DevoteeCache.all();
    const devMap = Object.fromEntries(allDevotees.map(d => [d.id, d]));

    const connectedPresent = Object.entries(devInteractions)
      .map(([devId, ixList]) => {
        const d = devMap[devId] || {};
        // Most recent interaction
        const latest = ixList.sort((a, b) => (b.atClient||'').localeCompare(a.atClient||''))[0];
        const levelsDone = [...new Set(ixList.map(ix => ix.level))].sort();
        return { id: devId, name: d.name || '—', team: d.teamName || '—', mobile: d.mobile || '',
                 latest, levelsDone, totalInteractions: ixList.length };
      })
      .sort((a, b) => b.totalInteractions - a.totalInteractions);

    const levelName = l => _CP_LEVELS[l]?.abbr || `L${l}`;
    const fmtDate  = iso => iso ? new Date(iso).toLocaleDateString('en-IN', { day:'numeric', month:'short' }) : '—';
    const TYPE_ICONS = { call: '📞', meet: '🤝', 'parent-meet': '👨‍👩' };

    const TH = `style="padding:.4rem .55rem;background:#0d2d5a;color:#fff;font-weight:700;font-size:.78rem"`;

    if (!connectedPresent.length) {
      body.innerHTML = `<div class="empty-state">
        <i class="fas fa-link" style="font-size:2rem;color:#cbd5e1;margin-bottom:.5rem"></i>
        <p>No present devotees have a recorded interaction at this level yet.</p>
        <p style="font-size:.8rem;color:#94a3b8;margin-top:.3rem">Log interactions via Connecting → My Log → Log Interaction.</p>
      </div>`;
      return;
    }

    body.innerHTML = `
      <div style="font-size:.8rem;color:#64748b;margin-bottom:.6rem">
        <strong style="color:#0d2d5a">${connectedPresent.length}</strong> present devotees connected
        ${_cpLevelFilter > 0 ? `with <strong>${_CP_LEVELS[_cpLevelFilter]?.label}</strong>` : 'across all levels'}
      </div>
      <div class="table-scroll">
        <table style="width:100%;border-collapse:collapse;border:2px solid #000;font-size:.82rem">
          <thead><tr>
            <th ${TH} style="text-align:center;width:2rem">#</th>
            <th ${TH}>Name</th>
            <th ${TH};min-width:100px">Team</th>
            <th ${TH} style="text-align:center">Levels</th>
            <th ${TH}>Last Interaction</th>
          </tr></thead>
          <tbody>
            ${connectedPresent.map((d, i) => {
              const lat = d.latest;
              const typeIcon = TYPE_ICONS[lat?.type] || '💬';
              const lv = _CP_LEVELS[lat?.level] || _CP_LEVELS[4];
              return `<tr style="${i%2===0?'background:#fff':'background:#f5f7fa'}">
                <td style="padding:.38rem .5rem;border:1px solid #d1d5db;text-align:center;color:#94a3b8;font-size:.75rem">${i+1}</td>
                <td style="padding:.38rem .55rem;border:1px solid #d1d5db;font-weight:700;cursor:pointer;color:#0d2d5a"
                    onclick="openProfileModal('${d.id}')">${d.name}</td>
                <td style="padding:.38rem .55rem;border:1px solid #d1d5db;font-size:.78rem;white-space:nowrap">${d.team}</td>
                <td style="padding:.38rem .5rem;border:1px solid #d1d5db;text-align:center">
                  ${d.levelsDone.map(lv => `<span style="font-size:.65rem;font-weight:700;color:${_CP_LEVELS[lv]?.color||'#374151'};background:${_CP_LEVELS[lv]?.bg||'#f5f7fa'};padding:.1rem .3rem;border-radius:4px;margin:.05rem;display:inline-block">${_CP_LEVELS[lv]?.abbr||('L'+lv)}</span>`).join('')}
                </td>
                <td style="padding:.38rem .55rem;border:1px solid #d1d5db;font-size:.75rem;color:#374151">
                  <span style="background:${lv.bg};color:${lv.color};padding:.1rem .3rem;border-radius:4px;font-weight:700;font-size:.65rem">${lv.abbr}</span>
                  ${typeIcon} ${fmtDate(lat?.atClient)}
                  ${lat?.by ? `<div style="color:#94a3b8;font-size:.68rem">by ${lat.by}</div>` : ''}
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  } catch (e) {
    if (body) body.innerHTML = '<div class="empty-state"><p>Failed to load</p></div>';
    console.error('_renderConnectingPresent', e);
  }
}

function _attBackdateBlocked() {
  const sd = AppState.sessionsCache?.[AppState.currentSessionId]?.session_date || '';
  const today = (typeof getToday === 'function') ? getToday()
    : (() => { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();
  const isPast = !!sd && sd < today;
  const canBackdate = AppState.userRole === 'superAdmin' || !!AppState.canBackDateAttendance;
  return isPast && !canBackdate;
}

async function markPresent(devoteeId, isNew = false) {
  if (!AppState.currentSessionId) return showToast('No session active', 'error');
  if (_attBackdateBlocked()) return showToast('Past session — back-date permission required', 'error');
  const devotee = AppState.attendanceCandidates[devoteeId];
  if (!devotee) return showToast('Devotee not found', 'error');
  try {
    await DB.markPresent(AppState.currentSessionId, devotee, isNew);
    await updateAttendanceStats();
    if (AppState.currentTab === 'attendance') loadAttendanceCandidates();
    showToast('Marked Present! Hare Krishna 🙏', 'success');
  } catch (e) {
    if (e.status === 409) showToast('Already marked present', 'error');
    else showToast('Error marking present', 'error');
  }
}

async function undoPresent(devoteeId) {
  if (!AppState.currentSessionId) return;
  if (_attBackdateBlocked()) return showToast('Past session — back-date permission required', 'error');
  if (!confirm('Remove attendance for this devotee?')) return;
  try {
    await DB.undoPresent(AppState.currentSessionId, devoteeId);
    await updateAttendanceStats();
    loadAttendanceCandidates();
    showToast('Attendance removed');
  } catch (_) { showToast('Error', 'error'); }
}

