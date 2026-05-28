/* ══ UI-HOME.JS – Home tab ══ */

// ── HOME INIT ─────────────────────────────────────────
// Renders the greeting + smart hero CTA (today-aware) + sub-line + kicks
// off the My-Calling-Progress card and Today's-Activity report renderers.
// _dashRender (in ui-analytics.js) replaces the sub-line with richer detail
// once the dashboard fetch completes.
function loadHome() {
  const firstName = (AppState.userName || '').split(' ')[0] || 'Devotee';

  const greet = document.getElementById('home-greeting');
  if (greet) greet.textContent = `Hare Krishna, ${firstName}.`;

  // Sub-line fallback while dashboard fetch is in flight.
  const sub = document.getElementById('dash-greet-sub');
  if (sub) {
    const today = new Date();
    const dayName  = today.toLocaleDateString('en-IN', { weekday: 'long' });
    const dateLbl  = today.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    const dayIdx   = today.getDay();
    const context  = dayIdx === 0 ? 'class day' : (dayIdx === 6 ? 'calling day' : 'sevā day');
    sub.textContent = `${dayName}, ${dateLbl} · ${context}`;
  }

  // The consolidated session card (ring + stats + calling status) renders here.
  renderTodaysActivity();
}

// ── REFRESH BUTTON ────────────────────────────────────
// Wrapper around loadDashboard that animates the refresh icon while busy.
async function refreshDashboard() {
  const btn = document.querySelector('.ss-home-refresh');
  const icon = btn?.querySelector('i');
  if (icon) icon.classList.add('fa-spin');
  try {
    if (typeof loadDashboard === 'function') await loadDashboard();
    renderTodaysActivity();
  } finally {
    if (icon) icon.classList.remove('fa-spin');
  }
}
window.refreshDashboard = refreshDashboard;

// When master filter changes (team / session / calling-by), re-render the
// consolidated session card. The dashboard table is handled separately by
// _mfbOnFiltersChanged → loadDashboard.
window.addEventListener('filtersChanged', () => {
  const activePanel = document.querySelector('.tab-panel.active');
  if (activePanel?.id !== 'tab-dashboard') return;
  renderTodaysActivity();
});

// Helper: find the Saturday on/before the given date as YYYY-MM-DD.
function _saturdayBefore(d) {
  const day = d.getDay();
  const back = (day + 1) % 7; // Sat=6 → 0, Sun=0 → 1, Mon=1 → 2, …
  const sat = new Date(d);
  sat.setDate(d.getDate() - back);
  return `${sat.getFullYear()}-${String(sat.getMonth()+1).padStart(2,'0')}-${String(sat.getDate()).padStart(2,'0')}`;
}

