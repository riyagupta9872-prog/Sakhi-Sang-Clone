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
      <td class="sh-cell sh-name sh-freeze sh-f1">${d.name}</td>
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
      <td class="sh-cell sh-name sh-freeze sh-f1">${d.name}</td>
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
async function loadAttendanceTab() {
  if (!AppState.currentSessionId) await initSession();
  await loadAttendanceSession(AppState.currentSessionId);
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
    document.getElementById('stat-present').textContent = s.present;
    document.getElementById('stat-new').textContent     = s.newDevotees;
    document.getElementById('stat-total').textContent   = s.totalPresent;
  } catch (_) {}
}

async function loadAttendanceCandidates() {
  if (!AppState.currentSessionId) return;
  const search = document.getElementById('attendance-search').value.trim();
  const list   = document.getElementById('attendance-list');
  list.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';
  try {
    let candidates = await DB.getAttendanceCandidates(AppState.currentSessionId, search);
    const isServiceDev = AppState.userRole === 'serviceDevotee';
    // Only Att. Seva flagged users reach Live attendance — they always see ALL teams.
    AppState.attendanceCandidates = {};
    candidates.forEach(d => { AppState.attendanceCandidates[d.id] = d; });
    if (!candidates.length) {
      list.innerHTML = search
        ? `<div class="empty-state"><i class="fas fa-search"></i><p>No result for "${search}"</p></div>`
        : '<div class="empty-state"><i class="fas fa-users"></i><p>No candidates for this session</p></div>';
      return;
    }
    list.innerHTML = candidates.map((d, idx) => {
      const isPresent = !!d.attendance_id;
      const canEdit   = !isServiceDev || isPresent;
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
            <div class="attendance-card-name">${d.name}
              ${isBirthdayWeek(d.dob) ? '<i class="fas fa-birthday-cake" style="color:var(--gold);margin-left:.3rem"></i>' : ''}
              ${d.coming_status === 'Yes' ? '<span class="badge badge-expected" style="font-size:.7rem">Confirmed</span>' : ''}
            </div>
            ${d.mobile ? `<div class="att-mobile" onclick="event.stopPropagation()">${contactIcons(d.mobile)}<span class="att-mobile-num">${d.mobile}</span></div>` : ''}
            <div class="attendance-card-meta">${d.reference_by ? '<span style="color:var(--brand-mid)">Ref: ' + d.reference_by + '</span> · ' : ''}${d.team_name || ''}${d.calling_by ? ' · Called: ' + d.calling_by : ''}</div>
          </div>
          <div onclick="event.stopPropagation()">
            ${isPresent
              ? `<span style="font-weight:700;font-size:.85rem;${ts.card.includes('c62828') ? 'color:#fff' : 'color:var(--success)'}"><i class="fas fa-check-circle"></i> P${timeLabel}</span>
                 <button class="undo-btn" onclick="undoPresent('${d.id}')">Undo</button>`
              : `<button class="present-btn" onclick="markPresent('${d.id}', false)">PRESENT</button>`}
          </div>
        </div>`;
    }).join('');
  } catch (_) {
    list.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load</p></div>';
  }
}

async function markPresent(devoteeId, isNew = false) {
  if (!AppState.currentSessionId) return showToast('No session active', 'error');
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
  if (!confirm('Remove attendance for this devotee?')) return;
  try {
    await DB.undoPresent(AppState.currentSessionId, devoteeId);
    await updateAttendanceStats();
    loadAttendanceCandidates();
    showToast('Attendance removed');
  } catch (_) { showToast('Error', 'error'); }
}

