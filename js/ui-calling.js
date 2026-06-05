/* ══ UI-CALLING.JS – Calling status tab, reports, late tracking ══ */

let _callingActiveTab = 'list';
let _callingLocked = false;

function switchCallingTab(tab, btn) {
  // Legacy no-op: Calling tab now shows only the calling list.
  _callingActiveTab = 'list';
  loadCallingStatus();
}


async function loadNotInterestedList() {
  const wrap = document.getElementById('not-interested-list');
  wrap.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';
  try {
    const list = await DB.getNotInterestedDevotees();
    if (!list.length) {
      wrap.innerHTML = '<div class="empty-state"><i class="fas fa-ban"></i><p>No devotees marked as Not Interested</p></div>';
      return;
    }
    wrap.innerHTML = `<div class="calling-table-wrap"><table class="calling-table">
      <thead><tr>
        <th>#</th><th>Name</th><th>Mobile</th><th>Team</th>
        <th>Date of Joining</th><th>Moved Not Interested On</th>
        <th>C.R</th><th>Ref</th><th>Calling By</th>
      </tr></thead>
      <tbody>${list.map((d, i) => `<tr>
        <td style="color:var(--text-muted)">${i + 1}</td>
        <td><span style="font-weight:600">${d.name}</span></td>
        <td>${d.mobile || '—'}</td>
        <td>${teamBadge(d.team_name)}</td>
        <td>${formatDate(d.date_of_joining)}</td>
        <td>${d.not_interested_at ? formatDateTime(d.not_interested_at) : '—'}</td>
        <td>${d.chanting_rounds || 0}</td>
        <td>${d.reference_by || '—'}</td>
        <td>${d.calling_by || '—'}</td>
      </tr>`).join('')}
      </tbody>
    </table></div>`;
  } catch (e) {
    wrap.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load</p></div>';
  }
}