// Compute consecutive-week submission streak going back from this week.
// Reads up to 8 past weeks of callingSubmissions and counts consecutive
// weeks the user has a submission record.
async function _computeCallingStreak(userId) {
  if (!userId) return 0;
  const weeks = [];
  const today = new Date();
  let sat = new Date(today);
  sat.setDate(today.getDate() - ((today.getDay() + 1) % 7));
  for (let i = 0; i < 8; i++) {
    const d = new Date(sat);
    d.setDate(sat.getDate() - 7 * i);
    weeks.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`);
  }
  let streak = 0;
  for (const w of weeks) {
    try {
      const sub = await DB.getMyCallingSubmission(w, userId);
      if (sub && sub.submittedAtClient) streak++; else break;
    } catch (_) { break; }
  }
  return streak;
}

// ══════════════════════════════════════════════════════
// TODAY'S ACTIVITY REPORT
// Saturday → callers table (Name | Team | Streak | Submitted | Time | Coming)
// Sunday   → 4 stat tiles (In calling | Coming | Came | Said-coming no-show)
// Other    → most-recent-Sunday attendance snapshot
// ══════════════════════════════════════════════════════
async function renderTodaysActivity() {
  const wrap   = document.getElementById('ss-activity-card');
  const title  = document.getElementById('ss-activity-title');
  const link   = document.getElementById('ss-activity-link-label');
  const linkEl = document.getElementById('ss-activity-link');
  const icon   = document.getElementById('ss-activity-icon');
  if (!wrap) return;

  const dayIdx = new Date().getDay();
  // If a session is picked in the master filter, prefer that date for the title
  // (otherwise the snapshot looks generic and feels stale).
  const filterSession = (typeof getFilterSessionId === 'function') ? getFilterSessionId() : null;
  const sessionLabel = filterSession
    ? new Date(filterSession + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : '';
  try {
    if (dayIdx === 6 && !filterSession) {
      // SATURDAY: calling day — only when user hasn't picked a specific session
      if (title) title.textContent = 'Calling Activity Today';
      if (link)  link.textContent  = 'Team Calling';
      if (icon)  icon.className    = 'fas fa-phone-alt';
      if (linkEl) linkEl.onclick = () => navTabView('calling','team-calling');
      await _renderCallingActivityTable(wrap);
    } else if (dayIdx === 0 && !filterSession) {
      // SUNDAY (today): class day
      if (title) title.textContent = 'Class Attendance Today';
      if (link)  link.textContent  = 'Attendance';
      if (icon)  icon.className    = 'fas fa-users';
      if (linkEl) linkEl.onclick = () => navTabView('attendance','live');
      await _renderAttendanceActivityTiles(wrap);
    } else {
      // Other days OR an explicitly picked session → show that session's snapshot
      if (title) title.textContent = sessionLabel ? `Session Snapshot · ${sessionLabel}` : 'Last Session Snapshot';
      if (link)  link.textContent  = 'Reports';
      if (icon)  icon.className    = 'fas fa-chart-bar';
      if (linkEl) linkEl.onclick = () => navTabView('attendance','live');
      await _renderAttendanceActivityTiles(wrap);
    }
  } catch (e) {
    console.error('renderTodaysActivity', e);
    wrap.innerHTML = '<div class="empty-state" style="padding:1rem"><p>Could not load today\'s activity</p></div>';
  }
}

// ── Saturday: callers table ──
async function _renderCallingActivityTable(wrap) {
  const cfg = await DB.getCallingWeekConfig().catch(() => null);
  const weekDate = cfg?.callingDate || _saturdayBefore(new Date());
  if (!weekDate) { wrap.innerHTML = '<div class="empty-state" style="padding:1rem"><p>No calling week configured</p></div>'; return; }

  const { devotees, submittedCallers } = await DB.getTeamCallingStatus(weekDate);
  // Group by caller, compute per-caller stats.
  const teamFilter = (typeof getFilterTeam === 'function') ? getFilterTeam() : '';
  const filtered = teamFilter ? devotees.filter(d => d.team_name === teamFilter) : devotees;

  const byCaller = {};
  filtered.forEach(d => {
    const c = d.calling_by;
    if (!c) return;
    if (!byCaller[c]) byCaller[c] = { caller: c, team: d.team_name || '—', total: 0, called: 0, coming: 0 };
    const s = byCaller[c];
    s.total += 1;
    if (d.coming_status || d.calling_reason || d.calling_notes) s.called += 1;
    if (d.coming_status === 'Yes') s.coming += 1;
  });

  const callers = Object.values(byCaller).sort((a, b) => a.caller.localeCompare(b.caller));
  if (!callers.length) {
    wrap.innerHTML = '<div class="empty-state" style="padding:1rem"><p>No callers assigned yet</p></div>';
    return;
  }

  // Submissions — find time per caller for this week.
  const subs = await DB.getCallingSubmissions([weekDate]).catch(() => ({}));
  const subMap = subs?.[weekDate] || {};
  const subTimeByCaller = {};
  Object.values(subMap).forEach(s => {
    if (s && s.userName) subTimeByCaller[s.userName] = s.submittedAtClient || s.submittedAt;
  });

  const rows = callers.map(c => {
    const submitted = submittedCallers.has(c.caller);
    const time = subTimeByCaller[c.caller]
      ? new Date(subTimeByCaller[c.caller]).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
      : '—';
    return `<tr>
      <td class="ss-act-name">${c.caller}</td>
      <td><span class="ss-act-team">${c.team}</span></td>
      <td>${c.called}/${c.total}</td>
      <td>${submitted ? '<span class="ss-act-submitted-yes"><i class="fas fa-check-circle"></i> Yes</span>' : '<span class="ss-act-submitted-no">—</span>'}</td>
      <td class="ss-act-time">${time}</td>
      <td class="ss-act-coming">${submitted ? c.coming : '—'}</td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `
    <div class="ss-act-table-wrap">
      <table class="ss-act-table">
        <thead><tr>
          <th class="ss-act-name">Caller</th>
          <th>Team</th>
          <th>Called</th>
          <th>Submitted</th>
          <th>Time</th>
          <th>Coming</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ── Sunday (or default): 4 attendance stat tiles ──
async function _renderAttendanceActivityTiles(wrap) {
  // Session resolution priority:
  //   1. Master Session filter (so changing the Session chip re-renders correctly)
  //   2. Today if it's Sunday
  //   3. Most recent past Sunday session
  // Without #1 the tile shows stale numbers — that was the
  // "data doesn't change when I change the filter" bug.
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  let sessionDate;
  let sessionId;
  const filterSession = (typeof getFilterSessionId === 'function') ? getFilterSessionId() : null;
  if (filterSession) {
    sessionDate = filterSession;
  } else if (today.getDay() === 0) {
    sessionDate = todayStr;
  } else {
    // Find most recent past Sunday session
    const snap = await fdb.collection('sessions')
      .where('sessionDate', '<=', todayStr)
      .orderBy('sessionDate', 'desc').limit(1).get().catch(() => null);
    if (snap && !snap.empty) {
      sessionDate = snap.docs[0].data().sessionDate;
      sessionId   = snap.docs[0].id;
    }
  }
  if (!sessionDate) {
    wrap.innerHTML = '<div class="empty-state" style="padding:1rem"><p>No session yet</p></div>';
    return;
  }
  if (!sessionId) {
    const snap = await fdb.collection('sessions').where('sessionDate','==',sessionDate).limit(1).get().catch(() => null);
    if (snap && !snap.empty) sessionId = snap.docs[0].id;
  }

  // Calling-week (Saturday) for confirmed-coming count
  const callingDate = (typeof resolveCallingDate === 'function')
    ? await resolveCallingDate(sessionDate).catch(() => null)
    : null;

  // Master Team filter
  const teamFilter = (typeof getFilterTeam === 'function') ? getFilterTeam() : '';

  // Fetch everything we need
  const [allDev, csSnap, atSnap] = await Promise.all([
    DevoteeCache.all().catch(() => []),
    callingDate
      ? fdb.collection('callingStatus').where('weekDate','==',callingDate).get().catch(() => ({ docs: [] }))
      : Promise.resolve({ docs: [] }),
    sessionId
      ? fdb.collection('attendanceRecords').where('sessionId','==',sessionId).get().catch(() => ({ docs: [] }))
      : Promise.resolve({ docs: [] }),
  ]);

  const teamMatch = d => !teamFilter || (d.teamName || d.team_name) === teamFilter;
  const csByDev   = {};
  csSnap.docs.forEach(d => { csByDev[d.data().devoteeId] = d.data(); });
  const presentSet = new Set(atSnap.docs.map(d => d.data().devoteeId));

  // Devotees in calling list this week (assigned + active + not opted-out)
  const inCalling = allDev.filter(d =>
    d.isActive !== false && !d.isNotInterested &&
    d.callingMode !== 'not_interested' && d.callingMode !== 'online' &&
    d.callingBy && d.callingBy.trim() && teamMatch(d)
  );

  const comingList  = inCalling.filter(d => csByDev[d.id]?.comingStatus === 'Yes');
  const cameList    = inCalling.filter(d => presentSet.has(d.id));
  const noShowList  = inCalling.filter(d => csByDev[d.id]?.comingStatus === 'Yes' && !presentSet.has(d.id));
  const totalCalling = inCalling.length;

  // Stash the precise devotee lists behind each stat so a tap shows exactly WHO.
  const mapDev = d => ({
    id: d.id, name: d.name || '—', mobile: d.mobile || '',
    team_name: d.teamName || '', calling_by: d.callingBy || '',
    reference_by: d.referenceBy || '', chanting_rounds: d.chantingRounds || 0,
  });
  _homeSnapLists = {
    inCalling:  inCalling.map(mapDev),
    coming:     comingList.map(mapDev),
    came:       cameList.map(mapDev),
    saidComing: noShowList.map(mapDev),
  };

  // Target ring — % of the team target that confirmed "coming". Conditional colour.
  let target = totalCalling;
  try {
    const tcfg = await DB.getAttendanceTargets();
    if (tcfg) {
      const tt = tcfg.teams?.[teamFilter || ''];
      target = tt > 0 ? tt : (tcfg.global > 0 ? tcfg.global : totalCalling);
    }
  } catch (_) {}
  const targetPct = target > 0 ? Math.min(100, Math.round((comingList.length / target) * 100)) : 0;
  const ringCls   = targetPct >= 80 ? 'ring-good' : targetPct >= 50 ? 'ring-mid' : 'ring-low';

  // Super admins are NOT callers → they only see the report (stats), no streak,
  // no Continue/Resubmit CTA. Callers (coordinator/facilitator) get the personal
  // bits — but the submit CTA only appears when the calling window is OPEN
  // (toggle in Session Configuration, not tied to Saturday).
  const isCaller = AppState.userRole !== 'superAdmin';
  let streak = 0, submitted = false, windowOpen = false;
  if (isCaller) {
    try { streak = await _computeCallingStreak(AppState.userId); } catch (_) {}
    try {
      const cw = await DB.getCallingWeekConfig();
      windowOpen = (typeof isCallingWindowOpen === 'function') ? isCallingWindowOpen(cw) : (cw?.callingWindowOpen === true);
    } catch (_) {}
    if (callingDate) {
      try {
        const mySub = await DB.getMyCallingSubmission(callingDate, AppState.userId);
        submitted = !!(mySub && mySub.submittedAtClient);
      } catch (_) {}
    }
  }

  wrap.innerHTML = `
    <div class="snap">
      ${isCaller && streak > 0 ? `<div class="snap__streak"><i class="fas fa-fire"></i> ${streak} day streak</div>` : ''}
      <div class="snap__body">
        <div class="snap__ring ${ringCls}">
          <svg viewBox="0 0 36 36" class="snap__ring-svg" aria-hidden="true">
            <circle cx="18" cy="18" r="15.9155" class="snap__ring-bg"></circle>
            <circle cx="18" cy="18" r="15.9155" class="snap__ring-fg" stroke-dasharray="${targetPct} ${100 - targetPct}"></circle>
          </svg>
          <div class="snap__ring-txt">${targetPct}%</div>
          <div class="snap__ring-cap">Target</div>
        </div>
        <div class="snap__stats">
          <button class="snap__stat" onclick="openHomeSnapList('inCalling')"><span class="snap__stat-num">${totalCalling}</span><span class="snap__stat-lbl">In calling</span></button>
          <button class="snap__stat snap__stat--coming" onclick="openHomeSnapList('coming')"><span class="snap__stat-num">${comingList.length}</span><span class="snap__stat-lbl">Coming</span></button>
          <button class="snap__stat snap__stat--came" onclick="openHomeSnapList('came')"><span class="snap__stat-num">${cameList.length}</span><span class="snap__stat-lbl">Came</span></button>
          <button class="snap__stat snap__stat--noshow" onclick="openHomeSnapList('saidComing')"><span class="snap__stat-num">${noShowList.length}</span><span class="snap__stat-lbl">No-show</span></button>
        </div>
      </div>
      ${isCaller && windowOpen ? `<button class="snap__cta" onclick="navTabView('calling','calls')">
        <i class="fas fa-phone-alt"></i> ${submitted ? 'Resubmit calling' : 'Continue calling'}
        <i class="fas fa-arrow-right" style="margin-left:auto"></i>
      </button>` : ''}
    </div>`;
}

// Tap a snapshot tile → show the exact devotees behind that number, reusing
// the Care-detail modal (same table + export the rest of the app uses).
let _homeSnapLists = {};
function openHomeSnapList(kind) {
  const titles = {
    inCalling: 'In Calling List', coming: 'Confirmed Coming',
    came: 'Attended (Came)', saidComing: 'Said Coming · No-show',
  };
  const list = _homeSnapLists[kind] || [];
  if (typeof _careCache !== 'undefined') {
    _careCache._homeSnap = { title: titles[kind] || 'Devotees', list };
    _careCurrentType = '_homeSnap';
    if (typeof openCareDetail === 'function') { openCareDetail('_homeSnap'); return; }
  }
  showToast?.('Could not open list', 'error');
}
window.openHomeSnapList = openHomeSnapList;

// ══════════════════════════════════════════════════════
// Activity-tile click → reuse the existing Care-detail modal.
// Loads Care data if not yet populated, then opens the modal
// for the chosen bucket. 'saidComing' shows devotees who confirmed
// Yes but didn't come — same modal Care tab uses.
// ══════════════════════════════════════════════════════
async function openHomeActivityList(bucket) {
  try {
    // Ensure care data is populated (idempotent — uses cache if same session).
    if (typeof loadCareData === 'function') await loadCareData();
    if (typeof openCareDetail === 'function') openCareDetail(bucket);
    else if (typeof showToast === 'function') showToast('Could not open details', 'error');
  } catch (e) {
    console.error('openHomeActivityList', e);
    if (typeof showToast === 'function') showToast('Failed to load list', 'error');
  }
}
window.openHomeActivityList = openHomeActivityList;

// ── ATTENDANCE SESSION REPORT ─────────────────────────
async function openAttendanceReport() {
  openModal('home-att-report-modal');
  await loadAttendanceReport();
}

async function loadAttendanceReport() {
  const body        = document.getElementById('att-report-body');
  const label       = document.getElementById('att-report-session-label');
  const sessionId   = AppState.currentSessionId;
  const sessionDate = getFilterSessionId();

  if (!sessionId || !sessionDate) {
    body.innerHTML = '<tr><td colspan="6" class="empty-cell">No session selected. Use the Session filter to pick one.</td></tr>';
    if (label) label.textContent = '—';
    return;
  }
  body.innerHTML = '<tr><td colspan="6" class="loading-cell"><i class="fas fa-spinner fa-spin"></i> Loading…</td></tr>';
  if (label) label.textContent = formatDate(sessionDate);

  // Derive calling week date: prefer config match, else session-date minus 1 day.
  let callingDate = '';
  try {
    const cfg = await DB.getCallingWeekConfig();
    if (cfg?.sessionDate === sessionDate && cfg?.callingDate) {
      callingDate = cfg.callingDate;
    } else {
      const d = new Date(sessionDate + 'T00:00:00');
      d.setDate(d.getDate() - 1);
      callingDate = localDateStr(d);
    }
  } catch (_) {
    const d = new Date(sessionDate + 'T00:00:00');
    d.setDate(d.getDate() - 1);
    callingDate = localDateStr(d);
  }

  try {
    const rows = await DB.getAttendanceSessionReport(sessionId, callingDate);
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="6" class="empty-cell">No data found for this session.</td></tr>';
      return;
    }
    const tot = rows.reduce((a, r) => ({
      total: a.total + r.total, called: a.called + r.called,
      saidComing: a.saidComing + r.saidComing,
      actuallyCame: a.actuallyCame + r.actuallyCame,
      saidComingNotCame: a.saidComingNotCame + r.saidComingNotCame,
    }), { total: 0, called: 0, saidComing: 0, actuallyCame: 0, saidComingNotCame: 0 });

    body.innerHTML = rows.map(r => `
      <tr>
        <td><span class="team-badge-sm">${r.team}</span></td>
        <td class="num-cell">${r.total}</td>
        <td class="num-cell">${r.called}</td>
        <td class="num-cell coming-cell">${r.saidComing}</td>
        <td class="num-cell came-cell">${r.actuallyCame}</td>
        <td class="num-cell notcame-cell">${r.saidComingNotCame}</td>
      </tr>`).join('') + `
      <tr class="totals-row">
        <td><strong>TOTAL</strong></td>
        <td class="num-cell"><strong>${tot.total}</strong></td>
        <td class="num-cell"><strong>${tot.called}</strong></td>
        <td class="num-cell coming-cell"><strong>${tot.saidComing}</strong></td>
        <td class="num-cell came-cell"><strong>${tot.actuallyCame}</strong></td>
        <td class="num-cell notcame-cell"><strong>${tot.saidComingNotCame}</strong></td>
      </tr>`;
  } catch (e) {
    body.innerHTML = `<tr><td colspan="6" class="empty-cell">Error: ${e.message}</td></tr>`;
  }
}

// ── CALLING REPORT → Calling tab → Reports sub-tab ────
function openCallingReport() {
  switchTab('calling', document.querySelector('[data-tab="calling"]'));
  setTimeout(() => {
    const reportsBtn = document.querySelector('#tab-calling .att-sub-tab:nth-child(2)');
    if (reportsBtn && typeof switchCallingSubTab === 'function') switchCallingSubTab(reportsBtn, 'reports');
  }, 100);
}