async function openTeamHistory(devoteeId, devoteeName, currentTeam) {
  const modal = document.getElementById('team-history-modal');
  if (!modal) return;
  document.getElementById('team-history-name').textContent = devoteeName;
  document.getElementById('team-history-content').innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';
  modal.classList.remove('hidden');
  try {
    const history = await DB.getTeamChangeHistory(devoteeId);
    if (!history.length) {
      document.getElementById('team-history-content').innerHTML =
        `<div style="text-align:center;padding:1rem;color:var(--text-muted)"><i class="fas fa-info-circle"></i> No team changes recorded.<br>Current team: ${teamBadge(currentTeam)}</div>`;
      return;
    }
    document.getElementById('team-history-content').innerHTML = `
      <div style="font-size:.8rem;color:var(--text-muted);margin-bottom:.5rem">Current: ${teamBadge(currentTeam)}</div>
      <table style="width:100%;border-collapse:collapse;font-size:.82rem">
        <thead><tr style="background:var(--primary);color:#fff">
          <th style="padding:.3rem .6rem;text-align:left">Date & Time</th>
          <th style="padding:.3rem .6rem;text-align:left">Changed By</th>
          <th style="padding:.3rem .6rem;text-align:left">From</th>
          <th style="padding:.3rem .6rem;text-align:left">To</th>
        </tr></thead>
        <tbody>
          ${history.map((h, i) => {
            const dt = h.changedAt?.toDate ? h.changedAt.toDate() : (h.changedAt ? new Date(h.changedAt) : null);
            const dtStr = dt ? dt.toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'}) + ' ' + dt.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:true}) : '—';
            return `<tr style="background:${i%2?'#fff':'#f9f9f9'}">
              <td style="padding:.3rem .6rem;color:var(--text-muted)">${dtStr}</td>
              <td style="padding:.3rem .6rem;font-weight:600">${h.changedBy || '—'}</td>
              <td style="padding:.3rem .6rem">${teamBadge(h.oldValue) || h.oldValue || '—'}</td>
              <td style="padding:.3rem .6rem">${teamBadge(h.newValue) || h.newValue || '—'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  } catch(e) {
    document.getElementById('team-history-content').innerHTML = '<div class="empty-state"><p>Failed to load history</p></div>';
  }
}

async function openQuickStatus(devoteeId, devoteeName, week) {
  const modal = document.getElementById('quick-status-modal');
  if (!modal) return;
  document.getElementById('qs-devotee-name').textContent = devoteeName;
  document.getElementById('qs-devotee-id').value = devoteeId;
  document.getElementById('qs-week').value = week;
  // Load current status
  const d = AppState.callingData?.find(x => x.id === devoteeId);
  const selReason = document.getElementById('qs-reason');
  const selStatus = document.getElementById('qs-coming');
  if (selReason) selReason.value = d?.calling_reason || '';
  if (selStatus) selStatus.value = d?.coming_status || '';
  modal.classList.remove('hidden');
}

async function saveQuickStatus() {
  const devoteeId = document.getElementById('qs-devotee-id').value;
  const week      = document.getElementById('qs-week').value;
  const status    = document.getElementById('qs-coming').value;
  const reason    = document.getElementById('qs-reason').value;
  if (!devoteeId || !week) return;
  try {
    await DB.updateCallingStatus(devoteeId, week, { coming_status: status, calling_reason: reason, calling_notes: '' });
    closeModal('quick-status-modal');
    showToast('Status updated!', 'success');
    loadCallingMgmtTab?.();
  } catch(e) {
    showToast('Failed: ' + (e.message || 'Error'), 'error');
  }
}

async function saveCallingWeekConfig() {
  const cd = document.getElementById('config-calling-date').value;
  const sd = document.getElementById('config-calling-session-date').value;
  if (!cd) { showToast('Please set a calling date', 'error'); return; }
  try {
    await DB.setCallingWeekConfig(cd, sd);
    showToast('Dates saved!', 'success');
    loadCallingStatus();
  } catch (e) {
    showToast('Failed to save: ' + (e.message || 'Check connection'), 'error');
  }
}

async function loadCallingStatus() {
  _clearCallingTimers();
  _callingLocked = false;
  document.getElementById('calling-list').innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';
  try {
    const cfg = await DB.getCallingWeekConfig();
    const masterSession = (typeof getFilterSessionId === 'function') ? getFilterSessionId() : null;

    let week = cfg?.callingDate || '';
    let sessionDate = cfg?.sessionDate || '';
    let isHistoryFallback = false;
    let beforeCallingDate = false;
    let isHistoricalView = false;
    let windowClosed = false;

    // If the master Session points to a different week than what's currently
    // configured, treat this as a historical (read-only) view of that week's
    // calling list. Calling week date = the day before the Sunday session.
    if (masterSession && masterSession !== sessionDate) {
      isHistoricalView = true;
      sessionDate = masterSession;
      const d = new Date(masterSession + 'T00:00:00');
      d.setDate(d.getDate() - 1);
      week = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      _callingLocked = true;       // submit / edit disabled
    }

    if (isHistoricalView) {
      // Historical view: already locked; skip today-vs-callingDate gating.
    } else if (week) {
      // Submission is gated by the Session Config "Calling Window Open" toggle:
      // OPEN is manual, and it AUTO-CLOSES at 11:59 PM on the calling date.
      // When the window is closed (toggle off OR past the deadline) → locked.
      const open = (typeof isCallingWindowOpen === 'function')
        ? isCallingWindowOpen(cfg)
        : !(Date.now() > new Date(week + 'T23:59:00').getTime());
      _callingLocked = !open;
      windowClosed   = !open;
    } else {
      _callingLocked = true;
      isHistoryFallback = true;
      const history = await DB.getCallingWeekHistory(1);
      if (history.length) {
        week = history[0].callingDate;
        sessionDate = history[0].sessionDate || '';
      }
    }

    window._callingSessionDate = sessionDate;
    document.getElementById('calling-week').value = week;

    const disp = document.getElementById('calling-dates-display');
    if (disp) {
      if (week) {
        const cd = new Date(week + 'T00:00:00').toLocaleDateString('en-IN', { weekday:'short', day:'numeric', month:'short', year:'numeric' });
        const sd = sessionDate ? new Date(sessionDate + 'T00:00:00').toLocaleDateString('en-IN', { weekday:'short', day:'numeric', month:'short', year:'numeric' }) : '—';
        disp.innerHTML = `<i class="fas fa-phone-alt"></i> <strong>${cd}</strong>&nbsp;&nbsp;<i class="fas fa-chalkboard-teacher"></i> <strong>${sd}</strong>`;
      } else {
        disp.innerHTML = '<span style="color:var(--danger);font-size:.82rem"><i class="fas fa-exclamation-circle"></i> No dates configured</span>';
      }
    }

    _renderSessionInfoChip(cfg, sessionDate);

    if (!week) {
      document.getElementById('calling-list').innerHTML = '<div class="empty-state"><i class="fas fa-calendar-times"></i><p>No session configured yet.<br>Super Admin must configure the next session from the sidebar.</p></div>';
      document.getElementById('calling-stats').innerHTML = '';
      const bar = document.getElementById('calling-submit-bar');
      if (bar) bar.innerHTML = '';
      return;
    }

    window._beforeCallingDate = beforeCallingDate;

    // Fetch calling data; attendance is cached per session (not re-fetched if session unchanged)
    const lastSessionId = AppState.currentSessionId;
    const [devotees, mySubmission] = await Promise.all([
      DB.getCallingStatus(week),
      _callingLocked ? Promise.resolve(null) : DB.getMyCallingSubmission(week, AppState.userId).catch(() => null),
    ]);
    // Only (re)fetch attendance if session changed — avoids a Firestore read on every calling tab open
    if (lastSessionId && window._callingPresentSetSession !== lastSessionId) {
      const attSnap = await fdb.collection('attendanceRecords')
        .where('sessionId', '==', lastSessionId).get().catch(() => null);
      window._callingPresentSet = new Set();
      if (attSnap) attSnap.docs.forEach(d => { window._callingPresentSet.add(d.data().devoteeId); });
      window._callingPresentSetSession = lastSessionId;
    } else if (!lastSessionId) {
      window._callingPresentSet = new Set();
    }
    AppState.callingData = devotees;

    // Team / Calling By dropdowns moved to the master filter bar — nothing to
    // populate locally on this tab any more.

    renderCallingStats(devotees);
    if (AppState.userRole === 'superAdmin') {
      const bar = document.getElementById('calling-submit-bar');
      if (bar) bar.innerHTML = '';
    } else if (_callingLocked) {
      _renderLockedBanner(isHistoryFallback, week, window._beforeCallingDate, isHistoricalView, sessionDate, windowClosed);
    } else {
      _renderCallingSubmitBar(week, mySubmission);
    }
    filterCallingList();
  } catch (e) {
    console.error(e);
    document.getElementById('calling-list').innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load</p></div>';
  }
}

function _renderSessionInfoChip(cfg, sessionDate) {
  const host = document.getElementById('calling-panel-list');
  if (!host) return;
  let chip = document.getElementById('calling-session-chip');
  if (!chip) {
    chip = document.createElement('div');
    chip.id = 'calling-session-chip';
    chip.className = 'session-info-chip';
    host.insertBefore(chip, host.firstChild);
  }
  const parts = [];
  if (cfg?.topic) {
    parts.push(`<span class="sic-item"><i class="fas fa-book-open"></i> <span class="sic-label">Topic:</span> <strong>${cfg.topic}</strong></span>`);
  }
  if (cfg?.speakerName) {
    parts.push(`<span class="sic-item"><i class="fas fa-user-tie"></i> <span class="sic-label">Speaker:</span> <strong>${cfg.speakerName}</strong></span>`);
  }
  if (sessionDate) {
    const sd = new Date(sessionDate + 'T00:00:00').toLocaleDateString('en-IN', { weekday:'short', day:'numeric', month:'short', year:'numeric' });
    parts.push(`<span class="sic-item"><i class="fas fa-chalkboard-teacher"></i> <span class="sic-label">Upcoming Class:</span> <strong>${sd}</strong></span>`);
  }
  if (cfg?.sessionType) {
    const cls = cfg.sessionType === 'festival' ? 'sic-type-festival' : 'sic-type-regular';
    parts.push(`<span class="${cls}">${cfg.sessionType === 'festival' ? '🌟 Festival' : '● Regular'}</span>`);
  }
  if (!parts.length) {
    chip.style.display = 'none';
    return;
  }
  chip.style.display = '';
  chip.innerHTML = parts.join('');
}

function _renderLockedBanner(isHistoryFallback, weekDate, beforeCallingDate, isHistoricalView, sessionDate, windowClosed) {
  const bar = document.getElementById('calling-submit-bar');
  if (!bar) return;
  const weekLabel = weekDate
    ? new Date(weekDate + 'T00:00:00').toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric', weekday:'short' })
    : '';
  if (isHistoricalView) {
    const sessLabel = sessionDate
      ? new Date(sessionDate + 'T00:00:00').toLocaleDateString('en-IN', { weekday:'short', day:'numeric', month:'short', year:'numeric' })
      : '';
    bar.style.background  = '#ede9fe';
    bar.style.borderColor = '#c4b5fd';
    bar.innerHTML = `<div style="flex:1">
      <span style="font-size:.9rem;font-weight:700;color:#5b21b6">
        <i class="fas fa-history"></i> Viewing historical session — <strong>${sessLabel}</strong>
      </span>
      <div style="font-size:.75rem;color:var(--text-muted);margin-top:.2rem">
        This is a read-only view of a past session's calling list. Use the master Session filter at the top to switch back to the current session.
      </div>
    </div>`;
    return;
  }
  if (beforeCallingDate) {
    bar.style.background  = '#fff8e1';
    bar.style.borderColor = '#ffcc80';
    bar.innerHTML = `<div style="flex:1">
      <span style="font-size:.9rem;font-weight:700;color:#e65100">
        <i class="fas fa-hourglass-half"></i> Calling opens on <strong>${weekLabel}</strong>
      </span>
      <div style="font-size:.75rem;color:var(--text-muted);margin-top:.2rem">
        Your devotee list is available for reference. Submit will unlock on the calling date.
      </div>
    </div>`;
  } else if (isHistoryFallback) {
    bar.style.background  = '#e3f2fd';
    bar.style.borderColor = '#90caf9';
    bar.innerHTML = `<div style="flex:1">
      <span style="font-size:.9rem;font-weight:700;color:#0d47a1">
        <i class="fas fa-info-circle"></i> Showing previous week — <strong>${weekLabel}</strong>
      </span>
      <div style="font-size:.75rem;color:var(--text-muted);margin-top:.2rem">
        No session is configured. This is last week's data for reference. Super Admin must configure the next session.
      </div>
    </div>`;
  } else if (windowClosed) {
    bar.style.background  = '#fce4ec';
    bar.style.borderColor = '#ef9a9a';
    bar.innerHTML = `<div style="flex:1">
      <span style="font-size:.9rem;font-weight:700;color:#b71c1c">
        <i class="fas fa-lock"></i> Calling window is closed
      </span>
      <div style="font-size:.75rem;color:var(--text-muted);margin-top:.2rem">
        Submission is disabled. The window is opened by Super Admin (Session Configuration) and auto-closes at 11:59 PM on the calling date.
      </div>
    </div>`;
  } else {
    bar.style.background  = '#fce4ec';
    bar.style.borderColor = '#ef9a9a';
    bar.innerHTML = `<div style="flex:1">
      <span style="font-size:.9rem;font-weight:700;color:#b71c1c">
        <i class="fas fa-lock"></i> Calling date of <strong>${weekLabel}</strong> has passed
      </span>
      <div style="font-size:.75rem;color:var(--text-muted);margin-top:.2rem">
        The submission window (until 11:59 PM on calling date) has closed. This list is read-only.
      </div>
    </div>`;
  }
}

function _renderCallingSubmitBar(week, existing) {
  const bar = document.getElementById('calling-submit-bar');
  if (!bar) return;
  const weekLabel = week
    ? new Date(week + 'T00:00:00').toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' })
    : '';
  if (existing && existing.initialSubmittedAtClient) {
    const init = new Date(existing.initialSubmittedAtClient);
    const initTime = init.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', hour12:true });
    const isLate = init.getHours() >= 21;
    const latest = existing.submittedAtClient && existing.submittedAtClient !== existing.initialSubmittedAtClient
      ? new Date(existing.submittedAtClient).toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', hour12:true })
      : null;
    bar.style.background  = isLate ? '#fff3e0' : '#e8f5e9';
    bar.style.borderColor = isLate ? '#ffb74d' : 'var(--secondary)';
    bar.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:.2rem;flex:1">
        <span style="font-size:.9rem;font-weight:700;color:${isLate ? '#bf360c' : 'var(--success)'}">
          <i class="fas fa-${isLate ? 'clock' : 'check-circle'}"></i>
          Calling Status of <strong>${weekLabel}</strong> was submitted at <strong>${initTime}</strong>${isLate ? ' — Late' : ' ✓'}
        </span>
        ${latest ? `<span style="font-size:.75rem;color:var(--text-muted)"><i class="fas fa-redo"></i> Last update: ${latest}</span>` : ''}
        <span style="font-size:.75rem;color:var(--text-muted)"><i class="fas fa-pencil-alt"></i> You can still edit and re-submit for corrections. Original timestamp is locked.</span>
      </div>
      <button class="btn btn-primary" style="padding:.35rem 1rem;font-size:.85rem;flex-shrink:0" onclick="doSubmitCallingWeek('${week}')">
        <i class="fas fa-paper-plane"></i> Re-submit
      </button>`;
  } else if (week) {
    bar.style.background  = '';
    bar.style.borderColor = '';
    bar.innerHTML = `
      <span style="font-size:.85rem;color:var(--text-muted)">
        <i class="fas fa-info-circle"></i> Done calling for <strong>${weekLabel}</strong>?
      </span>
      <button class="btn btn-primary" style="padding:.35rem 1rem;font-size:.85rem" onclick="doSubmitCallingWeek('${week}')">
        <i class="fas fa-paper-plane"></i> Submit Calling
      </button>`;
  } else {
    bar.innerHTML = '';
  }
}

async function doSubmitCallingWeek(week) {
  try {
    await DB.submitCallingWeek(week, AppState.userId, AppState.userName, AppState.userTeam);
    showToast('Calling submitted! Hare Krishna 🙏', 'success');
  } catch (e) {
    console.error('Submit calling failed:', e);
    showToast('Submit failed: ' + (e.message || 'Check connection & try again'), 'error');
    return;
  }
  try {
    const sub = await DB.getMyCallingSubmission(week, AppState.userId);
    _renderCallingSubmitBar(week, sub);
  } catch (_) {
    _renderCallingSubmitBar(week, { submittedAtClient: new Date().toISOString() });
  }
}

const CALLING_REASONS = [
  // dateLabel    — what to call the date input when needsDate=true
  // needsTries   — show a "How many times tried?" counter
  // needsTexted  — show a Texted? yes/no toggle
  { value: '',                  label: '— Select reason —',          text: '',                                  needsDate: false },
  { value: 'did_not_pick',      label: 'Did not pick call',          text: 'Did not pick call',                 needsDate: false, needsTries: true, needsTexted: true },
  { value: 'incoming_na',       label: 'Incoming not available',     text: 'Incoming not available',            needsDate: false },
  { value: 'wrong_number',      label: 'Wrong number',               text: 'Wrong number',                      needsDate: false },
  { value: 'will_try',          label: 'Will Try',                   text: 'Will try to come',                  needsDate: false },
  { value: 'not_sure',          label: 'Not Sure',                   text: 'Not sure',                          needsDate: false },
  { value: 'in_village',        label: 'In Village',                 text: 'Gone to village',                   needsDate: true,  dateLabel: 'Coming back' },
  { value: 'out_of_station',    label: 'Out of station',             text: 'Out of station',                    needsDate: true,  dateLabel: 'Available from' },
  { value: 'exams',             label: 'Exams',                      text: 'Exams',                             needsDate: true,  dateLabel: 'Available from' },
  { value: 'online_class',      label: 'Shifted to online class',    text: 'Shifted to online class',           needsDate: false },
  { value: 'out_of_service',    label: 'Temporarily out of service', text: 'Temporarily out of service',        needsDate: false },
  { value: 'festival_calling',  label: 'Festival Calling',           text: 'Festival Calling',                  needsDate: false },
  // value kept as 'not_interested_now' so existing Firestore data still matches; only the label changed.
  { value: 'not_interested_now',label: 'Not Interested',             text: 'Not Interested',                    needsDate: false },
];

function _reasonLabel(r)       { return CALLING_REASONS.find(x => x.value === r)?.label     || r || ''; }
function _reasonNeedsDate(r)   { return CALLING_REASONS.find(x => x.value === r)?.needsDate || false; }
function _reasonNeedsTries(r)  { return CALLING_REASONS.find(x => x.value === r)?.needsTries || false; }
function _reasonNeedsTexted(r) { return CALLING_REASONS.find(x => x.value === r)?.needsTexted || false; }
function _reasonDateLabel(r)   { return CALLING_REASONS.find(x => x.value === r)?.dateLabel || 'Available from'; }

function renderCallingStats(devotees) {
  const total     = devotees.length;
  const called    = devotees.filter(d => d.coming_status || d.calling_reason || d.calling_notes).length;
  const uncalled  = total - called;
  const pct       = total > 0 ? Math.round((called / total) * 100) : 0;
  const barColor  = pct >= 80 ? '#16a34a' : pct >= 50 ? '#d97706' : '#2563eb';

  const yes        = devotees.filter(d => d.coming_status === 'Yes').length;
  const notReached = devotees.filter(d => ['incoming_na','out_of_service','wrong_number'].includes(d.calling_reason)).length;
  const notPick    = devotees.filter(d => d.calling_reason === 'did_not_pick').length;
  const outStation = devotees.filter(d => ['out_of_station','exams'].includes(d.calling_reason)).length;
  const notInt     = devotees.filter(d => d.calling_reason === 'not_interested_now').length;
  const otherReas  = devotees.filter(d => d.calling_reason && !['incoming_na','out_of_service','wrong_number','did_not_pick','out_of_station','exams','not_interested_now','online_class','festival_calling'].includes(d.calling_reason)).length;

  // Tile: big count, small label, full clickable card — 3 per row on mobile
  const tile = (label, count, color, key) => `
    <button onclick="openCallingStatList('${key}')"
      style="flex:1;min-width:calc(33.33% - .4rem);max-width:calc(33.33% - .4rem);
             display:flex;flex-direction:column;align-items:center;justify-content:center;
             gap:.2rem;padding:.7rem .3rem;
             background:#fff;border:2px solid #e2e8f0;border-radius:12px;
             cursor:pointer;transition:border-color .15s,box-shadow .15s;
             box-shadow:0 2px 6px rgba(0,0,0,.07)">
      <span style="font-size:1.9rem;font-weight:900;color:${color};line-height:1;font-family:'Cinzel',serif">${count}</span>
      <span style="font-size:.65rem;font-weight:700;color:#374151;text-align:center;line-height:1.3">${label}</span>
    </button>`;

  document.getElementById('calling-stats').innerHTML = `
    <!-- ① Progress bar — full width -->
    <div style="width:100%;background:#fff;border:1.5px solid #e2e8f0;border-radius:10px;padding:.7rem .9rem;margin-bottom:.55rem">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.35rem">
        <span style="font-weight:700;font-size:.85rem;color:#0d2d5a">
          <i class="fas fa-phone-alt" style="font-size:.75rem;margin-right:.3rem"></i>Calling Progress
        </span>
        <span style="font-size:1rem;font-weight:900;color:${barColor}">${called}<span style="font-size:.72rem;font-weight:500;color:#64748b"> / ${total} &nbsp;${pct}%</span></span>
      </div>
      <div style="background:#f1f5f9;border-radius:99px;height:9px;overflow:hidden">
        <div style="height:100%;border-radius:99px;background:${barColor};width:${Math.max(pct,1)}%;transition:width .6s ease"></div>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:.22rem;font-size:.68rem;color:#94a3b8">
        <span>${uncalled} not called</span><span>${yes} confirmed ✓</span>
      </div>
    </div>
    <!-- ② Tiles — 3 per row -->
    <div style="display:flex;flex-wrap:wrap;gap:.45rem;width:100%">
      ${tile('Yes (Coming)',    yes,        '#16a34a', 'confirmed')}
      ${tile('Not Reached',    notReached,  '#b91c1c', 'not_reached')}
      ${tile('Not Pick',       notPick,     '#d97706', 'not_pick')}
      ${tile('Out of Station', outStation,  '#7c3aed', 'unavailable')}
      ${tile('Not Interested', notInt,      '#dc2626', 'not_interested')}
      ${tile('Other Reason',   otherReas,   '#64748b', 'other_reason')}
    </div>`;
}

function filterCallingList() {
  const q    = document.getElementById('calling-search')?.value.toLowerCase() || '';
  const s    = document.getElementById('calling-filter-status')?.value || '';
  // Team + Calling By come from the master filter bar.
  const team = (typeof getFilterTeam      === 'function') ? getFilterTeam()      : '';
  const by   = (typeof getFilterCallingBy === 'function') ? getFilterCallingBy() : '';
  const filtered = AppState.callingData.filter(d => {
    if (q    && !d.name.toLowerCase().includes(q) && !(d.mobile||'').includes(q)) return false;
    if (team && d.team_name !== team) return false;
    if (by   && d.calling_by !== by) return false;
    if (s) {
      if (s === '_none') return !d.coming_status && !d.calling_reason && !d.calling_notes;
      if (s === 'Yes')   return d.coming_status === 'Yes';
      return d.calling_reason === s;
    }
    return true;
  });
  // Stats follow whichever filters are active so the numbers always match
  // what's visible in the list below.
  renderCallingStats(filtered);
  renderCallingList(filtered, _callingLocked);
}

function renderCallingList(devotees, locked) {
  const wrap = document.getElementById('calling-list');
  if (!devotees.length) { wrap.innerHTML = '<div class="empty-state"><i class="fas fa-phone-slash"></i><p>No devotees found</p></div>'; return; }
  wrap.innerHTML = `<div class="calling-cards">${devotees.map((d, i) => renderCallingCard(d, i + 1, locked)).join('')}</div>`;
}

// ── MINIMAL CALLING CARD ─────────────────────────────────────────────
// Uniform design for both Calls and Team Calling sub-tabs. The card itself
// is a clean name + phone summary with quick-action call/whatsapp icons.
// Status is shown as a colored left-border accent (no chip, no chevron).
// Clicking anywhere on the card (except the icon buttons) opens the
// 4-week history modal — that's where status marking happens.
function renderCallingCard(d, i, locked) {
  const isYes   = d.coming_status === 'Yes';
  const reason  = d.calling_reason || '';
  const safeId  = d.id;
  const safeName = (d.name || '').replace(/'/g, "\\'");

  const cardCls = ['calling-card', 'cc-v2'];
  if (isYes)   cardCls.push('cc-confirmed');
  if (reason)  cardCls.push('cc-has-reason');

  const phoneRow = d.mobile
    ? `<div class="cc-v2-phone">${d.mobile}</div>`
    : '';

  const birthday = isBirthdayWeek(d.dob)
    ? ' <i class="fas fa-birthday-cake" style="color:var(--gold);font-size:.85rem"></i>'
    : '';

  const cleanMobile = (d.mobile || '').replace(/\D/g, '');

  const cr = d.chanting_rounds || 0;
  const wasPresent = window._callingPresentSet?.has(safeId);
  const attBadge = window._callingPresentSet
    ? (wasPresent
        ? `<span style="background:#dcfce7;color:#15803d;font-size:.65rem;font-weight:700;padding:.08rem .35rem;border-radius:4px;white-space:nowrap"><i class="fas fa-check"></i> Last: Present</span>`
        : `<span style="background:#fee2e2;color:#b91c1c;font-size:.65rem;font-weight:700;padding:.08rem .35rem;border-radius:4px;white-space:nowrap"><i class="fas fa-times"></i> Last: Absent</span>`)
    : '';
  const crBadge = `<span style="background:#f1f5f9;color:#475569;font-size:.65rem;font-weight:700;padding:.08rem .35rem;border-radius:4px;white-space:nowrap"><i class="fas fa-dharmachakra" style="font-size:.6rem"></i> ${cr}R</span>`;

  return `<div class="${cardCls.join(' ')}" data-id="${safeId}" data-mobile="${cleanMobile}">
    <div class="cc-swipe-bg cc-swipe-bg--call"><i class="fas fa-phone-alt"></i><span>Call</span></div>
    <div class="cc-swipe-bg cc-swipe-bg--wa"><span>WhatsApp</span><i class="fab fa-whatsapp"></i></div>
    <div class="cc-v2-content" onclick="openCallingHistory('${safeId}','${safeName}')">
      <div class="cc-v2-main">
        <div class="cc-v2-name">${d.name}${nameTags(d)}${birthday}</div>
        <div style="display:flex;gap:.3rem;flex-wrap:wrap;margin-top:.2rem">${crBadge}${attBadge}</div>
        ${phoneRow}
      </div>
      <div class="cc-v2-actions" onclick="event.stopPropagation()">${contactIcons(d.mobile)}</div>
    </div>
  </div>`;
}

function _reasonOptions(selected) {
  return CALLING_REASONS.map(r =>
    `<option value="${r.value}"${r.value === selected ? ' selected' : ''}>${r.label}</option>`
  ).join('');
}

function renderCallingRow(d, i, locked) {
  const isYes   = d.coming_status === 'Yes';
  const reason  = d.calling_reason || '';
  const safeId  = d.id;
  const safeName = d.name.replace(/'/g,"\\'");

  if (locked) {
    const avail = (_reasonNeedsDate(reason) && d.available_from) ? ` · from ${formatDate(d.available_from)}` : '';
    let statusChip;
    if (isYes) {
      statusChip = `<span style="background:#e8f5e9;color:#1b5e20;padding:.2rem .6rem;border-radius:4px;font-size:.82rem;font-weight:600"><i class="fas fa-check-circle"></i> Coming</span>`;
    } else if (reason) {
      statusChip = `<span style="background:#fff3e0;color:#bf360c;padding:.2rem .6rem;border-radius:4px;font-size:.82rem">${_reasonLabel(reason)}${avail}</span>`;
    } else {
      statusChip = `<span style="color:#bdbdbd;font-size:.78rem"><i class="fas fa-circle-notch"></i> Not called</span>`;
    }
    const notesHtml = d.calling_notes
      ? `<div style="font-size:.75rem;color:var(--text-muted);font-style:italic">"${(d.calling_notes||'').replace(/"/g,'&quot;')}"</div>`
      : '';
    // Context line shown below the name — visible on mobile where caller/team cols are hidden
    const contextLine = (d.calling_by || d.team_name)
      ? `<div class="tc-row-context">${d.calling_by ? `<i class="fas fa-headset"></i> ${d.calling_by}` : ''}${d.calling_by && d.team_name ? ' · ' : ''}${d.team_name ? teamBadge(d.team_name) : ''}</div>`
      : '';
    return `<tr data-id="${safeId}" class="${isYes ? 'row-confirmed' : (reason ? 'row-has-reason' : '')}">
      <td class="cs-num">${i}</td>
      <td class="cs-name">
        <div style="display:flex;align-items:center;gap:.4rem">
          <div class="devotee-avatar" style="width:28px;height:28px;font-size:.65rem;flex-shrink:0">${initials(d.name)}</div>
          <div>
            <span class="calling-name-link" onclick="openCallingHistory('${safeId}','${safeName}')">
              ${d.name}${nameTags(d)}${isBirthdayWeek(d.dob) ? ' <i class="fas fa-birthday-cake" style="color:var(--gold);font-size:.7rem"></i>' : ''}
            </span>
            ${contextLine}
          </div>
        </div>
      </td>
      <td>${contactIcons(d.mobile)}</td>
      <td class="cs-team-col">${teamBadge(d.team_name)}</td>
      <td class="cs-callingby">${d.calling_by || '—'}</td>
      <td>${statusChip}</td>
      <td><div class="reason-notes-cell">${notesHtml}</div></td>
    </tr>`;
  }

  const needsDate = _reasonNeedsDate(reason);
  const updTime = d.updated_at_client
    ? `<span class="calling-upd-time">${new Date(d.updated_at_client).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:true})}</span>` : '';
  return `<tr data-id="${safeId}" class="${isYes ? 'row-confirmed' : (reason ? 'row-has-reason' : '')}">
    <td class="cs-num">${i}</td>
    <td class="cs-name">
      <div style="display:flex;align-items:center;gap:.4rem">
        <div class="devotee-avatar" style="width:28px;height:28px;font-size:.65rem;flex-shrink:0">${initials(d.name)}</div>
        <span class="calling-name-link" onclick="openCallingHistory('${safeId}','${safeName}')">
          ${d.name}${nameTags(d)}${isBirthdayWeek(d.dob) ? ' <i class="fas fa-birthday-cake" style="color:var(--gold);font-size:.7rem"></i>' : ''}
        </span>
      </div>
    </td>
    <td>${contactIcons(d.mobile)}</td>
    <td>${teamBadge(d.team_name)}</td>
    <td class="cs-callingby">${d.calling_by || '—'}</td>
    <td>
      <button class="coming-toggle${isYes ? ' active' : ''}" onclick="toggleComing('${safeId}', this)" title="${isYes ? 'Click to unmark' : 'Mark as confirmed coming'}">
        ${isYes ? '<i class="fas fa-check-circle"></i> Coming' : '<i class="fas fa-circle"></i> Mark Yes'}
      </button>
      ${updTime}
    </td>
    <td>
      <div class="reason-notes-cell">
        <select class="calling-reason-select${reason ? ' has-reason' : ''}" onchange="onReasonChange('${safeId}', this)" onclick="event.stopPropagation()">
          ${_reasonOptions(reason)}
        </select>
        <input type="date" class="calling-avail-date filter-select" style="display:${needsDate ? 'block' : 'none'}"
          value="${d.available_from || ''}" title="Available from this date"
          onchange="updateAvailableFrom('${safeId}', this.value)" onclick="event.stopPropagation()">
        <input class="calling-notes-input" type="text" placeholder="Add notes…" value="${(d.calling_notes || '').replace(/"/g,'&quot;')}"
          onchange="updateCallingNotes('${safeId}', this.value)" onclick="event.stopPropagation()">
      </div>
    </td>
  </tr>`;
}

// Returns 4 calling-week dates (newest first), anchored on the given current
// week if provided, otherwise on the most recent Saturday from today. Used by
// the history modal to guarantee a 4-row view regardless of how many records
// actually exist for the devotee.
function _last4CallingWeeks(currentWeek) {
  let anchor;
  if (currentWeek) {
    anchor = new Date(currentWeek + 'T00:00:00');
  } else {
    // Default: the most recent Saturday on/before today.
    const today = new Date();
    // getDay() returns 0=Sun … 6=Sat. Days back to reach Saturday:
    // Sat → 0, Sun → 1, Mon → 2 … Fri → 6
    const daysBack = (today.getDay() + 1) % 7;
    anchor = new Date(today);
    anchor.setDate(today.getDate() - daysBack);
  }
  const dates = [];
  for (let i = 0; i < 4; i++) {
    const d = new Date(anchor);
    d.setDate(anchor.getDate() - 7 * i);
    dates.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`);
  }
  return dates;
}

// ── CALLING HISTORY MODAL ─────────────────────────────────────────────
// Opens when the user clicks any calling card. Shows last 4 weeks of this
// devotee's calling history. If the top row matches the CURRENT calling week
// and the user can edit (not _callingLocked, on Calls sub-tab), that row
// has inline Yes / No Pick / Retry / More-reason / Notes controls so the
// coordinator can mark status without leaving the modal.
//
// State for in-modal saves so we know which devotee + week to write to.
let _historyModalDevoteeId = null;
let _historyModalDevoteeName = '';
let _historyModalCurrentWeek = '';


async function openCallingHistory(devoteeId, devoteeName) {
  const modal = document.getElementById('calling-history-modal');
  _historyModalDevoteeId = devoteeId;
  _historyModalDevoteeName = devoteeName;

  // Title: name + (optional) team + caller, pulled from AppState.callingData.
  const d = AppState.callingData?.find(x => x.id === devoteeId);
  const teamCallerBits = [];
  if (d?.team_name)  teamCallerBits.push(`<span class="ch-modal-meta-team">${d.team_name}</span>`);
  if (d?.calling_by) teamCallerBits.push(`<span class="ch-modal-meta-caller">${d.calling_by}</span>`);
  const metaLine = teamCallerBits.length ? `<div class="ch-modal-meta">${teamCallerBits.join(' · ')}</div>` : '';
  document.getElementById('calling-history-name').innerHTML =
    `<i class="fas fa-history"></i> ${devoteeName}${metaLine}`;


  document.getElementById('calling-history-content').innerHTML =
    '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';
  modal.classList.remove('hidden');

  try {
    const history = await DB.getCallingHistory(devoteeId, 4);

    // Determine the current calling week and whether the user can edit it.
    // currentWeek prefers the Calls-tab input (set by loadCallingStatus). If
    // the user opened the modal from Team Calling without visiting Calls,
    // fall back to the calling-week config from Firestore.
    let currentWeek = document.getElementById('calling-week')?.value || '';
    if (!currentWeek) {
      try {
        const cfg = await DB.getCallingWeekConfig();
        currentWeek = cfg?.callingDate || '';
      } catch (_) {}
    }
    _historyModalCurrentWeek = currentWeek;

    // Edit access:
    //  • Super admin can always edit the current week (cross-team)
    //  • Delegated cross-team callers (canAllTeamCalling) get the same power
    //  • Other roles can only edit on the Calls sub-tab (their own list),
    //    subject to the time-window lock (_callingLocked).
    const isSuperAdmin = AppState.userRole === 'superAdmin';
    const canCrossCall = (typeof canCrossTeamCalling === 'function') && canCrossTeamCalling();
    const onCallsTab   = AppState._callingSubTab === 'calls' || AppState._callingSubTab === undefined;
    const canEditCurrentWeek = !!currentWeek && (isSuperAdmin || canCrossCall || (onCallsTab && !_callingLocked));

    // Always show the 4 most recent calling weeks — even if some weeks have
    // no callingStatus record yet. For weeks without data we render a placeholder
    // ("Not called") so the user can see the full history shape.
    const targetDates = _last4CallingWeeks(currentWeek);
    const historyByDate = Object.fromEntries((history || []).map(h => [h.weekDate, h]));
    const rows = targetDates.map(date => historyByDate[date] || {
      weekDate: date, comingStatus: '', callingReason: '', callingNotes: '', availableFrom: '',
    });

    if (!rows.length) {
      document.getElementById('calling-history-content').innerHTML = '<div class="empty-state"><p>No calling history</p></div>';
      return;
    }

    // Check which sessions the devotee actually attended.
    // Each calling weekDate is a Saturday; the corresponding session is the next day (Sunday).
    const sundayDates = targetDates.map(sat => {
      const d = new Date(sat + 'T00:00:00'); d.setDate(d.getDate() + 1);
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    });
    // Get session docs for those Sundays (uses sessionsCache or queries)
    const presentWeekDates = new Set();
    try {
      const sessSnap = await fdb.collection('sessions')
        .where('sessionDate', 'in', sundayDates).get();
      const sessionIds = sessSnap.docs.map(d => d.id);
      if (sessionIds.length) {
        const attSnap = await fdb.collection('attendanceRecords')
          .where('devoteeId', '==', devoteeId)
          .where('sessionId', 'in', sessionIds).get();
        const presentSessionIds = new Set(attSnap.docs.map(d => d.data().sessionId));
        sessSnap.docs.forEach(d => {
          if (presentSessionIds.has(d.id)) {
            // Map back to the Saturday weekDate (Sunday - 1 day)
            const sun = new Date(d.data().sessionDate + 'T00:00:00');
            sun.setDate(sun.getDate() - 1);
            const sat = `${sun.getFullYear()}-${String(sun.getMonth()+1).padStart(2,'0')}-${String(sun.getDate()).padStart(2,'0')}`;
            presentWeekDates.add(sat);
          }
        });
      }
    } catch (_) {} // non-critical — attendance highlight is best-effort

    document.getElementById('calling-history-content').innerHTML = rows.map(h => {
      const editable = canEditCurrentWeek && h.weekDate === currentWeek;
      const wasPresent = presentWeekDates.has(h.weekDate);
      return editable ? _renderHistoryRowEditable(h, wasPresent) : _renderHistoryRowReadonly(h, wasPresent);
    }).join('');
  } catch (e) {
    console.error('openCallingHistory', e);
    document.getElementById('calling-history-content').innerHTML = '<div class="empty-state"><p>Failed to load history</p></div>';
  }
}

function _renderHistoryRowReadonly(h, wasPresent = false) {
  const label = formatDate(h.weekDate);
  const isYes = h.comingStatus === 'Yes';
  const reason = h.callingReason || '';
  const reasonLbl = _reasonLabel(reason);
  const dateLabel = _reasonDateLabel(reason);
  const avail = h.availableFrom
    ? `<div class="ch-row-avail">${dateLabel}: ${formatDate(h.availableFrom)}</div>`
    : '';
  const wasCalled = !!(h.comingStatus || reason || h.callingNotes);
  let outcomeHtml;
  if (!wasCalled) {
    outcomeHtml = `<span class="ch-out-none"><i class="fas fa-circle-notch"></i> Not called</span>`;
  } else if (isYes) {
    outcomeHtml = `<span class="ch-out-yes"><i class="fas fa-check-circle"></i> Confirmed Coming</span>`;
  } else if (reason) {
    outcomeHtml = `<span class="ch-out-reason">${reasonLbl}</span>`;
  } else {
    outcomeHtml = '';
  }
  // Did-not-pick follow-up summary (Tried N times · Texted ✓ / ✗)
  let followupBits = [];
  if (_reasonNeedsTries(reason) && (h.triesCount === 0 || h.triesCount)) {
    followupBits.push(`Tried ${h.triesCount} time${Number(h.triesCount) === 1 ? '' : 's'}`);
  }
  if (_reasonNeedsTexted(reason) && (h.texted === true || h.texted === false)) {
    followupBits.push(h.texted
      ? '<span class="ch-row-texted yes"><i class="fas fa-check"></i> Texted</span>'
      : '<span class="ch-row-texted no"><i class="fas fa-times"></i> Not texted</span>');
  }
  const followup = followupBits.length
    ? `<div class="ch-row-followup">${followupBits.join(' · ')}</div>`
    : '';
  const note = h.callingNotes
    ? `<div class="ch-row-note">"${(h.callingNotes||'').replace(/"/g,'&quot;')}"</div>`
    : '';
  const presentBg = wasPresent ? 'background:#f0fdf4;border-left:3px solid #16a34a;' : '';
  const presentBadge = wasPresent
    ? `<span style="display:inline-flex;align-items:center;gap:.25rem;font-size:.65rem;font-weight:700;color:#15803d;background:#dcfce7;padding:.08rem .35rem;border-radius:4px;margin-left:.4rem"><i class="fas fa-check-circle" style="font-size:.6rem"></i> Attended</span>`
    : '';
  return `<div class="ch-row ch-row-ro" style="${presentBg}">
    <div class="ch-row-date">${label}${presentBadge}</div>
    <div class="ch-row-body">${outcomeHtml}${avail}${followup}${note}</div>
  </div>`;
}

function _renderHistoryRowEditable(h, wasPresent = false) {
  const label = formatDate(h.weekDate);
  const isYes = h.comingStatus === 'Yes';
  const reason = h.callingReason || '';

  const moreReasons = CALLING_REASONS.filter(r => r.value && r.value !== 'did_not_pick');
  const moreOptions = moreReasons.map(r =>
    `<option value="${r.value}"${reason === r.value ? ' selected' : ''}>${r.label}</option>`
  ).join('');
  const moreLabel = reason && reason !== 'did_not_pick'
    ? (CALLING_REASONS.find(r => r.value === reason)?.label || reason)
    : 'More reason…';
  const moreHasCls = (reason && reason !== 'did_not_pick') ? ' has-reason' : '';

  // Conditional follow-up fields based on reason
  const showAvail  = _reasonNeedsDate(reason);
  const showTries  = _reasonNeedsTries(reason);
  const showTexted = _reasonNeedsTexted(reason);
  const availVal   = h.availableFrom || '';
  const triesVal   = (h.triesCount === 0 || h.triesCount) ? Number(h.triesCount) : '';
  const textedVal  = h.texted === true ? 'yes' : (h.texted === false ? 'no' : '');
  const dateLabel  = _reasonDateLabel(reason);

  const updLine = h.updatedAtClient
    ? `<div class="ch-row-upd">Updated ${new Date(h.updatedAtClient).toLocaleTimeString('en-IN', {hour:'2-digit',minute:'2-digit',hour12:true})}</div>`
    : '';

  // Follow-up blocks — only rendered when the reason needs them.
  const triesBlock = showTries ? `
    <div class="ch-edit-followup">
      <label class="ch-edit-followup-lbl">How many times did you try?</label>
      <div class="ch-tries-row">
        <button type="button" class="ch-tries-step" onclick="modalAdjustTries(-1)">−</button>
        <input type="number" min="0" max="99" class="ch-tries-input" value="${triesVal}" oninput="modalSetTries(this.value)">
        <button type="button" class="ch-tries-step" onclick="modalAdjustTries(1)">+</button>
        <span class="ch-tries-suffix">times</span>
      </div>
    </div>` : '';

  const textedBlock = showTexted ? `
    <div class="ch-edit-followup">
      <label class="ch-edit-followup-lbl">Did you text them?</label>
      <div class="ch-yesno">
        <button type="button" class="ch-yesno-btn${textedVal === 'yes' ? ' active' : ''}" onclick="modalSetTexted(true)">
          <i class="fas fa-check"></i> Yes
        </button>
        <button type="button" class="ch-yesno-btn${textedVal === 'no' ? ' active no' : ''}" onclick="modalSetTexted(false)">
          <i class="fas fa-times"></i> No
        </button>
      </div>
    </div>` : '';

  const availBlock = showAvail ? `
    <div class="ch-edit-followup">
      <label class="ch-edit-followup-lbl">${dateLabel}</label>
      <input type="date" class="ch-edit-avail" value="${availVal}" onchange="modalUpdateAvailFrom(this.value)">
    </div>` : '';

  return `<div class="ch-row ch-row-edit">
    <div class="ch-row-date">${label}<span class="ch-row-thisweek">This week</span>${wasPresent ? `<span style="display:inline-flex;align-items:center;gap:.25rem;font-size:.65rem;font-weight:700;color:#15803d;background:#dcfce7;padding:.08rem .35rem;border-radius:4px;margin-left:.4rem"><i class="fas fa-check-circle" style="font-size:.6rem"></i> Attended</span>` : ''}</div>
    <div class="ch-row-body">
      <div class="ch-edit-actions">
        <button class="cc-qbtn cc-yes${isYes ? ' active' : ''}" onclick="modalToggleComing()">
          <i class="fas fa-check-circle"></i> Yes
        </button>
        <button class="cc-qbtn cc-nopick${reason === 'did_not_pick' ? ' active' : ''}" onclick="modalQuickReason('did_not_pick')">
          <i class="fas fa-phone-slash"></i> No Pick
        </button>
        <button class="cc-qbtn cc-retry" onclick="modalQuickRetry()">
          <i class="fas fa-undo"></i> Retry
        </button>
        <select class="cc-more-select${moreHasCls}" onchange="modalChangeReason(this.value)">
          <option value="">${moreLabel}</option>
          ${moreOptions}
        </select>
      </div>
      ${triesBlock}
      ${textedBlock}
      ${availBlock}
      <textarea class="cc-notes ch-edit-notes" placeholder="Add notes…" onchange="modalUpdateNotes(this.value)">${(h.callingNotes||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</textarea>
      ${updLine}
    </div>
  </div>`;
}

// ── MODAL SAVE HANDLERS ──
// These all save through DB.updateCallingStatus, update the in-memory
// AppState.callingData entry, refresh the card's status border in the list,
// then re-render the modal so its buttons reflect the new state.
async function _modalSaveAndRefresh(payload) {
  if (!_historyModalDevoteeId || !_historyModalCurrentWeek) return;
  const id = _historyModalDevoteeId;
  const week = _historyModalCurrentWeek;
  try {
    await DB.updateCallingStatus(id, week, payload);
    // Update in-memory list so background card reflects new state immediately.
    const d = AppState.callingData?.find(x => x.id === id);
    if (d) {
      if (payload.coming_status !== undefined) d.coming_status   = payload.coming_status;
      if (payload.calling_reason !== undefined) d.calling_reason = payload.calling_reason;
      if (payload.calling_notes !== undefined) d.calling_notes   = payload.calling_notes;
      if (payload.available_from !== undefined) d.available_from = payload.available_from;
      if (payload.tries_count   !== undefined) d.tries_count     = payload.tries_count;
      if (payload.texted        !== undefined) d.texted          = payload.texted;
    }
    _refreshCardStatusInList(id);
    if (typeof renderCallingStats === 'function' && AppState.callingData) renderCallingStats(AppState.callingData);
    // Re-render the modal rows so the active button highlight updates.
    await _refreshHistoryModalRows();
  } catch (e) {
    showToast('Save failed', 'error');
    console.error('modal save', e);
  }
}

function _refreshCardStatusInList(devoteeId) {
  const card = document.querySelector(`.calling-card[data-id="${devoteeId}"]`);
  if (!card) return;
  const d = AppState.callingData?.find(x => x.id === devoteeId);
  if (!d) return;
  card.classList.toggle('cc-confirmed', d.coming_status === 'Yes');
  card.classList.toggle('cc-has-reason', !!d.calling_reason);
}

async function _refreshHistoryModalRows() {
  if (!_historyModalDevoteeId) return;
  // Re-fetch and re-render. Could be optimized to patch one row, but a full
  // re-render is simple and the dataset is tiny (4 rows max).
  await openCallingHistory(_historyModalDevoteeId, _historyModalDevoteeName);
}

async function modalToggleComing() {
  const d = AppState.callingData?.find(x => x.id === _historyModalDevoteeId);
  const isNowYes = !d || d.coming_status !== 'Yes';
  await _modalSaveAndRefresh(isNowYes
    ? { coming_status: 'Yes', calling_reason: '', available_from: null }
    : { coming_status: '', calling_reason: '', available_from: null });
}
async function modalQuickReason(reason) {
  await _modalSaveAndRefresh({ coming_status: '', calling_reason: reason });
}
async function modalQuickRetry() {
  await _modalSaveAndRefresh({ coming_status: '', calling_reason: '' });
}
async function modalChangeReason(reason) {
  const d = AppState.callingData?.find(x => x.id === _historyModalDevoteeId);
  const needsDate = _reasonNeedsDate(reason);
  const payload = {
    coming_status: '',
    calling_reason: reason,
    calling_notes: d?.calling_notes || '',
  };
  if (!needsDate) payload.available_from = null;
  await _modalSaveAndRefresh(payload);
}
async function modalUpdateAvailFrom(date) {
  await _modalSaveAndRefresh({ available_from: date });
}
const _modalNotesTimer = { id: null };
function modalUpdateNotes(notes) {
  clearTimeout(_modalNotesTimer.id);
  _modalNotesTimer.id = setTimeout(() => _modalSaveAndRefresh({ calling_notes: notes }), 600);
}

// ── Did-not-pick follow-up handlers ──
// Tries: debounced so typing in the number input doesn't fire a save per keystroke.
const _modalTriesTimer = { id: null };
function modalSetTries(value) {
  const n = parseInt(value, 10);
  const tries = isNaN(n) ? null : Math.max(0, Math.min(99, n));
  clearTimeout(_modalTriesTimer.id);
  _modalTriesTimer.id = setTimeout(() => _modalSaveAndRefresh({ tries_count: tries }), 500);
}
async function modalAdjustTries(delta) {
  // Read current value from in-memory list (so + and − reflect the stored count).
  const d = AppState.callingData?.find(x => x.id === _historyModalDevoteeId);
  const current = (d && d.tries_count != null) ? Number(d.tries_count) : 0;
  const next = Math.max(0, Math.min(99, current + delta));
  await _modalSaveAndRefresh({ tries_count: next });
}
async function modalSetTexted(value) {
  await _modalSaveAndRefresh({ texted: !!value });
}
window.modalToggleComing  = modalToggleComing;
window.modalQuickReason   = modalQuickReason;
window.modalQuickRetry    = modalQuickRetry;
window.modalChangeReason  = modalChangeReason;
window.modalUpdateAvailFrom = modalUpdateAvailFrom;
window.modalUpdateNotes   = modalUpdateNotes;
window.modalSetTries      = modalSetTries;
window.modalAdjustTries   = modalAdjustTries;
window.modalSetTexted     = modalSetTexted;

async function toggleComing(devoteeId, btn) {
  if (_callingLocked) return;
  const week = document.getElementById('calling-week').value;
  const d = AppState.callingData.find(x => x.id === devoteeId);
  const row = btn.closest('tr');
  const isNowYes = !d || d.coming_status !== 'Yes';

  try {
    const payload = isNowYes
      ? { coming_status: 'Yes', calling_reason: '', available_from: null }
      : { coming_status: '', calling_reason: '', available_from: null };
    await DB.updateCallingStatus(devoteeId, week, payload);

    if (d) { d.coming_status = isNowYes ? 'Yes' : ''; d.calling_reason = ''; d.available_from = null; }
    btn.className = 'coming-toggle' + (isNowYes ? ' active' : '');
    btn.innerHTML = isNowYes
      ? '<i class="fas fa-check-circle"></i> Coming'
      : '<i class="fas fa-circle"></i> Mark Yes';
    if (row) row.className = isNowYes ? 'row-confirmed' : '';

    if (isNowYes && row) {
      const sel = row.querySelector('.calling-reason-select');
      if (sel) { sel.value = ''; sel.classList.remove('has-reason'); }
      const datePicker = row.querySelector('.calling-avail-date');
      if (datePicker) datePicker.style.display = 'none';
    }

    // Card updates
    const card = btn.closest('.calling-card');
    if (card) {
      card.classList.toggle('cc-confirmed', isNowYes);
      card.classList.remove('cc-has-reason');
      card.querySelectorAll('.cc-qbtn').forEach(b => b.classList.remove('active'));
      if (isNowYes) btn.classList.add('active');
      const sel = card.querySelector('.cc-more-select');
      if (sel) { sel.value = ''; sel.classList.remove('has-reason'); }
    }

    renderCallingStats(AppState.callingData);
  } catch (_) { showToast('Update failed', 'error'); }
}

async function quickReason(devoteeId, reason, btn) {
  const week = resolveCallingDate(getFilterSessionId());
  const d = AppState.callingData.find(x => x.id === devoteeId);
  try {
    await DB.updateCallingStatus(devoteeId, await week, { coming_status: '', calling_reason: reason, calling_notes: d?.calling_notes || '' });
    if (d) { d.coming_status = ''; d.calling_reason = reason; }
    const card = btn.closest('.calling-card');
    if (card) {
      card.classList.remove('cc-confirmed');
      card.classList.toggle('cc-has-reason', !!reason);
      card.querySelectorAll('.cc-qbtn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const sel = card.querySelector('.cc-more-select');
      if (sel) { sel.value = ''; sel.classList.remove('has-reason'); }
    }
    renderCallingStats(AppState.callingData);
  } catch(e) { showToast('Save failed', 'error'); }
}
window.quickReason = quickReason;

async function quickRetry(devoteeId, btn) {
  const week = resolveCallingDate(getFilterSessionId());
  const d = AppState.callingData.find(x => x.id === devoteeId);
  try {
    await DB.updateCallingStatus(devoteeId, await week, { coming_status: '', calling_reason: '', calling_notes: d?.calling_notes || '' });
    if (d) { d.coming_status = ''; d.calling_reason = ''; }
    const card = btn.closest('.calling-card');
    if (card) {
      card.classList.remove('cc-confirmed', 'cc-has-reason');
      card.querySelectorAll('.cc-qbtn').forEach(b => b.classList.remove('active'));
      const sel = card.querySelector('.cc-more-select');
      if (sel) { sel.value = ''; sel.classList.remove('has-reason'); }
    }
    renderCallingStats(AppState.callingData);
  } catch(e) { showToast('Save failed', 'error'); }
}
window.quickRetry = quickRetry;

function onReasonChange(devoteeId, sel) {
  if (_callingLocked) return;
  const reason = sel.value;
  const row = sel.closest('tr');
  const notesInput = row?.querySelector('.calling-notes-input');
  const datePicker = row?.querySelector('.calling-avail-date');
  const needsDate = _reasonNeedsDate(reason);

  sel.classList.toggle('has-reason', !!reason);

  const reasonDef = CALLING_REASONS.find(r => r.value === reason);
  if (reasonDef && reasonDef.text && notesInput && !notesInput.value) {
    notesInput.value = reasonDef.text;
  }

  if (datePicker) datePicker.style.display = needsDate ? 'block' : 'none';

  const d = AppState.callingData.find(x => x.id === devoteeId);
  if (d && d.coming_status === 'Yes' && reason) {
    const toggleBtn = row?.querySelector('.coming-toggle');
    if (toggleBtn) {
      toggleBtn.className = 'coming-toggle';
      toggleBtn.innerHTML = '<i class="fas fa-circle"></i> Mark Yes';
    }
    if (row) row.className = 'row-has-reason';
    if (d) d.coming_status = '';
  }

  if (needsDate && datePicker && !datePicker.value) {
    showToast('Please select the available-from date', 'error');
    datePicker.focus();
    return;
  }

  _saveCallingReason(devoteeId, reason, notesInput?.value || '', datePicker?.value || null);

  // Card updates
  const card = sel.closest('.calling-card');
  if (card) {
    card.classList.remove('cc-confirmed');
    card.classList.toggle('cc-has-reason', !!reason);
    card.querySelectorAll('.cc-qbtn').forEach(b => b.classList.remove('active'));
    sel.classList.toggle('has-reason', !!reason);
    if (reason === 'did_not_pick') {
      card.querySelector('.cc-nopick')?.classList.add('active');
    }
  }
}

async function updateAvailableFrom(devoteeId, date) {
  if (_callingLocked) return;
  const week = document.getElementById('calling-week').value;
  const row = document.querySelector(`tr[data-id="${devoteeId}"]`);
  const notesInput = row?.querySelector('.calling-notes-input');
  const notes = notesInput?.value || '';
  const d = AppState.callingData.find(x => x.id === devoteeId);
  try {
    await DB.updateCallingStatus(devoteeId, week, { coming_status: '', available_from: date, calling_notes: notes });
    if (d) d.available_from = date;
  } catch (_) { showToast('Update failed', 'error'); }
}

const _reasonTimers = {};
const _notesTimersCalling = {};
function _clearCallingTimers() {
  Object.keys(_reasonTimers).forEach(k => { clearTimeout(_reasonTimers[k]); delete _reasonTimers[k]; });
  Object.keys(_notesTimersCalling).forEach(k => { clearTimeout(_notesTimersCalling[k]); delete _notesTimersCalling[k]; });
}
function _saveCallingReason(devoteeId, reason, notes, availFrom) {
  if (_callingLocked) return;
  clearTimeout(_reasonTimers[devoteeId]);
  _reasonTimers[devoteeId] = setTimeout(async () => {
    const week = document.getElementById('calling-week').value;
    const d = AppState.callingData.find(x => x.id === devoteeId);
    try {
      await DB.updateCallingStatus(devoteeId, week, {
        coming_status: '', calling_reason: reason, calling_notes: notes, available_from: availFrom
      });
      if (d) { d.calling_reason = reason; d.calling_notes = notes; d.available_from = availFrom; }
      const row = document.querySelector(`tr[data-id="${devoteeId}"]`);
      if (row) row.className = reason ? 'row-has-reason' : '';
      renderCallingStats(AppState.callingData);
    } catch (_) {}
  }, 600);
}

const _notesTimers = {};
function updateCallingNotes(devoteeId, notes) {
  if (_callingLocked) return;
  clearTimeout(_notesTimers[devoteeId]);
  _notesTimers[devoteeId] = setTimeout(async () => {
    const week = document.getElementById('calling-week').value;
    const d = AppState.callingData.find(x => x.id === devoteeId);
    try {
      await DB.updateCallingStatus(devoteeId, week, {
        coming_status: d?.coming_status || '', calling_notes: notes,
        calling_reason: d?.calling_reason || ''
      });
      if (d) d.calling_notes = notes;
    } catch (_) {}
  }, 800);
}

let _reportType = 'summary';

function switchReportType(type, btn) {
  // Toggle: clicking accuracy again returns to summary
  if (_reportType === type && type === 'accuracy') {
    _reportType = 'summary';
    document.getElementById('rpt-tab-accuracy').classList.remove('btn-primary');
    document.getElementById('rpt-tab-accuracy').classList.add('btn-secondary');
    loadCallingReports();
    return;
  }
  _reportType = type;
  document.getElementById('rpt-tab-accuracy').classList.toggle('btn-primary',   type === 'accuracy');
  document.getElementById('rpt-tab-accuracy').classList.toggle('btn-secondary',  type === 'summary');
  loadCallingReports();
}

// _populateReportWeeks is a no-op now that the Week dropdown is gone — kept
// as a stub so existing callers (_refreshAfterFilter) don't error.
async function _populateReportWeeks() { return; }

async function loadCallingReports() {
  const el = document.getElementById('calling-reports-content');
  if (!el) return;
  el.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';
  try {
    const sessionDate = (typeof getFilterSessionId === 'function' && getFilterSessionId())
              || (typeof getWeekDate === 'function' && getWeekDate())
              || '';
    if (!sessionDate) {
      el.innerHTML = '<div class="empty-state"><i class="fas fa-calendar-times"></i><p>No session selected. Use the Session filter at the top.</p></div>';
      return;
    }
    const week = (typeof resolveCallingDate === 'function') ? await resolveCallingDate(sessionDate).catch(() => null) : sessionDate;
    if (!week) {
      el.innerHTML = '<div class="empty-state"><i class="fas fa-calendar-times"></i><p>Could not resolve calling week date.</p></div>';
      return;
    }
    if (_reportType === 'summary') return _loadCallingSummary(week, el);
    return _loadAccuracyReport(week, el);
  } catch (e) {
    console.error('loadCallingReports', e);
    el.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load</p></div>';
  }
  // original call path removed — logic now above
  if (_reportType === 'summary') return _loadCallingSummary(week, el);
  return _loadAccuracyReport(week, el);
}

async function _loadCallingSummary(week, el) {
  try {
    const report = await DB.getCallingReport(week);
    const teams = Object.keys(report).filter(k => !k.startsWith('_'));
    if (!teams.length) {
      el.innerHTML = '<div class="empty-state"><i class="fas fa-chart-bar"></i><p>No calling data for this week</p></div>';
      return;
    }
    const weekLabel = formatDate(week);
    let gTotal=0, gCalled=0, gNC=0, gYes=0, gOnline=0, gFestival=0, gNI=0;
    let bodyRows = '';
    let gUnsubmitted = 0;

    teams.forEach((team, ti) => {
      const t = report[team];
      const unsub = t.unsubmittedTotal || 0;
      // "Effective Not Called" = devotees not recorded by submitted callers
      //                        + ALL devotees in lists of callers who never submitted
      const effNC = t.notCalled + unsub;
      gTotal += t.total; gCalled += t.called; gNC += effNC;
      gYes += t.yes; gOnline += (t.online||0); gFestival += (t.festival||0); gNI += (t.notInterested||0);
      gUnsubmitted += unsub;

      const teamId = 'team-' + ti;
      // Not Called = all unrecorded devotees (submitted callers' uncalled + all unsubmitted)
      const totalNC = effNC;

      // Team header row — clickable to expand/collapse facilitators
      bodyRows += `<tr class="cs-team-row" data-team-id="${teamId}" style="background:#f0f4fa;font-weight:700;font-size:.83rem;cursor:pointer" onclick="_toggleCSReportTeam('${teamId}', this)">
        <td><i class="fas fa-chevron-right cs-team-chev" style="font-size:.7rem;color:var(--text-muted);margin-right:.4rem"></i>${teamBadge(team)}</td>
        <td style="text-align:center">${t.total}</td>
        <td style="text-align:center">${t.called}</td>
        <td style="text-align:center;color:#c62828">${totalNC}</td>
        <td style="text-align:center;color:var(--success)">${t.yes}</td>
        <td style="text-align:center;color:var(--danger)">${t.notInterested||0}</td>
      </tr>`;

      const sortedCallers = Object.entries(t.callers).sort(([,a],[,b]) => {
        if (a.isCoordinator && !b.isCoordinator) return -1;
        if (!a.isCoordinator && b.isCoordinator) return 1;
        return 0;
      });
      sortedCallers.forEach(([caller, s]) => {
        const posLabel = s.isCoordinator ? 'Coordinator' : (s.position || 'Calling Facilitator');
        const posLine = `<div style="font-size:.65rem;color:var(--text-muted);font-weight:400;margin-top:.1rem">${posLabel}</div>`;
        // Hidden by default — shown when team row is clicked
        if (s.submitted) {
          bodyRows += `<tr class="cs-caller-row cs-caller-${teamId}" style="font-size:.82rem;display:none">
            <td style="padding-left:1.4rem;color:var(--text-muted)">${caller}${posLine}</td>
            <td style="text-align:center">${s.total}</td>
            <td style="text-align:center">${s.called}</td>
            <td style="text-align:center;color:#c62828">${s.notCalled}</td>
            <td style="text-align:center;color:var(--success);font-weight:600">${s.yes}</td>
            <td style="text-align:center;color:#0288d1">${s.online||0}</td>
            <td style="text-align:center;color:#f57f17">${s.festival||0}</td>
            <td style="text-align:center;color:var(--danger)">${s.notInterested||0}</td>
          </tr>`;
        } else {
          bodyRows += `<tr class="cs-caller-row cs-caller-${teamId}" style="font-size:.82rem;display:none;background:#fffbeb">
            <td style="padding-left:1.4rem;color:var(--text-muted)">${caller}${posLine}</td>
            <td style="text-align:center">${s.total}</td>
            <td colspan="6" style="text-align:center;color:#c62828;font-weight:600">
              <i class="fas fa-clock"></i> Not Submitted
            </td>
          </tr>`;
        }
      });
    });

    const gcNote = gUnsubmitted > 0
      ? `<span style="font-size:.72rem;color:#e65100;font-weight:400;margin-left:.4rem">(incl. ${gUnsubmitted} from unsubmitted callers)</span>`
      : '';

    el.innerHTML = `<div style="font-size:.84rem;margin-bottom:.6rem">
      <strong><i class="fas fa-phone-alt"></i> Calling Summary — ${weekLabel}</strong>
    </div>
    <div class="table-scroll">
    <table class="calling-table cs-report-table" style="margin:0;min-width:360px">
      <thead><tr>
        <th style="min-width:140px">Team / Calling By</th>
        <th style="text-align:center;min-width:36px">Total</th>
        <th style="text-align:center;min-width:38px">Called</th>
        <th style="text-align:center;min-width:46px;">Not Called</th>
        <th style="text-align:center;min-width:34px;">Yes</th>
        <th style="text-align:center;min-width:34px;">NI</th>
      </tr></thead>
      <tbody>
        ${bodyRows}
        <tr style="background:#0d2d5a;color:#fff;font-weight:700;font-size:.83rem;pointer-events:none;user-select:none">
          <td>Grand Total</td>
          <td style="text-align:center">${gTotal}</td>
          <td style="text-align:center">${gCalled}</td>
          <td style="text-align:center">${gNC}</td>
          <td style="text-align:center">${gYes}</td>
          <td style="text-align:center">${gNI}</td>
        </tr>
      </tbody>
    </table></div>`;
  } catch (e) {
    console.error('_loadCallingSummary', e);
    el.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load report</p></div>';
  }
}

async function _loadAccuracyReport(week, el) {
  try {
    const report = await DB.getCallingReport(week);
    const teams = Object.keys(report).filter(k => !k.startsWith('_'));
    if (!teams.length) {
      el.innerHTML = '<div class="empty-state"><i class="fas fa-chart-bar"></i><p>No calling data for this week</p></div>';
      return;
    }
    const hasSession = report._hasSession;
    const weekLabel = formatDate(week);
    // Show the Sunday class date in messages, not the Saturday calling date.
    const sessionD = new Date(week + 'T00:00:00');
    sessionD.setDate(sessionD.getDate() + 1);
    const sessionLabel = formatDate(localDateStr(sessionD));

    if (!hasSession) {
      el.innerHTML = `<div class="empty-state"><i class="fas fa-clock"></i><p>Class not yet held for ${sessionLabel} — accuracy report available after attendance is marked</p></div>`;
      return;
    }

    let grandYes=0, grandAbsent=0;
    let bodyRows = '';

    teams.forEach(team => {
      const t = report[team];
      grandYes += t.yes; grandAbsent += t.yesNotCame;
      const teamAbsentBtn = t.yesNotCame > 0
        ? `<button class="acc-absent-btn" onclick='openAbsentModal("${week}",null,"${team.replace(/"/g,'&quot;')}")'>${t.yesNotCame}</button>`
        : `<span style="color:var(--text-muted)">0</span>`;

      bodyRows += `<tr style="background:#f0f4fa;font-weight:700;font-size:.83rem">
        <td>${teamBadge(team)}</td>
        <td style="text-align:center">${t.yes}</td>
        <td style="text-align:center;color:var(--success)">${t.yesAndCame}</td>
        <td style="text-align:center">${teamAbsentBtn}</td>
      </tr>`;

      Object.entries(t.callers).forEach(([caller, s]) => {
        const absentBtn = s.yesNotCame > 0
          ? `<button class="acc-absent-btn" onclick='openAbsentModal("${week}","${caller.replace(/"/g,'&quot;')}","${team.replace(/"/g,'&quot;')}")'>${s.yesNotCame}</button>`
          : `<span style="color:var(--text-muted)">0</span>`;
        bodyRows += `<tr style="font-size:.82rem">
          <td style="padding-left:1.4rem;color:var(--text-muted)">${caller}</td>
          <td style="text-align:center">${s.yes}</td>
          <td style="text-align:center;color:var(--success)">${s.yesAndCame}</td>
          <td style="text-align:center">${absentBtn}</td>
        </tr>`;
      });
    });

    const grandAbsentBtn = grandAbsent > 0
      ? `<button class="acc-absent-btn" onclick='openAbsentModal("${week}",null,null)'>${grandAbsent}</button>`
      : `<span>0</span>`;

    el.innerHTML = `<div style="font-size:.84rem;margin-bottom:.6rem">
      <strong><i class="fas fa-user-times"></i> Said Coming But Absent — ${weekLabel}</strong>
      <span style="margin-left:.75rem;font-size:.8rem;color:var(--text-muted)">Click a number to see the list</span>
    </div>
    <div class="table-scroll">
    <table class="calling-table cs-report-table" style="margin:0;min-width:360px">
      <thead><tr>
        <th style="min-width:130px">Team / Calling By</th>
        <th style="text-align:center;color:var(--success)">Said Yes</th>
        <th style="text-align:center;color:var(--success)">Came</th>
        <th style="text-align:center;color:#c62828">Absent</th>
      </tr></thead>
      <tbody>
        ${bodyRows}
        <tr style="background:#0d2d5a;color:#fff;font-weight:700;font-size:.83rem">
          <td>Grand Total</td>
          <td style="text-align:center">${grandYes}</td>
          <td style="text-align:center">${grandYes - grandAbsent}</td>
          <td style="text-align:center">${grandAbsentBtn}</td>
        </tr>
      </tbody>
    </table>
    </div>`;
  } catch (e) {
    console.error('_loadAccuracyReport', e);
    el.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load report</p></div>';
  }
}

async function openAbsentModal(week, callingBy, team) {
  const modal = document.getElementById('absent-list-modal');
  const titleEl = document.getElementById('absent-list-title');
  const contentEl = document.getElementById('absent-list-content');
  modal.classList.remove('hidden');
  contentEl.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';

  let label = 'Said Coming — Didn\'t Attend';
  if (team && callingBy) label += ` · ${callingBy} (${team})`;
  else if (team) label += ` · ${team}`;
  titleEl.textContent = label + ` · ${formatDate(week)}`;

  try {
    const { hasSession, list } = await DB.getYesAbsentList(week);
    if (!hasSession) {
      contentEl.innerHTML = '<p style="text-align:center;color:var(--text-muted)">Class not held yet for this week.</p>';
      return;
    }
    let filtered = list;
    if (team) filtered = filtered.filter(d => d.teamName === team);
    if (callingBy) filtered = filtered.filter(d => d.callingBy === callingBy);
    if (!filtered.length) {
      contentEl.innerHTML = '<p style="text-align:center;color:var(--success)"><i class="fas fa-check-circle"></i> Everyone came!</p>';
      return;
    }
    contentEl.innerHTML = `<div class="table-scroll"><table class="calling-table" style="margin:0">
      <thead><tr>
        <th>#</th><th>Name</th><th>Team</th><th>Calling By</th><th>Mobile</th>
      </tr></thead>
      <tbody>${filtered.map((d,i) => `<tr>
        <td style="text-align:center;color:var(--text-muted)">${i+1}</td>
        <td style="font-weight:500">${d.name}</td>
        <td>${teamBadge(d.teamName)}</td>
        <td style="font-size:.82rem;color:var(--text-muted)">${d.callingBy||'—'}</td>
        <td style="font-size:.82rem">${d.mobile||'—'}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  } catch (e) {
    contentEl.innerHTML = '<p style="color:var(--danger)">Failed to load list.</p>';
  }
}

async function downloadCurrentReportExcel() {
  const sessionDate = (typeof getFilterSessionId === 'function' && getFilterSessionId()) || '';
  if (!sessionDate) { showToast('Select a session in the master filter first', 'error'); return; }
  const week = (typeof resolveCallingDate === 'function') ? await resolveCallingDate(sessionDate) : sessionDate;
  if (!week) { showToast('Could not resolve calling date', 'error'); return; }
  if (_reportType === 'summary') return _downloadSummaryExcel([week], `Calling_Summary_${week}.xlsx`);
  return _downloadAccuracyExcel([week], `Accuracy_Report_${week}.xlsx`);
}

async function downloadCompleteReportExcel() {
  showToast('Preparing complete FY report…');
  const now = new Date();
  const fyStartYear = (now.getMonth() + 1) >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  const fyStart = `${fyStartYear}-04-01`;
  const today = getToday();
  const csSnap = await fdb.collection('callingStatus').where('weekDate','>=',fyStart).where('weekDate','<=',today).get();
  const weeks = [...new Set(csSnap.docs.map(d => d.data().weekDate))].sort();
  if (!weeks.length) { showToast('No data found for this FY'); return; }
  const fname = `FY_${fyStartYear}-${String(fyStartYear+1).slice(-2)}_${_reportType === 'summary' ? 'Calling_Summary' : 'Accuracy_Report'}.xlsx`;
  if (_reportType === 'summary') return _downloadSummaryExcel(weeks, fname);
  return _downloadAccuracyExcel(weeks, fname);
}

async function _downloadSummaryExcel(weeks, filename) {
  showToast('Building Excel…');
  const XS = _xls();
  const wb = XLSX.utils.book_new();

  for (const week of weeks) {
    const report = await DB.getCallingReport(week);
    const teams = Object.keys(report).filter(k => !k.startsWith('_'));
    const sheetName = week.slice(5).replace('-','.');
    const HDR_S = XS.hdr('1A5C3A','FFFFFF');
    const SUB_S = XS.hdr('C8E6C9','1B5E20');
    const GRD_S = XS.hdr('0D3B22','FFFFFF');
    const headers = ['Team / Calling By','Total','Called','Not Called','Yes','Online','Festival','Not Interested'];
    const colW = [{wch:24},{wch:8},{wch:8},{wch:10},{wch:8},{wch:9},{wch:10},{wch:14}];
    const rows = [headers.map(h => ({ v:h, s:HDR_S }))];

    let gT=0,gCalled=0,gNC=0,gY=0,gOn=0,gFest=0,gNI=0;
    teams.forEach(team => {
      const t = report[team];
      gT+=t.total; gCalled+=t.called; gNC+=t.notCalled; gY+=t.yes;
      gOn+=(t.online||0); gFest+=(t.festival||0); gNI+=(t.notInterested||0);
      rows.push([team,t.total,t.called,t.notCalled,t.yes,t.online||0,t.festival||0,t.notInterested||0].map((v,i) => ({ v, s: i===0 ? SUB_S : XS.hdr('E8F5E9','1B5E20') })));
      Object.entries(t.callers).forEach(([caller, s]) => {
        rows.push([caller,s.total,s.called,s.notCalled,s.yes,s.online||0,s.festival||0,s.notInterested||0].map(v => ({ v, s:XS.cell() })));
      });
    });
    rows.push(['Grand Total',gT,gCalled,gNC,gY,gOn,gFest,gNI].map(v => ({ v, s:GRD_S })));

    const ws = _xlsSheet(rows, colW);
    ws['!freeze'] = { xSplit:0, ySplit:1, topLeftCell:'A2' };
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }
  XLSX.writeFile(wb, filename);
  showToast('Downloaded: ' + filename);
}

async function _downloadAccuracyExcel(weeks, filename) {
  showToast('Building Excel…');
  const XS = _xls();
  const wb = XLSX.utils.book_new();

  for (const week of weeks) {
    const report = await DB.getCallingReport(week);
    const teams = Object.keys(report).filter(k => !k.startsWith('_'));
    if (!report._hasSession) continue;
    const sheetName = week.slice(5).replace('-','.');
    const HDR_S = XS.hdr('1A5C3A','FFFFFF');
    const SUB_S = XS.hdr('FFCDD2','B71C1C');
    const GRD_S = XS.hdr('0D3B22','FFFFFF');
    const headers = ['Team / Calling By','Said Yes','Came','Absent'];
    const colW = [{wch:24},{wch:10},{wch:10},{wch:10}];
    const rows = [headers.map(h => ({ v:h, s:HDR_S }))];

    let gY=0, gAbsent=0;
    teams.forEach(team => {
      const t = report[team];
      gY += t.yes; gAbsent += t.yesNotCame;
      rows.push([team,t.yes,t.yesAndCame,t.yesNotCame].map((v,i) => ({ v, s: i===0 ? SUB_S : XS.hdr('FFCDD2','B71C1C') })));
      Object.entries(t.callers).forEach(([caller, s]) => {
        rows.push([caller,s.yes,s.yesAndCame,s.yesNotCame].map(v => ({ v, s:XS.cell() })));
      });
    });
    rows.push(['Grand Total',gY,gY-gAbsent,gAbsent].map(v => ({ v, s:GRD_S })));

    const ws = _xlsSheet(rows, colW);
    ws['!freeze'] = { xSplit:0, ySplit:1, topLeftCell:'A2' };
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }
  XLSX.writeFile(wb, filename);
  showToast('Downloaded: ' + filename);
}

const _lateRemarksTimers = {};
async function loadLateReports() {
  const el = document.getElementById('calling-late-content');
  el.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';
  try {
    const { fourWeeks, submMap, teamRows } = await DB.getSubmissionReport();

    // Scope to 4 calling weeks up to the selected session's date (main filter)
    const refDate = (typeof _reportActive !== 'undefined' && _reportActive?.session_date)
      ? _reportActive.session_date
      : getToday();
    const weeks = fourWeeks.filter(w => w <= refDate).slice(-4);

    if (!weeks.length) {
      el.innerHTML = '<div class="empty-state"><i class="fas fa-inbox"></i><p>No submissions yet</p></div>';
      return;
    }

    // Flatten coordinators into one list, annotate lateness per week
    const rows = [];
    teamRows.forEach(({ team, admin, coordinators }) => {
      const names = [admin, ...coordinators.filter(c => c !== admin)].filter(Boolean);
      names.forEach(name => {
        const cells = weeks.map(w => {
          const sub = submMap[w]?.[name];
          if (!sub?.initial) return { text: '—', late: null, state: 'none' };
          const t = new Date(sub.initial);
          const time = t.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', hour12:true });
          const isLate = t.getHours() >= 21;
          return { text: time, late: isLate, state: isLate ? 'late' : 'ok' };
        });
        const lateCount = cells.filter(c => c.late === true).length;
        // Most-recent-late index (weeks are oldest → newest; higher = newer)
        let recentLateIdx = -1;
        cells.forEach((c, i) => { if (c.late) recentLateIdx = Math.max(recentLateIdx, i); });
        rows.push({ name, team, isAdmin: name === admin, cells, lateCount, recentLateIdx });
      });
    });

    // Sort: least late weeks first; tie → least recent lateness first; tie → name
    rows.sort((a, b) => {
      if (a.lateCount !== b.lateCount)          return a.lateCount - b.lateCount;
      if (a.recentLateIdx !== b.recentLateIdx)  return a.recentLateIdx - b.recentLateIdx;
      return a.name.localeCompare(b.name);
    });

    const weekHeaders = weeks.map(w => {
      const dt = new Date(w + 'T00:00:00');
      return `<th class="sr-wk-hdr">
        ${dt.toLocaleDateString('en-IN',{day:'numeric',month:'short'})}
        <br><span style="font-size:.7rem;font-weight:400;opacity:.8">${dt.toLocaleDateString('en-IN',{weekday:'short'})}</span>
      </th>`;
    }).join('');

    // Frozen-column sticky constants
    const SNO_W  = 32;   // px — # column width
    const NAME_W = 140;  // px — Name column min-width
    const HDR_BG = '#dbeafe';
    const NAME_SEP = `border-right:2px solid #94a3b8`;
    const TH_STICKY_SNO  = `position:sticky;left:0;top:0;z-index:6;background:${HDR_BG}`;
    const TH_STICKY_NAME = `position:sticky;left:${SNO_W}px;top:0;z-index:6;background:${HDR_BG};${NAME_SEP}`;

    const STRIPE_ODD  = '#fff';
    const STRIPE_EVEN = '#f1f5f9';
    const LATE_BG     = '#fff7ed';

    const body = rows.map((r, i) => {
      const lastCell = r.cells[r.cells.length - 1];
      const isLate   = lastCell?.state === 'late';
      const rowCls   = isLate ? 'sr-row-late-cur' : '';
      const rowBg    = isLate ? LATE_BG : (i % 2 === 0 ? STRIPE_ODD : STRIPE_EVEN);
      const stickyBg = rowBg;
      const badge = r.isAdmin
        ? `<span class="badge-tc" style="margin-left:.3rem;font-size:.66rem"><i class="fas fa-crown"></i> TC</span>` : '';
      const lateCellColor = r.lateCount > 0 ? 'var(--danger)' : 'var(--text-muted)';
      const lateCellBg   = r.lateCount > 2 ? 'background:#fecdd3' : r.lateCount > 0 ? 'background:#fff7ed' : '';
      return `<tr class="${rowCls}" style="background:${rowBg}">
        <td class="sr-sno-cell" style="position:sticky;left:0;z-index:2;background:${stickyBg};width:${SNO_W}px;min-width:${SNO_W}px">${i + 1}</td>
        <td class="sr-name-cell" style="position:sticky;left:${SNO_W}px;z-index:2;background:${stickyBg};min-width:${NAME_W}px;white-space:nowrap;${NAME_SEP}">${r.name}${badge}</td>
        <td>${teamBadge(r.team)}</td>
        ${r.cells.map(c => {
          if (c.state === 'none') return `<td class="sr-cell sr-empty">—</td>`;
          if (c.state === 'late') return `<td class="sr-cell sr-late"><i class="fas fa-exclamation-circle"></i> ${c.text}</td>`;
          return `<td class="sr-cell sr-ok"><i class="fas fa-check-circle"></i> ${c.text}</td>`;
        }).join('')}
        <td style="text-align:center;font-weight:700;color:${lateCellColor};${lateCellBg}">${r.lateCount}</td>
      </tr>`;
    }).join('');

    el.innerHTML = `
      <div class="sr-legend" style="margin-bottom:.6rem">
        <span class="sr-leg-ok"><i class="fas fa-check-circle"></i> On time</span>
        <span class="sr-leg-late"><i class="fas fa-exclamation-circle"></i> After 9 PM</span>
        <span style="color:var(--text-muted);font-size:.78rem"><i class="fas fa-sort-amount-up"></i> Sorted: most punctual first</span>
      </div>
      <div style="overflow:auto;max-height:calc(100svh - 290px);border-radius:4px">
        <table class="calling-table sr-table" style="margin:0;min-width:440px;border-collapse:separate;border-spacing:0">
          <thead><tr>
            <th class="sr-sno-hdr" style="${TH_STICKY_SNO};width:${SNO_W}px;min-width:${SNO_W}px;text-align:center">#</th>
            <th class="sr-name-hdr" style="${TH_STICKY_NAME};min-width:${NAME_W}px">Name</th>
            <th style="position:sticky;top:0;z-index:3;background:${HDR_BG};min-width:100px">Team</th>
            ${weekHeaders}
            <th style="position:sticky;top:0;z-index:3;background:${HDR_BG};min-width:46px;text-align:center">Late</th>
          </tr></thead>
          <tbody>${body || '<tr><td colspan="99" style="text-align:center;padding:1.5rem;color:var(--text-muted)">No data</td></tr>'}</tbody>
        </table>
      </div>`;
  } catch (e) {
    console.error(e);
    el.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load</p></div>';
  }
}

function saveLateRemark(statusId, remarks) {
  clearTimeout(_lateRemarksTimers[statusId]);
  _lateRemarksTimers[statusId] = setTimeout(async () => {
    try { await DB.saveCallingRemarks(statusId, remarks); } catch (_) {}
  }, 800);
}

// ── Calling History tab — 4-week grid ────────────────────────────────────────
// Shows every devotee's calling status for the last 4 weeks in a scrollable grid.
// A ✏ pencil badge appears on any cell where the status was edited after the
// coordinator had already submitted their calling for that week.

const _statusShort = {
  'Yes':                '✓',
  'Shift':              'Online',
  '':                   '—',
  null:                 '—',
  undefined:            '—',
};
const _reasonShort = {
  did_not_pick:        'No ans',
  incoming_na:         'N/A',
  wrong_number:        'Wrong#',
  out_of_service:      'OOS',
  out_of_station:      'OOStation',
  exams:               'Exams',
  online_class:        'Online',
  festival_calling:    'Festival',
  not_interested_now:  'Not Int',
};

function _csCell(weekEntry) {
  const pencil = weekEntry.wasEdited
    ? `<span class="ch-edited" title="Edited after submission">✏</span>`
    : '';
  if (!weekEntry.cs) {
    return `<div class="ch-cell-inner ch-not-called"><i class="fas fa-circle-notch"></i> Not called</div>`;
  }
  const cs = weekEntry.cs;
  const note = cs.callingNotes
    ? `<div class="ch-cell-note">"${cs.callingNotes}"</div>`
    : '';
  const avail = cs.availableFrom
    ? `<div class="ch-cell-note">Available from: ${cs.availableFrom}</div>`
    : '';
  const late = cs.lateRemarks
    ? `<div class="ch-cell-note">Late: "${cs.lateRemarks}"</div>`
    : '';
  const followBits = [];
  if (cs.triesCount) followBits.push(`${cs.triesCount} tr${cs.triesCount === 1 ? 'y' : 'ies'}`);
  if (cs.texted === 'Yes' || cs.texted === true) followBits.push('texted');
  const follow = followBits.length ? `<div class="ch-cell-note">${followBits.join(', ')}</div>` : '';
  const extra = `${note}${late}${follow}`;
  if (cs.comingStatus === 'Yes') {
    return `<div class="ch-cell-inner ch-cell-yes"><i class="fas fa-check-circle"></i> Coming${pencil}${extra}</div>`;
  }
  if (cs.callingReason) {
    const lbl = _reasonLabel(cs.callingReason);
    return `<div class="ch-cell-inner ch-cell-reason">${lbl}${pencil}${avail}${extra}</div>`;
  }
  // Notes or status only — show them without any "Called" label
  if (cs.callingNotes || cs.comingStatus || cs.lateRemarks || followBits.length) {
    const label = cs.comingStatus || '';
    return `<div class="ch-cell-inner ch-cell-reason">${label}${pencil}${extra}</div>`;
  }
  return `<div class="ch-cell-inner ch-not-called"><i class="fas fa-circle-notch"></i> Not called</div>`;
}

async function loadCallingHistory() {
  const el = document.getElementById('calling-history-grid-content');
  if (!el) return;
  el.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';
  try {
    const teamFilter   = getFilterTeam();
    const callerFilter = getFilterCallingBy();
    const { weeks, devotees, submMap } = await DB.getCallingHistoryGrid(teamFilter, callerFilter);

    if (!devotees.length) {
      el.innerHTML = '<div class="empty-state"><i class="fas fa-history"></i><p>No calling data found</p></div>';
      return;
    }

    // Column headers: short date label + whether each week had any submissions
    const weekHeaders = weeks.map(w => {
      const label = new Date(w + 'T00:00:00').toLocaleDateString('en-IN', { day:'numeric', month:'short' });
      const submitted = submMap[w]?.size > 0;
      return `<th class="ch-wk-hdr" title="${w}">
        ${label}
        ${submitted ? '<br><span class="ch-sub-dot" title="Calling submitted this week">●</span>' : ''}
      </th>`;
    }).join('');

    const bodyRows = devotees.map((d, idx) => {
      const cells = d.weeks.map(w => `<td class="ch-cell">${_csCell(w)}</td>`).join('');
      const safeName = (d.name || '').replace(/'/g, "\\'");
      return `<tr class="chg-row">
        <td class="ch-sticky-sno">${idx + 1}</td>
        <td class="ch-name ch-sticky-name" onclick="openCallingHistory('${d.id}','${safeName}')">${d.name || ''}</td>
        <td class="ch-team-cell">${teamBadge(d.teamName)}</td>
        <td class="ch-caller-cell">${d.callingBy || '—'}</td>
        ${cells}
      </tr>`;
    }).join('');

    const editLegend = `
      <span class="ch-edited" style="display:inline">✏</span>
      <span style="font-size:.75rem;color:var(--text-muted)"> = edited after submission</span>
      &nbsp;&nbsp;
      <span class="ch-sub-dot" style="display:inline"></span>
      <span style="font-size:.75rem;color:var(--text-muted)"> = week submitted</span>`;

    el.innerHTML = `
      <div style="padding:.5rem .75rem .4rem;font-size:.8rem;display:flex;align-items:center;gap:1rem;flex-wrap:wrap">
        <strong><i class="fas fa-history"></i> Last 4 Weeks — Calling History</strong>
        <span>${editLegend}</span>
      </div>
      <div class="ch-scroll-wrap">
        <table class="ch-table" style="border-collapse:separate;border-spacing:0;width:max-content;min-width:100%">
          <thead><tr>
            <th class="ch-sticky-sno ch-hdr-sno" style="text-align:center">#</th>
            <th class="ch-sticky-name ch-hdr-name">Name</th>
            <th style="min-width:90px">Team</th>
            <th style="min-width:90px">Called By</th>
            ${weekHeaders}
          </tr></thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>`;
  } catch (e) {
    console.error('loadCallingHistory', e);
    el.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load</p></div>';
  }
}

// ── Team Calling tab — all facilitators grouped by team ──────────────────────
// superAdmin: sees all teams (master filter bar applies team/caller filter)
// teamAdmin: sees only their own team's facilitators

// ── TEAM CALLING — three-screen flow ──────────────────────────────────
// Screen 1: grid of team summary cards (one card per team)
// Screen 2: caller cards for the selected team (each card = one Calling-By
//           person with their own stats)
// Screen 3: devotee cards for the selected (team, caller) — clicking a
//           devotee opens the 4-week history modal.
//
// _tcSelectedTeam:   null = Screen 1; team name = Screen 2 or 3
// _tcSelectedCaller: null = Screen 2;  caller name = Screen 3
// _tcData:           cached by weekDate so navigation is instant
let _tcSelectedTeam   = null;
let _tcSelectedCaller = null;
let _tcData = null;       // { key, weekDate, allDevotees, submittedCallers, ts }
const _TC_TTL = 3 * 60 * 1000; // re-fetch after 3 min even if week unchanged

function _tcBustCache() { _tcData = null; }
window._tcBustCache = _tcBustCache;

async function loadTeamCallingList() {
  const el = document.getElementById('calling-panel-team-content');
  if (!el) return;
  try {
    const sessionId = (typeof getFilterSessionId === 'function') ? getFilterSessionId() : null;
    const weekDate  = sessionId && (typeof resolveCallingDate === 'function')
      ? await resolveCallingDate(sessionId)
      : null;

    if (!weekDate) {
      el.innerHTML = '<div class="empty-state"><i class="fas fa-calendar-alt"></i><p>No session selected</p></div>';
      return;
    }

    // Cache check: same week → reuse data, just re-render whichever screen.
    if (!_tcData || _tcData.key !== weekDate || Date.now() - _tcData.ts > _TC_TTL) {
      el.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';
      const { devotees: allDevotees, submittedCallers } = await DB.getTeamCallingStatus(weekDate);
      _tcData = { key: weekDate, weekDate, allDevotees, submittedCallers, ts: Date.now() };
    }

    if (_tcSelectedTeam && _tcSelectedCaller) {
      _tcRenderCallerDevotees();
    } else if (_tcSelectedTeam) {
      _tcRenderCallerList();
    } else {
      _tcRenderTeamGrid();
    }
  } catch (e) {
    console.error('loadTeamCallingList', e);
    el.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load</p></div>';
  }
}
window.loadTeamCallingList = loadTeamCallingList;

// ── Screen 1: Team Grid ──
// One card per team showing name + summary (called / total · coming · submitted callers).
// Click → navigate to that team's detail screen.
function _tcRenderTeamGrid() {
  const el = document.getElementById('calling-panel-team-content');
  if (!el || !_tcData) return;
  const { weekDate, allDevotees, submittedCallers } = _tcData;

  // Group by team and compute summary stats
  const teamStats = {};
  allDevotees.forEach(d => {
    const team = d.team_name || 'Unknown';
    if (!teamStats[team]) {
      teamStats[team] = { total: 0, called: 0, coming: 0, callers: new Set(), submitted: new Set() };
    }
    const s = teamStats[team];
    s.total += 1;
    if (d.coming_status || d.calling_reason || d.calling_notes) s.called += 1;
    if (d.coming_status === 'Yes') s.coming += 1;
    if (d.calling_by) {
      s.callers.add(d.calling_by);
      if (submittedCallers.has(d.calling_by)) s.submitted.add(d.calling_by);
    }
  });

  const weekLabel = new Date(weekDate + 'T00:00:00').toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' });
  const teamOrder = (typeof TEAMS !== 'undefined') ? TEAMS : Object.keys(teamStats);
  const totalDevotees = allDevotees.length;
  const totalCallers = new Set(allDevotees.map(d => d.calling_by).filter(Boolean)).size;

  const cards = teamOrder.filter(t => teamStats[t]).map(team => {
    const s = teamStats[team];
    const safeTeam = team.replace(/'/g, "\\'");
    const calledPct = s.total > 0 ? Math.round((s.called / s.total) * 100) : 0;
    const submittedStat = s.callers.size > 0
      ? `${s.submitted.size}/${s.callers.size} submitted`
      : 'No callers';
    return `<div class="tc-team-card" onclick="_tcSelectTeam('${safeTeam}')">
      <div class="tc-team-card-name">${team}</div>
      <div class="tc-team-card-stats">
        <div class="tc-stat"><span class="tc-stat-num">${s.called}/${s.total}</span><span class="tc-stat-lbl">called</span></div>
        <div class="tc-stat"><span class="tc-stat-num tc-stat-yes">${s.coming}</span><span class="tc-stat-lbl">coming</span></div>
        <div class="tc-stat-pct ${calledPct >= 80 ? 'good' : calledPct >= 50 ? 'mid' : 'low'}">${calledPct}%</div>
      </div>
      <div class="tc-team-card-meta">
        <span class="tc-submitted-mini ${s.submitted.size === s.callers.size && s.callers.size > 0 ? 'all' : (s.submitted.size > 0 ? 'partial' : 'none')}"></span>
        ${submittedStat}
      </div>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div class="tc-header">
      <strong><i class="fas fa-users"></i> Team Calling — ${weekLabel}</strong>
      <span class="tc-header-meta">${totalDevotees} devotees · ${totalCallers} callers · ${submittedCallers.size} submitted</span>
    </div>
    <div class="tc-team-grid">${cards}</div>`;
}

// ── Screen 2: Caller list for selected team ──
// One card per "Calling By" person in this team. Each card shows that
// caller's own stats (called/total, coming) + submitted indicator.
// Click a caller → Screen 3 (their devotees).
function _tcRenderCallerList() {
  const el = document.getElementById('calling-panel-team-content');
  if (!el || !_tcData || !_tcSelectedTeam) return;
  const { weekDate, allDevotees, submittedCallers } = _tcData;

  const teamDevotees = allDevotees.filter(d => (d.team_name || 'Unknown') === _tcSelectedTeam);

  // Group by caller, compute stats
  const callerMap = {};
  teamDevotees.forEach(d => {
    const c = d.calling_by || '— Unassigned —';
    if (!callerMap[c]) callerMap[c] = { total: 0, called: 0, coming: 0 };
    callerMap[c].total += 1;
    if (d.coming_status || d.calling_reason || d.calling_notes) callerMap[c].called += 1;
    if (d.coming_status === 'Yes') callerMap[c].coming += 1;
  });

  const weekLabel = new Date(weekDate + 'T00:00:00').toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' });
  const callers = Object.keys(callerMap).sort((a, b) => a.localeCompare(b));

  // Team-level aggregate stats for the header
  const teamTotal  = teamDevotees.length;
  const teamCalled = teamDevotees.filter(d => d.coming_status || d.calling_reason || d.calling_notes).length;
  const teamComing = teamDevotees.filter(d => d.coming_status === 'Yes').length;
  const teamSubmitted = callers.filter(c => submittedCallers.has(c)).length;

  const cards = callers.map(caller => {
    const s = callerMap[caller];
    const safeCaller = caller.replace(/'/g, "\\'");
    const isSubmitted = submittedCallers.has(caller);
    const pct = s.total > 0 ? Math.round((s.called / s.total) * 100) : 0;
    return `<div class="tc-caller-card ${isSubmitted ? 'submitted' : ''}" onclick="_tcSelectCaller('${safeCaller}')">
      <div class="tc-caller-card-head">
        <span class="tc-caller-name">${caller}</span>
        ${isSubmitted ? '<span class="tc-caller-badge">Submitted</span>' : ''}
      </div>
      <div class="tc-caller-card-stats">
        <div class="tc-stat"><span class="tc-stat-num">${s.called}/${s.total}</span><span class="tc-stat-lbl">called</span></div>
        <div class="tc-stat"><span class="tc-stat-num tc-stat-yes">${s.coming}</span><span class="tc-stat-lbl">coming</span></div>
        <div class="tc-stat-pct ${pct >= 80 ? 'good' : pct >= 50 ? 'mid' : 'low'}">${pct}%</div>
      </div>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div class="tc-detail-header">
      <div class="tc-detail-title">
        <div class="tc-detail-team">${_tcSelectedTeam}</div>
        <div class="tc-detail-week">${weekLabel}</div>
      </div>
    </div>
    <div class="tc-detail-stats">
      <span><strong>${teamCalled}/${teamTotal}</strong> called</span>
      <span class="tc-detail-sep">·</span>
      <span><strong>${teamComing}</strong> coming</span>
      <span class="tc-detail-sep">·</span>
      <span><strong>${teamSubmitted}/${callers.length}</strong> submitted</span>
    </div>
    <div class="tc-caller-grid">${cards || '<div class="empty-state"><p>No callers in this team</p></div>'}</div>`;
}

// ── Screen 3: Devotees for selected (team, caller) ──
// Same minimal cc-v2 cards. Click a card → 4-week history modal.
// For super admin, an extra "Mark as Submitted for [Caller]" button shows up.
function _tcRenderCallerDevotees() {
  const el = document.getElementById('calling-panel-team-content');
  if (!el || !_tcData || !_tcSelectedTeam || !_tcSelectedCaller) return;
  const { weekDate, allDevotees, submittedCallers } = _tcData;

  const list = allDevotees.filter(d =>
    (d.team_name || 'Unknown') === _tcSelectedTeam &&
    (d.calling_by || '— Unassigned —') === _tcSelectedCaller
  );

  const weekLabel = new Date(weekDate + 'T00:00:00').toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' });

  const total = list.length;
  const called = list.filter(d => d.coming_status || d.calling_reason || d.calling_notes).length;
  const coming = list.filter(d => d.coming_status === 'Yes').length;
  const isSubmitted = submittedCallers.has(_tcSelectedCaller);
  const isSuperAdmin = AppState.userRole === 'superAdmin';
  const canCrossCall = (typeof canCrossTeamCalling === 'function') && canCrossTeamCalling();

  const sorted = [...list].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const cards = sorted.map(d => renderCallingCard(d, 0, false)).join('');

  // Super-admin OR delegated user (canAllTeamCalling) can submit on behalf of
  // any caller. The flag is granted per-user from the admin panel.
  let submitBar = '';
  if ((isSuperAdmin || canCrossCall) && _tcSelectedCaller && _tcSelectedCaller !== '— Unassigned —') {
    submitBar = isSubmitted
      ? `<div class="tc-submit-bar tc-submit-done">
          <i class="fas fa-check-circle"></i> Submitted on behalf of ${_tcSelectedCaller}
          <button class="btn-link" onclick="_tcResubmitForCaller()">Re-submit</button>
        </div>`
      : `<div class="tc-submit-bar">
          <button class="btn btn-primary tc-submit-btn" onclick="_tcSubmitForCaller()">
            <i class="fas fa-paper-plane"></i> Submit on behalf of ${_tcSelectedCaller}
          </button>
        </div>`;
  }

  el.innerHTML = `
    <div class="tc-detail-header">
      <div class="tc-detail-title">
        <div class="tc-detail-team">${_tcSelectedCaller}</div>
        <div class="tc-detail-week">${_tcSelectedTeam} · ${weekLabel}</div>
      </div>
    </div>
    <div class="tc-detail-stats">
      <span><strong>${called}/${total}</strong> called</span>
      <span class="tc-detail-sep">·</span>
      <span><strong>${coming}</strong> coming</span>
      ${isSubmitted ? '<span class="tc-detail-sep">·</span><span class="tc-detail-submitted"><i class="fas fa-check-circle"></i> submitted</span>' : ''}
    </div>
    ${submitBar}
    <div class="calling-cards">${cards || '<div class="empty-state"><p>No devotees for this caller</p></div>'}</div>`;

  // Stash the calling list in AppState so the history modal's modal-save
  // handlers can find devotee data via AppState.callingData.
  AppState.callingData = list;
}

function _tcSelectTeam(team) {
  _tcSelectedTeam = team;
  _tcSelectedCaller = null;
  history.pushState({ tcScreen: 'callers' }, '');
  _tcRenderCallerList();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function _tcSelectCaller(caller) {
  _tcSelectedCaller = caller;
  history.pushState({ tcScreen: 'devotees' }, '');
  _tcRenderCallerDevotees();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function _tcBackToCallers() {
  _tcSelectedCaller = null;
  _tcRenderCallerList();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function _tcBackToGrid() {
  _tcSelectedTeam = null;
  _tcSelectedCaller = null;
  _tcRenderTeamGrid();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Phone back-key handler for team-calling drill-down screens
window.addEventListener('popstate', function _tcPopHandler(e) {
  // Only intercept when the team-calling sub-tab is active
  if (AppState._callingSubTab !== 'team-calling') return;
  if (_tcSelectedCaller) {
    _tcBackToCallers();
  } else if (_tcSelectedTeam) {
    _tcBackToGrid();
  }
});
async function _tcSubmitForCaller() {
  if (!_tcSelectedCaller || !_tcData) return;
  if (!confirm(`Submit calling list on behalf of "${_tcSelectedCaller}" for ${_tcData.weekDate}?`)) return;
  try {
    // Use a deterministic docId scoped to the caller so super-admin submitting
    // for multiple callers in one session each gets its own submission record.
    const sanitized = _tcSelectedCaller.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase();
    const submitterId = `sa_${AppState.userId}_for_${sanitized}`;
    await DB.submitCallingWeek(_tcData.weekDate, submitterId, _tcSelectedCaller, _tcSelectedTeam);
    _tcData.submittedCallers.add(_tcSelectedCaller);
    showToast(`Submitted on behalf of ${_tcSelectedCaller}`, 'success');
    _tcRenderCallerDevotees();
  } catch (e) {
    console.error('_tcSubmitForCaller', e);
    showToast('Submit failed', 'error');
  }
}
async function _tcResubmitForCaller() {
  // Treat re-submit as a no-op confirmation — re-submission is rarely useful
  // but we expose the option so super-admins aren't locked out.
  return _tcSubmitForCaller();
}
window._tcSelectTeam       = _tcSelectTeam;
window._tcSelectCaller     = _tcSelectCaller;
window._tcBackToCallers    = _tcBackToCallers;
window._tcBackToGrid       = _tcBackToGrid;
window._tcSubmitForCaller  = _tcSubmitForCaller;
window._tcResubmitForCaller = _tcResubmitForCaller;

// ── SAID COMING NOT COME ─────────────────────────────────────────────────────
// Shows devotees who said "Yes" in calling but were absent from the last session.
// Uses callingStatus data + attendance records already fetched in loadCallingStatus.
async function loadSaidComingTab() {
  const el = document.getElementById('calling-said-content');
  if (!el) return;
  el.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';
  try {
    // Use Care's robust implementation which queries Firestore directly
    const sessionDate = (typeof getFilterSessionId === 'function') ? getFilterSessionId() : null;
    const result = await _careFetchSaidComing(sessionDate);
    const list = result?.list || [];
    _renderCorrelationTab(el, list, '😕 Said Coming — Didn\'t Come', '#dc2626', 'Confirmed on call but absent on session');
  } catch (e) {
    el.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load</p></div>';
    console.error('loadSaidComingTab', e);
  }
}
window.loadSaidComingTab = loadSaidComingTab;

// ── NOT COMING BUT PRESENT ────────────────────────────────────────────────────
// Devotees who had no / negative calling status but attended last session.
async function loadNotComingPresentTab() {
  const el = document.getElementById('calling-notcoming-content');
  if (!el) return;
  if (!AppState.callingData?.length) {
    el.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading calling data…</div>';
    await loadCallingStatus().catch(() => {});
  }
  const callingData = AppState.callingData || [];
  const presentSet  = window._callingPresentSet || new Set();

  // Present AND not marked Yes (didn't confirm or no calling record)
  const callingIds = new Set(callingData.map(d => d.id));
  const allDevotees = await DevoteeCache.all().catch(() => []);

  const surprisePresent = allDevotees.filter(d => {
    if (!presentSet.has(d.id)) return false;
    const cal = callingData.find(c => c.id === d.id);
    return !cal || cal.coming_status !== 'Yes';
  });

  _renderCorrelationTab(el, surprisePresent, '🎉 Surprise Present', '#16a34a', 'Attended last session without confirming');
}
window.loadNotComingPresentTab = loadNotComingPresentTab;

function _renderCorrelationTab(el, devotees, title, accentColor, subtitle) {
  if (!devotees.length) {
    el.innerHTML = `<div class="empty-state"><i class="fas fa-check-circle" style="color:#16a34a"></i><p>No devotees in this category</p></div>`;
    return;
  }

  // Group by team
  const byTeam = {};
  devotees.forEach(d => {
    const t = d.teamName || d.team_name || 'Unassigned';
    if (!byTeam[t]) byTeam[t] = [];
    byTeam[t].push(d);
  });

  const TH = `style="padding:.4rem .55rem;background:#0d2d5a;color:#fff;font-weight:700;border:1.5px solid #000;white-space:nowrap"`;

  const summaryRows = Object.entries(byTeam)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([team, list], i) => `
      <tr style="${i % 2 === 0 ? 'background:#fff' : 'background:#f5f7fa'};cursor:pointer" onclick="_openCorrelationList(${JSON.stringify(list).replace(/"/g,'&quot;')}, '${team.replace(/'/g,"\\'")}')">
        <td style="padding:.38rem .55rem;border:1px solid #d1d5db;font-weight:600">${team}</td>
        <td style="padding:.38rem .55rem;border:1px solid #d1d5db;text-align:center;font-weight:800;color:${accentColor};font-size:1rem">${list.length}</td>
      </tr>`).join('');

  el.innerHTML = `
    <div style="margin-bottom:.75rem">
      <div style="font-size:1rem;font-weight:700;color:${accentColor}">${title}</div>
      <div style="font-size:.78rem;color:#64748b;margin-top:.2rem">${subtitle} · <strong>${devotees.length}</strong> total</div>
    </div>
    <div style="margin-bottom:1rem">
      <table style="width:100%;border-collapse:collapse;border:2px solid #000;font-size:.85rem;max-width:400px">
        <thead><tr>
          <th ${TH}>Team</th>
          <th ${TH} style="text-align:center">Count</th>
        </tr></thead>
        <tbody>${summaryRows}</tbody>
      </table>
      <div style="font-size:.72rem;color:#94a3b8;margin-top:.4rem">Tap a team row to see the devotee list</div>
    </div>`;
}
window._renderCorrelationTab = _renderCorrelationTab;

// Stored per-team lists for the drilldown modal
function _openCorrelationList(list, teamName) {
  if (!list || !list.length) return;

  // Build a lookup from callingData for calling status
  const callingLookup = {};
  (AppState.callingData || []).forEach(c => { callingLookup[c.id] = c; });

  // Use item's own coming_status (from previous week) if current week has no data
  const statusLabel = (c, item) => {
    const effective = c || item; // fall back to item's own status
    if (!effective) return { text: '— Not called', color: '#94a3b8', bg: '#f8fafc' };
    if (effective.coming_status === 'Yes') {
      const label = c ? '✅ Confirmed' : '✅ Had Confirmed (last week)';
      return { text: label, color: '#15803d', bg: '#dcfce7' };
    }
    if (effective.calling_reason) {
      const labels = {
        did_not_pick: '📞 Did not pick', incoming_na: '📵 Not reachable',
        out_of_station: '✈️ Out of station', not_interested_now: '🚫 Not interested',
        out_of_service: '📵 Out of service', wrong_number: '❌ Wrong number',
        exams: '📚 Exams',
      };
      const text = labels[effective.calling_reason] || effective.calling_reason;
      return { text, color: '#b45309', bg: '#fef3c7' };
    }
    if (effective.calling_notes) return { text: `💬 ${effective.calling_notes.slice(0,30)}`, color: '#374151', bg: '#f1f5f9' };
    return { text: '— Not called', color: '#94a3b8', bg: '#f8fafc' };
  };

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.innerHTML = `
    <div class="modal-box" style="max-width:500px;width:95vw">
      <div class="modal-header">
        <h2 style="font-size:.95rem"><i class="fas fa-users"></i> ${teamName} (${list.length})</h2>
        <button class="btn-icon close" onclick="this.closest('.modal-overlay').remove()"><i class="fas fa-times"></i></button>
      </div>
      <div style="overflow:auto;max-height:65vh;padding:.5rem 1rem 1rem">
        ${list.map((d, i) => {
          const cal = callingLookup[d.id];
          const st  = statusLabel(cal, d); // d has coming_status from previous week
          return `<div style="display:flex;align-items:center;gap:.6rem;padding:.5rem 0;border-bottom:1px solid #f1f5f9">
            <span style="font-size:.72rem;color:#94a3b8;min-width:1.5rem">${i+1}</span>
            <div class="devotee-avatar" style="width:32px;height:32px;font-size:.7rem;flex-shrink:0">${initials(d.name||'?')}</div>
            <div style="flex:1;min-width:0">
              <div style="font-weight:700;font-size:.88rem;color:#0f172a">${d.name||'—'}</div>
              <div style="font-size:.73rem;color:#64748b">${d.mobile||'—'}</div>
            </div>
            <span style="font-size:.72rem;font-weight:600;color:${st.color};background:${st.bg};padding:.15rem .4rem;border-radius:6px;white-space:nowrap;max-width:140px;overflow:hidden;text-overflow:ellipsis">${st.text}</span>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  document.body.appendChild(overlay);
}
window._openCorrelationList = _openCorrelationList;

window.addEventListener('filtersChanged', () => {
  // Derive active tab from DOM, not AppState.currentTab — same drift-safety
  // reasoning as in _mfbOnFiltersChanged.
  const panel = document.querySelector('.tab-panel.active');
  const tab = panel?.id?.replace('tab-', '') || AppState.currentTab;
  if (tab !== 'calling') return;
  if (AppState._callingSubTab === 'team-calling')        loadTeamCallingList();
  else if (AppState._callingSubTab === 'said-coming')    loadSaidComingTab?.();
  else if (AppState._callingSubTab === 'not-coming-present') loadNotComingPresentTab?.();
});

// ── Calling Change History modal ─────────────────────────────────────────────
// Called from the devotee profile view (Team tab → "Calling Change History" button).
// Shows each edit made to this devotee's callingStatus docs, what changed and who did it.
async function openCallingChangeHistory(devoteeId, devoteeName) {
  // Remove any existing instance
  document.getElementById('_call-hist-modal')?.remove();

  const overlay = document.createElement('div');
  overlay.id = '_call-hist-modal';
  overlay.className = 'modal-overlay';
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  overlay.innerHTML = `
    <div class="modal-box" style="max-width:540px;width:95vw">
      <div class="modal-header">
        <h2 style="font-size:1rem"><i class="fas fa-history"></i> Calling Changes — ${devoteeName || 'Devotee'}</h2>
        <button class="btn-icon close" onclick="document.getElementById('_call-hist-modal')?.remove()">
          <i class="fas fa-times"></i>
        </button>
      </div>
      <div id="_call-hist-body" style="overflow:auto;max-height:65vh;padding:.5rem 1rem 1rem">
        <div class="loading"><i class="fas fa-spinner"></i> Loading…</div>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  history.pushState(null, '', location.href);

  try {
    const records = await DB.getCallingStatusChanges(devoteeId);
    const el = document.getElementById('_call-hist-body');
    if (!el) return;

    if (!records.length) {
      el.innerHTML = '<div class="empty-state" style="padding:2rem"><i class="fas fa-check-circle" style="color:var(--success)"></i><p>No edits recorded yet — only changes after this update is live are tracked.</p></div>';
      return;
    }

    // Human-readable labels for the changed fields
    const fieldLabel = { comingStatus: 'Coming', callingReason: 'Reason', callingNotes: 'Notes' };
    const reasonLabel = {
      did_not_pick: 'Did not pick', incoming_na: 'Incoming N/A', wrong_number: 'Wrong number',
      out_of_station: 'Out of station', exams: 'Exams', online_class: 'Online class',
      festival_calling: 'Festival', not_interested_now: 'Not interested this week',
      out_of_service: 'Out of service', '': '—',
    };
    const statusLabel = v => v === 'Yes' ? '✓ Coming' : v === 'Shift' ? 'Online' : v || '—';
    const valLabel = (field, val) => {
      if (field === 'comingStatus') return statusLabel(val);
      if (field === 'callingReason') return reasonLabel[val] || val || '—';
      return val || '—';
    };

    el.innerHTML = records.map(r => {
      const when = r.changedAtClient
        ? new Date(r.changedAtClient).toLocaleString('en-IN', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', hour12:true })
        : '—';
      const weekDisp = r.weekDate
        ? new Date(r.weekDate + 'T00:00:00').toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' })
        : '—';

      const changesHtml = Object.entries(r.changes || {}).map(([field, { from, to }]) => `
        <div style="display:flex;align-items:center;gap:.4rem;flex-wrap:wrap;margin-top:.25rem">
          <span style="font-size:.72rem;background:#f1f5f9;border-radius:3px;padding:.1rem .35rem;color:var(--text-muted)">${fieldLabel[field] || field}</span>
          <span style="font-size:.8rem;color:#c62828;text-decoration:line-through">${valLabel(field, from)}</span>
          <i class="fas fa-arrow-right" style="font-size:.65rem;color:var(--text-muted)"></i>
          <span style="font-size:.8rem;color:var(--success);font-weight:600">${valLabel(field, to)}</span>
        </div>`).join('');

      return `
        <div style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:.6rem .75rem;margin-bottom:.5rem">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem">
            <div>
              <span style="font-size:.72rem;background:var(--accent-light);color:var(--brand);border-radius:3px;padding:.1rem .35rem;font-weight:600">Week: ${weekDisp}</span>
              <span style="font-size:.72rem;color:var(--text-muted);margin-left:.4rem">by <strong>${r.changedBy || '—'}</strong></span>
            </div>
            <span style="font-size:.7rem;color:var(--text-muted);white-space:nowrap">${when}</span>
          </div>
          ${changesHtml}
        </div>`;
    }).join('');
  } catch (e) {
    const el = document.getElementById('_call-hist-body');
    if (el) el.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load history</p></div>';
    console.error('openCallingChangeHistory', e);
  }
}

// Calling Summary — click team row to expand/collapse its facilitators
function _toggleCSReportTeam(teamId, rowEl) {
  const rows = document.querySelectorAll('.cs-caller-' + teamId);
  if (!rows.length) return;
  const open = rows[0].style.display !== 'none';
  rows.forEach(r => { r.style.display = open ? 'none' : ''; });
  const chev = rowEl.querySelector('.cs-team-chev');
  if (chev) chev.style.transform = open ? '' : 'rotate(90deg)';
}

// ── Calling-stat detail modal ─────────────────────────────────
// Click any stat pill (Confirmed / Not reached / Online / Festival / Not Interested
// / Not called) to see the actual devotees behind that number — read-only view.
// Bulk actions are not exposed here; they live in the Calling Mgmt tab.
let _csModalDevotees = [];
let _csModalTitle = '';

function openCallingStatList(type) {
  // Respect the currently-active filters on the Calling page so the stat
  // drilldown shows only the devotees the user is currently looking at.
  const allRaw = AppState.callingData || [];
  const fTeam = document.getElementById('calling-filter-team')?.value      || '';
  const fBy   = document.getElementById('calling-filter-callingby')?.value || '';
  const fQ    = (document.getElementById('calling-search')?.value || '').toLowerCase();
  const all = allRaw.filter(d => {
    if (fTeam && d.team_name !== fTeam) return false;
    if (fBy   && d.calling_by !== fBy)  return false;
    if (fQ && !((d.name || '').toLowerCase().includes(fQ) || (d.mobile || '').includes(fQ))) return false;
    return true;
  });
  const coreReasons = ['incoming_na','out_of_service','wrong_number','did_not_pick','out_of_station','exams','not_interested_now','online_class','festival_calling'];
  const map = {
    confirmed:      { title: '✅ Yes — Coming',              icon: 'fas fa-check-circle',  color: '#16a34a', filter: d => d.coming_status === 'Yes' },
    not_reached:    { title: '📵 Not Reached',               icon: 'fas fa-phone-slash',   color: '#b91c1c', filter: d => ['incoming_na','out_of_service','wrong_number'].includes(d.calling_reason) },
    not_pick:       { title: '📞 Did Not Pick',              icon: 'fas fa-phone',         color: '#d97706', filter: d => d.calling_reason === 'did_not_pick' },
    unavailable:    { title: '✈️ Out of Station',           icon: 'fas fa-calendar-times',color: '#7c3aed',  filter: d => ['out_of_station','exams'].includes(d.calling_reason) },
    not_interested: { title: '🚫 Not Interested',            icon: 'fas fa-ban',           color: '#dc2626', filter: d => d.calling_reason === 'not_interested_now' },
    other_reason:   { title: '💬 Other Reason',             icon: 'fas fa-comment',       color: '#64748b', filter: d => d.calling_reason && !coreReasons.includes(d.calling_reason) },
    online:         { title: 'Online Class',                 icon: 'fas fa-laptop',        color: '#0288d1', filter: d => d.calling_reason === 'online_class' },
    festival:       { title: 'Festival Calling',             icon: 'fas fa-star',          color: '#f57f17', filter: d => d.calling_reason === 'festival_calling' },
    uncalled:       { title: '⏳ Not Called Yet',            icon: 'fas fa-circle-notch',  color: '#94a3b8', filter: d => !d.coming_status && !d.calling_reason && !d.calling_notes },
  };
  const cfg = map[type];
  if (!cfg) return;
  _csModalDevotees = all.filter(cfg.filter);
  _csModalTitle = `<i class="${cfg.icon}" style="color:${cfg.color}"></i> ${cfg.title}`;
  document.getElementById('cs-modal-title').innerHTML =
    `${_csModalTitle} <span style="color:var(--text-muted);font-weight:400;font-size:.85rem">(${_csModalDevotees.length})</span>`;
  document.getElementById('cs-modal-search').value = '';

  _renderCSModal();
  openModal('calling-stat-modal');
}

// Stubs kept so any inline onchange="…" on legacy markup doesn't error during
// the rollout. The master filter bar now drives team / callingBy.
function _populateCSModalCallers() {}
function _onCSModalTeamChange() {}

function _renderCSModal() {
  const q       = (document.getElementById('cs-modal-search')?.value || '').trim().toLowerCase();
  // Modal always inherits the master bar's Team and Calling By context.
  const teamVal = (typeof getFilterTeam      === 'function') ? getFilterTeam()      : '';
  const byVal   = (typeof getFilterCallingBy === 'function') ? getFilterCallingBy() : '';
  const list = _csModalDevotees.filter(d => {
    if (teamVal && d.team_name !== teamVal) return false;
    if (byVal   && d.calling_by !== byVal)  return false;
    if (q && !((d.name || '').toLowerCase().includes(q) ||
               (d.mobile || '').includes(q) ||
               (d.mobile_alt || '').includes(q))) return false;
    return true;
  });
  const el = document.getElementById('cs-modal-content');
  if (!list.length) {
    el.innerHTML = '<div class="empty-state" style="padding:2rem"><i class="fas fa-inbox"></i><p>No devotees</p></div>';
    return;
  }
  el.innerHTML = `
    <div class="table-scroll"><table class="report-table tbl-freeze-name">
      <thead><tr>
        <th>#</th><th>Name</th><th>Mobile</th><th>Team</th><th>Calling By</th>
      </tr></thead>
      <tbody>${list.map((d, i) => `<tr>
          <td style="color:var(--text-muted)">${i + 1}</td>
          <td><button class="cm-link" onclick="openProfileModal('${d.id}')">${d.name || '—'}</button></td>
          <td>${d.mobile ? contactIcons(d.mobile, { altMobile: d.mobile_alt, devoteeId: d.id, name: d.name }) + ' <span style="font-size:.78rem">' + d.mobile + '</span>' : '—'}</td>
          <td>${teamBadge(d.team_name)}</td>
          <td style="font-size:.82rem">${d.calling_by || '—'}</td>
        </tr>`).join('')}</tbody>
    </table></div>`;
}

// Calling-stat modal is read-only (view + filter only). Bulk actions live
// exclusively in the Calling Mgmt tab — no selection state needed here.

// ── SWIPE-TO-ACTION on calling cards (touch only) ───────────────────────
// Drag a card RIGHT → place a call; drag LEFT → open WhatsApp. The tap
// buttons still work, and desktop mouse drags are ignored (touch only).
(function initCallingSwipe() {
  const THRESHOLD = 70;   // px past which the action fires on release
  const MAX = 110;        // max visual drag distance
  let content = null, card = null, mobile = '';
  let startX = 0, startY = 0, dx = 0, decided = false, horizontal = false;

  function reset() {
    if (content) {
      content.style.transform = '';
      card.classList.remove('cc-swiping', 'cc-show-call', 'cc-show-wa');
    }
    content = card = null; mobile = ''; dx = 0; decided = false; horizontal = false;
  }
  const waNumber = m => (m.length === 10 ? '91' + m : m);

  function onDown(e) {
    if (e.pointerType !== 'touch') return;
    const c = e.target.closest('.cc-v2-content');
    if (!c || e.target.closest('.cc-v2-actions')) return;  // buttons handle their own taps
    content = c;
    card = c.closest('.calling-card.cc-v2');
    mobile = (card && card.dataset.mobile || '').replace(/\D/g, '');
    startX = e.clientX; startY = e.clientY;
    dx = 0; decided = false; horizontal = false;
  }

  function onMove(e) {
    if (!content) return;
    dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!decided) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      decided = true;
      horizontal = Math.abs(dx) > Math.abs(dy);
      if (horizontal) card.classList.add('cc-swiping');
    }
    if (!horizontal) { reset(); return; }   // vertical scroll wins — bail out
    e.preventDefault();
    const clamped = Math.max(-MAX, Math.min(MAX, dx));
    content.style.transform = `translateX(${clamped}px)`;
    card.classList.toggle('cc-show-call', dx > THRESHOLD);
    card.classList.toggle('cc-show-wa',   dx < -THRESHOLD);
  }

  function onUp() {
    if (!content) return;
    const fire = horizontal && Math.abs(dx) > THRESHOLD && mobile;
    const callDir = dx > 0;
    const c = content, m = mobile;
    if (fire) {
      // Swallow the click that would otherwise open the history modal.
      const swallow = ev => { ev.stopPropagation(); ev.preventDefault(); };
      c.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => c.removeEventListener('click', swallow, true), 350);
      if (callDir) window.location.href = 'tel:' + m;
      else         window.open('https://wa.me/' + waNumber(m), '_blank', 'noopener');
    }
    reset();
  }

  document.addEventListener('pointerdown', onDown, { passive: true });
  document.addEventListener('pointermove', onMove, { passive: false });
  document.addEventListener('pointerup', onUp, { passive: true });
  document.addEventListener('pointercancel', reset, { passive: true });
})();
