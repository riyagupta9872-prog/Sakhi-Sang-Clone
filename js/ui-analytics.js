/* ══ UI-ANALYTICS.JS – Reports, Care, Events tabs ══ */

// ── DASHBOARD TAB ─────────────────────────────────────
// Report-only dashboard: KPI tile strip + cross-team Coordinator grid.
// Pulls live data from attendance and calling collections for the selected
// Session in the filter ribbon. All KPIs and grid cells respect the master
// Team chip — locking to one team shows just that team's row + KPIs.

// ── DASHBOARD: fetch/render split with cache ──────────────────────────
//
// Cache key = (sessionId, callingDate). Team / Calling-By changes don't
// invalidate the cache — they only change what _dashRender displays.
//   • SESSION change → cache miss → fetch + render
//   • TEAM / CALLING-BY change → cache hit → instant re-render, no network
//   • Writes (markPresent, saveCallingStatus, etc.) call _bustDashboardCache()
//
// NOTE: No in-flight dedupe. Multiple simultaneous loadDashboard calls each
// run their own fetch — wastes at most one extra query, but eliminates the
// possibility of hanging on a stuck shared promise (which was the real
// source of the "stuck on Loading…" bug for super admin).
let _dashCache = null;  // { key, data: { allDevotees, csByDevotee, presentSet, targetCfg } }

function _bustDashboardCache() { _dashCache = null; }
window._bustDashboardCache = _bustDashboardCache;

const _DASH_TIMEOUT_MS = 8000;
function _dashSafe(p, fallback) {
  const timeout = new Promise(resolve => setTimeout(() => resolve(fallback), _DASH_TIMEOUT_MS));
  return Promise.race([Promise.resolve(p).catch(() => fallback), timeout]);
}

async function loadDashboard() {
  const el = document.getElementById('dashboard-content');
  if (!el) return;

  // Defensive render: any throw inside _dashRender (e.g. bad data shape) would
  // silently leave the spinner up. Catch it, log, and show an error state.
  const safeRender = (data, c) => {
    try {
      _dashRender(data, c);
    } catch (e) {
      console.error('dashboard render failed', e);
      el.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Render failed — <button onclick="loadDashboard()" style="text-decoration:underline;background:none;border:none;cursor:pointer;color:inherit">Retry</button></p></div>';
    }
  };

  let ctx;
  try {
    ctx = await _dashResolveContext();
  } catch (e) {
    console.error('loadDashboard resolve', e);
    el.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load — <button onclick="loadDashboard()" style="text-decoration:underline;background:none;border:none;cursor:pointer;color:inherit">Retry</button></p></div>';
    return;
  }

  const key = `${ctx.sessionId || ''}|${ctx.callingDate || ''}`;

  // CACHE HIT — pure re-render with current filter state. INSTANT.
  if (_dashCache && _dashCache.key === key) {
    safeRender(_dashCache.data, ctx);
    return;
  }

  // CACHE MISS — spinner, fetch, cache, render.
  el.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';

  try {
    const data = await _dashFetchData(ctx);
    _dashCache = { key, data };
    safeRender(data, ctx);
  } catch (e) {
    console.error('loadDashboard fetch', e);
    el.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load — <button onclick="loadDashboard()" style="text-decoration:underline;background:none;border:none;cursor:pointer;color:inherit">Retry</button></p></div>';
  }
}

// ── Resolve which session/calling week the dashboard should show. ──
// Small/fast Firestore lookups only when needed (find session by date, etc.).
// Returns ctx used as cache key + passed to render.
async function _dashResolveContext() {
  let sessionDate = (typeof getFilterSessionId === 'function') ? getFilterSessionId() : null;
  let sessionId   = AppState._currentSessionId || null;
  const today = getToday();

  if (sessionDate && sessionDate > today && !AppState._sessionExplicit) {
    // Future date defaulted by initSession — snap to latest past Sunday for dashboard.
    if (!AppState._autoSnap) {
      AppState._autoSnap = { from: sessionDate, fromDocId: sessionId, to: null };
    }
    const sn = await _dashSafe(
      fdb.collection('sessions').where('sessionDate', '<=', today).orderBy('sessionDate', 'desc').limit(1).get(),
      null
    );
    if (sn && !sn.empty) {
      sessionDate = sn.docs[0].data().sessionDate;
      sessionId   = sn.docs[0].id;
      AppState._autoSnap.to = sessionDate;
    } else {
      sessionDate = null; sessionId = null;
    }
  } else if (!sessionId && sessionDate) {
    const sn = await _dashSafe(
      fdb.collection('sessions').where('sessionDate', '==', sessionDate).limit(1).get(),
      null
    );
    if (sn && !sn.empty) sessionId = sn.docs[0].id;
  } else if (!sessionId && !sessionDate) {
    const sn = await _dashSafe(
      fdb.collection('sessions').where('sessionDate', '<=', today).orderBy('sessionDate', 'desc').limit(1).get(),
      null
    );
    if (sn && !sn.empty) {
      sessionDate = sn.docs[0].data().sessionDate;
      sessionId   = sn.docs[0].id;
    }
  }

  let callingDate = '';
  if (sessionDate) {
    callingDate = (typeof resolveCallingDate === 'function')
      ? await resolveCallingDate(sessionDate).catch(() => null)
      : null;
    if (!callingDate) {
      const d = new Date(sessionDate + 'T00:00:00');
      d.setDate(d.getDate() - 1);
      callingDate = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }
  }

  const activityStart = sessionDate || (() => {
    const d = new Date(today + 'T00:00:00'); d.setDate(d.getDate() - 6);
    return d.toISOString().slice(0, 10);
  })();
  const activityEnd = (() => {
    const d = new Date(activityStart + 'T00:00:00'); d.setDate(d.getDate() + 6);
    const sat = d.toISOString().slice(0, 10);
    return sat > today ? today : sat;
  })();

  return { sessionId, sessionDate, callingDate, activityStart, activityEnd };
}

// ── Heavy Firestore queries. Only called on cache miss. ──
async function _dashFetchData(ctx) {
  const { sessionId, callingDate } = ctx;
  const [allDevotees, csSnap, atSnap, targetCfg] = await Promise.all([
    _dashSafe(DevoteeCache.all(), []),
    callingDate
      ? _dashSafe(fdb.collection('callingStatus').where('weekDate', '==', callingDate).get(), { docs: [] })
      : Promise.resolve({ docs: [] }),
    sessionId
      ? _dashSafe(fdb.collection('attendanceRecords').where('sessionId', '==', sessionId).get(), { docs: [] })
      : Promise.resolve({ docs: [] }),
    _dashSafe(DB.getAttendanceTargets(), { type: 'class', teams: {} }),
  ]);
  // Normalize once so renders are pure data-in → DOM-out.
  const csByDevotee = {};
  csSnap.docs.forEach(d => { csByDevotee[d.data().devoteeId] = d.data(); });
  const presentSet = new Set(atSnap.docs.map(d => d.data().devoteeId));
  return { allDevotees, csByDevotee, presentSet, targetCfg };
}

// ── Pure render. Reads CURRENT filter team every call → table always matches chip. ──
function _dashRender(data, ctx) {
  const el = document.getElementById('dashboard-content');
  if (!el) return;
  const { allDevotees, csByDevotee, presentSet, targetCfg } = data;
  const { sessionId, sessionDate, callingDate, activityStart, activityEnd } = ctx;

  const filterTeam = (typeof getFilterTeam === 'function') ? getFilterTeam() : '';
  const teamsToShow = filterTeam ? [filterTeam] : TEAMS;

  const rows = teamsToShow.map(team => {
    const members = allDevotees.filter(d =>
      d.teamName === team
      && d.isActive !== false
      && !d.isNotInterested
      && d.callingMode !== 'not_interested'
      && d.callingMode !== 'online'
    );
    const callingListCount = allDevotees.filter(d =>
      d.teamName === team && d.isActive !== false && !d.isNotInterested && d.callingBy && d.callingBy.trim()
    ).length;
    const called   = members.filter(d => csByDevotee[d.id]);
    const coming   = members.filter(d => csByDevotee[d.id]?.comingStatus === 'Yes');
    const attended = members.filter(d => presentSet.has(d.id));
    // Calling accuracy numerator: said "Yes" AND actually came (matches the
    // Attendance → Accuracy report's yesAndCame/yes, not all attendees).
    const comingAndCame = members.filter(d => csByDevotee[d.id]?.comingStatus === 'Yes' && presentSet.has(d.id));
    const target   = (targetCfg.teams && targetCfg.teams[team] > 0)
      ? targetCfg.teams[team]
      : (targetCfg.global > 0 ? targetCfg.global : members.length);
    const pct      = target > 0 ? Math.round((attended.length / target) * 100) : 0;
    return {
      team,
      called:           called.length,
      coming:           coming.length,
      attended:         attended.length,
      comingAndCame:    comingAndCame.length,
      callingListCount,
      target,
      pct,
      comingIds:   coming.map(d => d.id),
      attendedIds: attended.map(d => d.id),
      calledIds:   called.map(d => d.id),
    };
  });

  const total = rows.reduce((acc, r) => ({
    called:           acc.called           + r.called,
    coming:           acc.coming           + r.coming,
    attended:         acc.attended         + r.attended,
    comingAndCame:    acc.comingAndCame    + r.comingAndCame,
    callingListCount: acc.callingListCount + r.callingListCount,
    target:           acc.target           + r.target,
  }), { called: 0, coming: 0, attended: 0, comingAndCame: 0, callingListCount: 0, target: 0 });
  const totalPct = total.target > 0 ? Math.round((total.attended / total.target) * 100) : 0;
  // Calling accuracy = of those who said "Yes", how many actually came.
  // Same definition as the Attendance → Accuracy report (yesAndCame / yes),
  // so the two screens always agree. Naturally bounded 0–100%.
  const callAccPct = total.coming > 0 ? Math.round((total.comingAndCame / total.coming) * 100) : 0;

  _setText('kpi-attended', total.callingListCount > 0 ? `${total.attended}/${total.callingListCount}` : total.attended);
  const accEl = document.getElementById('kpi-accuracy');
  if (accEl) {
    accEl.textContent = callAccPct + '%';
    accEl.setAttribute('title', total.coming > 0
      ? `${total.comingAndCame} of ${total.coming} who said "Yes" actually came — tap for the full Accuracy report`
      : 'No "Yes" confirmations yet for this session');
  }

  const sessLabel = sessionDate
    ? new Date(sessionDate + 'T00:00:00').toLocaleDateString('en-IN', { weekday:'short', day:'numeric', month:'short', year:'numeric' })
    : '— no session —';
  const liveSession = AppState._autoSnap?.from;
  const liveLabel = liveSession
    ? new Date(liveSession + 'T00:00:00').toLocaleDateString('en-IN', { weekday:'short', day:'numeric', month:'short' })
    : null;
  const actStartLabel = new Date(activityStart + 'T00:00:00').toLocaleDateString('en-IN', { day:'numeric', month:'short' });
  const actEndLabel   = new Date(activityEnd   + 'T00:00:00').toLocaleDateString('en-IN', { day:'numeric', month:'short' });
  const subParts = [`<i class="fas fa-clipboard-list" style="font-size:.7rem"></i> Reports for <strong>${sessLabel}</strong>`];
  if (liveLabel) subParts.push(`<i class="fas fa-circle" style="font-size:.45rem;color:#86efac;margin-right:.15rem"></i> Live cycle: <strong>${liveLabel}</strong>`);
  if (filterTeam) subParts.push(`<i class="fas fa-users" style="font-size:.7rem"></i> ${filterTeam}`);
  subParts.push(`<i class="fas fa-calendar-week" style="font-size:.7rem"></i> Activities: <strong>${actStartLabel} – ${actEndLabel}</strong>`);
  const greetSub = document.getElementById('dash-greet-sub');
  if (greetSub) greetSub.innerHTML = subParts.join(' &nbsp;·&nbsp; ');
  _setText('dash-grid-sub', '');

  const pctCls = p => p >= 80 ? 'dt-pct-good' : p >= 50 ? 'dt-pct-mid' : 'dt-pct-low';

  el.innerHTML = `
    <div class="dashboard-wrap">
      <table class="dashboard-table">
        <thead>
          <tr>
            <th rowspan="2">Team</th>
            <th colspan="5">Attendance</th>
          </tr>
          <tr class="dt-sub">
            <th>Called</th>
            <th>Yes</th>
            <th style="background:#1e3a6e !important;color:#fff !important">Target</th>
            <th>Present</th>
            <th>%</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `<tr>
            <td class="dt-team">${r.team}</td>
            <td class="dt-num"><button onclick="openDashboardList('called',   '${r.team.replace(/'/g,"\\'")}')">${r.called}</button></td>
            <td class="dt-num"><button onclick="openDashboardList('coming',   '${r.team.replace(/'/g,"\\'")}')">${r.coming}</button></td>
            <td class="dt-num" style="background:#e8edf5;font-weight:800;color:#0d2d5a">${r.target}</td>
            <td class="dt-num"><button onclick="openDashboardList('attended', '${r.team.replace(/'/g,"\\'")}')">${r.attended}</button></td>
            <td class="dt-pct ${pctCls(r.pct)}">${r.pct}%</td>
          </tr>`).join('')}
          <tr>
            <td class="dt-team">Grand Total</td>
            <td class="dt-num">${total.called}</td>
            <td class="dt-num">${total.coming}</td>
            <td class="dt-num" style="background:#e8edf5;font-weight:800;color:#0d2d5a">${total.target}</td>
            <td class="dt-num">${total.attended}</td>
            <td class="dt-pct ${pctCls(totalPct)}" style="color:${totalPct>=80?'#86efac':totalPct>=50?'#fde68a':'#fca5a5'}">${totalPct}%</td>
          </tr>
        </tbody>
      </table>
    </div>`;

  AppState._dashboard = { rows, sessionId, sessionDate, callingDate, csByDevotee, presentSet, allDevotees };
}

function _setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// Click handler for the dashboard's clickable numbers — opens the existing
// care-detail modal with the devotees behind that number.
function openDashboardList(kind, team) {
  const dash = AppState._dashboard;
  if (!dash) return;
  const all = dash.allDevotees;
  const row = dash.rows.find(r => r.team === team);
  if (!row) return;
  let ids = [], title = '';
  if      (kind === 'called')   { ids = row.calledIds;   title = `${team} — Devotees Called`; }
  else if (kind === 'coming')   { ids = row.comingIds;   title = `${team} — Confirmed Coming`; }
  else if (kind === 'attended') { ids = row.attendedIds; title = `${team} — Attended`; }
  const list = ids.map(id => {
    const d = all.find(x => x.id === id) || {};
    return {
      id, name: d.name || '—',
      mobile: d.mobile || '',
      team_name: d.teamName || '',
      calling_by: d.callingBy || '',
      reference_by: d.referenceBy || '',
      chanting_rounds: d.chantingRounds || 0,
    };
  });
  // Reuse the care-detail modal (already wired with table + export)
  if (typeof _careCache !== 'undefined') {
    _careCache._dashboard = { title, list };
    _careCurrentType = '_dashboard';
    if (typeof openCareDetail === 'function') openCareDetail('_dashboard');
  }
}
let _reportsCategory = 'attendance';

function switchReportsCategory(cat, btn) {
  _reportsCategory = cat;
  const tabsRow = btn?.parentElement || document.querySelector('#tab-reports .att-sub-tabs');
  if (tabsRow) tabsRow.querySelectorAll('.att-sub-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  else document.querySelector(`#tab-reports .att-sub-tab[onclick*="'${cat}'"]`)?.classList.add('active');
  document.getElementById('reports-cat-attendance')?.classList.toggle('active', cat === 'attendance');
  document.getElementById('reports-cat-calling')?.classList.toggle('active', cat === 'calling');
  if (cat === 'calling') {
    _populateReportWeeks?.().then(() => loadCallingReports?.());
  } else {
    loadReports();
  }
  renderBreadcrumb?.();
}

function switchCallingRptSub(btn, which) {
  const container = document.getElementById('reports-cat-calling');
  if (!container) return;
  container.querySelectorAll(':scope > .sub-tabs .sub-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  container.querySelectorAll(':scope > .sub-panel').forEach(p => p.classList.remove('active'));
  if (which === 'weekly') {
    document.getElementById('subtab-calling-weekly')?.classList.add('active');
    _populateReportWeeks?.().then(() => loadCallingReports?.());
  } else if (which === 'submission') {
    document.getElementById('subtab-calling-submission')?.classList.add('active');
    loadLateReports?.();
  }
}

function loadReports() {
  if (_reportsCategory === 'calling') return;
  const active = document.querySelector('#reports-cat-attendance .sub-panel.active');
  if (!active) return;
  const id = active.id.replace('subtab-', '');
  if (id === 'attendance-detail') loadYearlySheet();
  if (id === 'late-comers')       loadLateComersReport();
  if (id === 'serious-analysis')  loadSeriousAnalysis();
  if (id === 'team-leaderboard')  loadTeamLeaderboard();
  if (id === 'trends')            loadTrends();
  if (id === 'newcomers-report')  loadNewComersReport();
  if (id === 'att-accuracy')      loadAttAccuracyReport();
}

// Reports → Attendance Reports → New Comers
async function loadNewComersReport() {
  const el = document.getElementById('newcomers-report-content');
  if (!el) return;
  el.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';
  try {
    const sess = _reportActive;
    if (!sess) { el.innerHTML = '<div class="empty-state"><i class="fas fa-calendar-times"></i><p>Pick a session above</p></div>'; return; }

    const [attSnap, all] = await Promise.all([
      fdb.collection('attendanceRecords')
        .where('sessionId', '==', sess.id)
        .where('isNewDevotee', '==', true).get(),
      DevoteeCache.all(),
    ]);

    const byId = Object.fromEntries(all.map(d => [d.id, d]));
    const seen = new Set();
    const list = [];

    attSnap.docs.forEach(doc => {
      const a = doc.data();
      if (seen.has(a.devoteeId)) return;
      seen.add(a.devoteeId);
      const d = byId[a.devoteeId] || {};
      list.push({
        id: a.devoteeId,
        name: d.name || a.devoteeName || '—',
        mobile: d.mobile || a.mobile || '',
        teamName: d.teamName || a.teamName || '',
        callingBy: d.callingBy || a.callingBy || '',
        referenceBy: d.referenceBy || '',
        chantingRounds: d.chantingRounds || 0,
        source: 'attended',
      });
    });
    all.forEach(d => {
      if (seen.has(d.id))                        return;
      if (d.isActive === false)                  return;
      if (!d.dateOfJoining)                      return;
      if (d.dateOfJoining !== sess.session_date) return;
      seen.add(d.id);
      list.push({
        id: d.id,
        name: d.name || '—',
        mobile: d.mobile || '',
        teamName: d.teamName || '',
        callingBy: d.callingBy || '',
        referenceBy: d.referenceBy || '',
        chantingRounds: d.chantingRounds || 0,
        source: 'joined',
      });
    });

    if (!list.length) {
      el.innerHTML = `<div class="empty-state"><i class="fas fa-seedling"></i><p>No new devotees for ${formatDate(sess.session_date)}</p></div>`;
      return;
    }

    const TH_BASE = 'padding:.45rem .55rem;border:1.5px solid #000;font-weight:800;color:#000;background:#dbeafe;white-space:nowrap;';
    const th2 = (s='') => `<th style="${TH_BASE}text-align:center;${s}">`;
    const thL  = (s='') => `<th style="${TH_BASE}text-align:left;${s}">`;   // left-aligned (Name only)
    const td2  = (s='') => `style="padding:.4rem .55rem;border:1px solid #d1d5db;text-align:center;${s}"`;

    el.innerHTML = `
      <div style="font-size:.84rem;margin-bottom:.65rem;color:#374151;display:flex;align-items:center;gap:.4rem">
        <i class="fas fa-user-plus" style="color:#1e40af"></i>
        <strong style="color:#1e40af">${list.length}</strong> new devotees for
        <strong style="color:#1e40af">${formatDate(sess.session_date)}</strong>
      </div>
      <div class="table-scroll">
        <table style="width:100%;border-collapse:collapse;font-size:.82rem;border:2px solid #000">
          <thead style="position:sticky;top:0;z-index:2">
            <tr>
              ${th2('width:2rem')}#</th>
              ${thL('min-width:110px')}Name</th>
              ${th2()}Mobile</th>
              ${th2()}Reference</th>
              ${th2('min-width:120px')}Team</th>
              ${th2('min-width:110px')}Calling By</th>
            </tr>
          </thead>
          <tbody>
          ${list.map((d, i) => `<tr>
            <td ${td2('color:#9ca3af;font-size:.75rem')}>${i + 1}</td>
            <td style="padding:.4rem .55rem;border:1px solid #d1d5db;text-align:left;font-weight:700;cursor:pointer;color:#1e40af"
                onclick="openProfileModal('${d.id}')">${d.name}</td>
            <td ${td2('color:#374151;font-size:.8rem;white-space:nowrap')}>${d.mobile || '—'}</td>
            <td ${td2('color:#374151;font-size:.8rem;white-space:nowrap')}>${d.referenceBy || '—'}</td>
            <td ${td2('white-space:nowrap;font-size:.8rem')}>${d.teamName || '—'}</td>
            <td ${td2('font-size:.8rem;color:#374151')}>${d.callingBy || '—'}</td>
          </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  } catch (e) {
    console.error('loadNewComersReport', e);
    el.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load</p></div>';
  }
}

// ── REPORT SESSION + PERIOD FILTER ────────────────────
// Reports anchor on the master Session (AppState.filters.sessionId). The
// Period segment (Single Session / Month / Quarter / FY) widens the window
// for aggregation. _reportActive is now a thin live shim off the master state
// so existing references keep compiling without rewriting them.
let _reportSessions = [];        // populated once for export-FY helpers etc.

const _reportActive = new Proxy({}, {
  get(_t, prop) {
    const sid = AppState.filters?.sessionId;
    if (!sid) return undefined;
    if (prop === 'id' || prop === 'session_date') return sid;
    if (prop === 'topic') return AppState.sessionsCache?.[sid]?.topic || '';
    return undefined;
  },
});

function getWeekDate() {
  // Always read from master filter — single source of truth.
  return AppState.filters?.sessionId || getToday();
}

// Compute the date range covered by the current Period selection. Anchor is
// the master Session. Returns { start, end } as YYYY-MM-DD strings.
function _reportRange() {
  const f = AppState.filters || {};
  const anchor = f.sessionId || f.periodAnchor || getToday();
  const [y, m] = anchor.split('-').map(Number);
  const period = f.period || 'session';
  if (period === 'session') return { start: anchor, end: anchor, period };
  if (period === 'month') {
    const last = new Date(y, m, 0).getDate();
    return {
      start: `${y}-${String(m).padStart(2,'0')}-01`,
      end:   `${y}-${String(m).padStart(2,'0')}-${String(last).padStart(2,'0')}`,
      period,
    };
  }
  if (period === 'quarter') {
    const qStart = m <= 3 ? 1 : m <= 6 ? 4 : m <= 9 ? 7 : 10;
    const endM = qStart + 2;
    const last = new Date(y, endM, 0).getDate();
    return {
      start: `${y}-${String(qStart).padStart(2,'0')}-01`,
      end:   `${y}-${String(endM).padStart(2,'0')}-${String(last).padStart(2,'0')}`,
      period,
    };
  }
  // FY: April → March
  const fyStart = m >= 4 ? y : y - 1;
  return { start: `${fyStart}-04-01`, end: `${fyStart + 1}-03-31`, period };
}

function _reportPeriodLabel() {
  const r = _reportRange();
  if (r.period === 'session') return '';
  const fmt = ds => new Date(ds + 'T00:00:00').toLocaleDateString('en-IN', { day:'numeric', month:'short', year: r.period === 'fy' ? '2-digit' : undefined });
  if (r.period === 'month')   return `Month: ${fmt(r.start).split(' ').slice(1).join(' ')}`;
  if (r.period === 'quarter') return `Quarter: ${fmt(r.start)} – ${fmt(r.end)}`;
  if (r.period === 'fy')      return `FY: ${r.start.slice(0, 4)}–${r.end.slice(2, 4)}`;
  return '';
}

function _updateReportPeriodSummary() {
  const el = document.getElementById('rpt-period-summary');
  if (el) el.textContent = _reportPeriodLabel();
}

// Period segment click → mutate filter, refresh the active Reports view.
function setReportPeriod(period) {
  document.querySelectorAll('.rpt-period-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.period === period);
  });
  dispatchFilters({ period });
  _updateReportPeriodSummary();
  _refreshAfterFilter();
}

async function initReportsSessionFilter() {
  try {
    const today = getToday();
    _reportSessions = (await DB.getSessions()).filter(s => s.session_date <= today);
  } catch (e) { console.error('initReportsSessionFilter', e); }
  _updateReportPeriodSummary();
}

function _refreshAfterFilter() {
  if (_reportsCategory === 'calling') {
    const activeSub = document.querySelector('#reports-cat-calling .sub-panel.active');
    if (activeSub?.id === 'subtab-calling-submission') loadLateReports?.();
    else loadCallingReports?.();
  } else {
    loadReports();
  }
}

async function loadAttendanceDetail() {
  const c = document.getElementById('attendance-detail-table');
  c.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i></div>';
  if (!AppState.currentSessionId) { c.innerHTML = '<div class="empty-state"><i class="fas fa-list"></i><p>No session selected</p></div>'; return; }
  try {
    const records = await DB.getAttendanceReport(AppState.currentSessionId);
    if (!records.length) { c.innerHTML = '<div class="empty-state"><i class="fas fa-list"></i><p>No attendance data</p></div>'; return; }
    c.innerHTML = `
      <div style="margin-bottom:.75rem;color:var(--text-muted);font-size:.85rem">${records.length} devotees present</div>
      <div class="table-scroll">
        <table class="report-table">
          <thead><tr><th>#</th><th>Name</th><th>Mobile</th><th>Rounds</th><th>Team</th><th>Calling By</th><th>Type</th></tr></thead>
          <tbody>${records.map((r, i) => `
            <tr><td style="color:var(--text-muted)">${i+1}</td>
                <td style="font-weight:600">${r.name}</td>
                <td>${r.mobile ? contactIcons(r.mobile) : '—'}</td>
                <td style="text-align:center">${r.chanting_rounds || 0}</td>
                <td>${teamBadge(r.team_name)}</td>
                <td>${r.calling_by || '—'}</td>
                <td>${r.is_new_devotee ? '<span class="badge badge-most-serious">New</span>' : '<span class="badge badge-expected">Regular</span>'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  } catch (_) { c.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load</p></div>'; }
}

async function loadSeriousAnalysis() {
  const c = document.getElementById('serious-analysis-content');
  c.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i></div>';
  try {
    const callingDate = await resolveCallingDate(getWeekDate());
    const data = await DB.getSeriousReport(callingDate, AppState.currentReportSessionId || AppState.currentSessionId);
    const teams    = TEAMS;
    const statuses = ['Most Serious','Serious','Expected to be Serious','New Devotee','Inactive'];
    c.innerHTML = `<div class="table-scroll"><table class="report-table">
      <thead>
        <tr><th>Team</th>${statuses.map(s => `<th colspan="2" style="text-align:center">${shortStatus(s)}</th>`).join('')}</tr>
        <tr><th></th>${statuses.map(() => '<th>Promised</th><th>Arrived</th>').join('')}</tr>
      </thead>
      <tbody>${teams.map(team => {
        const cells = statuses.map(status => {
          const row = data.find(d => d.team === team && d.status === status);
          const p = row?.promised || 0, a = row?.arrived || 0, pct = p > 0 ? Math.round(a/p*100) : 0;
          return `<td style="text-align:center;font-weight:600">${p}</td>
                  <td style="text-align:center"><span style="font-weight:700;color:${a>=p?'var(--success)':'var(--warning)'}">${a}</span>${p>0?`<span style="font-size:.72rem;color:var(--text-muted)"> (${pct}%)</span>`:''}`;
        }).join('');
        return `<tr><td style="font-weight:700">${team}</td>${cells}</tr>`;
      }).join('')}
      </tbody></table></div>`;
  } catch (_) { c.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load</p></div>'; }
}

async function loadTeamLeaderboard() {
  const c = document.getElementById('team-leaderboard-content');
  c.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i></div>';
  try {
    const callingDate = await resolveCallingDate(getWeekDate());
    const [data, targetCfg] = await Promise.all([
      DB.getTeamsReport(callingDate, AppState.currentReportSessionId || AppState.currentSessionId),
      DB.getAttendanceTargets().catch(() => ({ type: 'class', teams: {} })),
    ]);
    // Compute configTarget and pct for every row first, then sort by pct
    const ranked = data.map(row => {
      const configTarget = (targetCfg.teams && targetCfg.teams[row.team] > 0)
        ? targetCfg.teams[row.team]
        : (targetCfg.global > 0 ? targetCfg.global : row.total);
      const pct = configTarget > 0 ? Math.round(row.actualPresent / configTarget * 100) : 0;
      return { ...row, configTarget, pct };
    });
    ranked.sort((a, b) => b.pct - a.pct || b.actualPresent - a.actualPresent);

    c.innerHTML = `<div class="table-scroll"><table class="report-table leaderboard-table">
      <thead><tr><th>Rank</th><th>Team</th><th>Total</th><th>Calling List</th><th>Target</th><th>Present</th><th>Achievement</th></tr></thead>
      <tbody>${ranked.map((row, i) => {
        const medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':`#${i+1}`;
        const cls   = i===0?'rank-1':i===1?'rank-2':i===2?'rank-3':'';
        const col   = row.pct>=100?'var(--success)':row.pct>=70?'var(--warning)':'var(--danger)';
        return `<tr>
          <td class="leaderboard-rank ${cls}">${medal}</td>
          <td style="font-weight:700">${row.team}</td>
          <td style="text-align:center">${row.total}</td>
          <td style="text-align:center">${row.callingList}</td>
          <td style="text-align:center">${row.configTarget}</td>
          <td style="text-align:center;font-weight:700;color:var(--success)">${row.actualPresent}</td>
          <td><div style="display:flex;align-items:center;gap:.5rem">
            <div class="pct-bar-wrap"><div class="pct-bar" style="width:${Math.min(row.pct,100)}%"></div></div>
            <span style="font-size:.82rem;font-weight:700;color:${col}">${row.pct}%</span>
          </div></td>
        </tr>`;
      }).join('')}
      </tbody></table></div>`;
  } catch (_) { c.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load</p></div>'; }
}

async function loadTrends() {
  try {
    // Trend granularity: weekly always; range is implicit from data window.
    // Team comes from master filter.
    const period = 'weekly';
    const team = getFilterTeam();
    const data = await DB.getTrends(period, team);
    const canvas = document.getElementById('trends-chart');
    if (!canvas) return;
    if (AppState.trendsChart) { AppState.trendsChart.destroy(); AppState.trendsChart = null; }
    const months = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
    const labels = data.map(d => {
      if (period === 'monthly') { const [y, m] = d.period.split('-'); return months[parseInt(m)-1] + ' ' + y; }
      return formatDate(d.period);
    });
    AppState.trendsChart = new Chart(canvas, {
      type: 'line',
      data: { labels, datasets: [{ label: 'Devotees Present', data: data.map(d => d.count), borderColor: '#2d7a52', backgroundColor: 'rgba(82,183,136,0.15)', borderWidth: 2.5, pointBackgroundColor: '#2d7a52', pointRadius: 5, fill: true, tension: 0.4 }] },
      options: {
        responsive: true,
        plugins: {
          legend: { labels: { color: '#1b4332', font: { family: 'Nunito', size: 13 } } },
          tooltip: { backgroundColor: '#1e40af', titleFont: { family: 'Cinzel' }, bodyFont: { family: 'Nunito' } }
        },
        scales: {
          y: { beginAtZero: true, grid: { color: '#d8f3dc' }, ticks: { color: '#6b9080', font: { family: 'Nunito' } } },
          x: { grid: { color: '#d8f3dc' }, ticks: { color: '#6b9080', font: { family: 'Nunito' }, maxRotation: 45 } }
        }
      }
    });
  } catch (e) { console.error('Trends', e); }
}

// ── DEVOTEE CARE TAB ──────────────────────────────────
// Cache the loaded lists so clicking a card can open a detail modal.
const _careCache = {
  absentWeek:   { title: 'Absent This Week',           list: [] },
  absent2Weeks: { title: 'Absent 2+ Weeks',            list: [] },
  newComers:    { title: 'New Comers This Session',    list: [] },
  inactive:     { title: 'Inactivity Alerts (3+ wk)',  list: [] },
  saidComing:   { title: 'Said Coming — Didn\'t Come', list: [] },
};
let _careCurrentType = null;

// Raw cache (pre-team-filter) keyed by sessionDate. Lets team filter changes
// re-render INSTANTLY without re-querying Firestore. Session change → cache
// miss → fetch all 4 in parallel. Writes call _bustCareCache().
let _careRawCache = null;  // { key, absentWeek, absent2Weeks, newcomers, inactive, saidComing: {list, weekDate} }

function _bustCareCache() { _careRawCache = null; }
window._bustCareCache = _bustCareCache;

async function loadCareData() {
  const sessionDate = getFilterSessionId() || '';
  const key = sessionDate;

  if (!_careRawCache || _careRawCache.key !== key) {
    try {
      const [absentResult, newComers, inactive, saidComingResult] = await Promise.all([
        DB.getCareAbsent(sessionDate || undefined).catch(() => ({ absentThisWeek: [], absentPast2Weeks: [] })),
        DB.getNewComersForSession(sessionDate).catch(() => []),
        DB.getCareInactive().catch(() => []),
        _careFetchSaidComing(sessionDate).catch(() => ({ list: [], weekDate: '' })),
      ]);
      _careRawCache = {
        key,
        absentWeek:   absentResult.absentThisWeek || [],
        absent2Weeks: absentResult.absentPast2Weeks || [],
        newComers:    newComers || [],
        inactive:     inactive || [],
        saidComing:   saidComingResult,
      };
    } catch (e) {
      console.error('loadCareData fetch', e);
      return;
    }
  }

  _careRender();
}

// Apply current team filter + update visible lists + counts.
// Pure data → DOM, no network. Called on every loadCareData (cache hit or miss)
// so team filter changes are INSTANT.
function _careRender() {
  if (!_careRawCache) return;
  const team = getFilterTeam();
  const tf = list => team ? list.filter(d => (d.team_name || d.teamName) === team) : list;

  const w1 = tf(_careRawCache.absentWeek);
  const w2 = tf(_careRawCache.absent2Weeks);
  const ncs = tf(_careRawCache.newComers);
  const ia = tf(_careRawCache.inactive);
  const sc = tf(_careRawCache.saidComing.list || []);

  _careCache.absentWeek.list   = w1;
  _careCache.absent2Weeks.list = w2;
  _careCache.newComers.list    = ncs;
  _careCache.inactive.list     = ia;
  _careCache.saidComing.list   = sc;
  _careCache.saidComing.weekDate = _careRawCache.saidComing.weekDate;

  const set = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n; };
  set('absent-week-count',   w1.length);
  set('absent-2weeks-count', w2.length);
  set('inactive-count',      ia.length);
  set('said-coming-count',   sc.length);
}

// Said-coming-but-didn't-come — fetch helper used by loadCareData.
// Anchored on the master Session (or latest past session if Session is in the future).
async function _careFetchSaidComing(masterSessionDate) {
  const today = getToday();
  let sessionDate = masterSessionDate;
  if (!sessionDate || sessionDate > today) {
    const sessSnap = await fdb.collection('sessions')
      .where('sessionDate', '<=', today)
      .orderBy('sessionDate', 'desc').limit(1).get();
    if (sessSnap.empty) return { list: [], weekDate: '' };
    sessionDate = sessSnap.docs[0].data().sessionDate;
  }
  const callingDate = await resolveCallingDate(sessionDate);
  const { list } = await DB.getYesAbsentList(callingDate, sessionDate);
  const all = await DevoteeCache.all();
  const byId = Object.fromEntries(all.map(d => [d.id, d]));
  const enriched = (list || []).map(item => {
    const d = byId[item.id] || {};
    return {
      id: item.id,
      name: item.name || d.name,
      mobile: item.mobile || d.mobile || '',
      team_name: item.teamName || d.teamName || '',
      calling_by: item.callingBy || d.callingBy || '',
      reference_by: d.referenceBy || '',
      chanting_rounds: d.chantingRounds || 0,
      coming_status: 'Yes',        // confirmed in previous calling week
      calling_notes: item.callingNotes || '',
    };
  });
  return { list: enriched, weekDate: sessionDate };
}

function openCareDetail(type) {
  const bucket = _careCache[type];
  if (!bucket) return;
  _careCurrentType = type;
  const titleEl  = document.getElementById('care-detail-title');
  const content  = document.getElementById('care-detail-content');
  titleEl.innerHTML = `<i class="fas fa-heart"></i> ${bucket.title}`;
  const list = bucket.list || [];
  if (!list.length) {
    content.innerHTML = `<div class="empty-state"><i class="fas fa-check-circle" style="color:var(--success)"></i><p>All clear!</p></div>`;
    openModal('care-detail-modal');
    return;
  }
  content.innerHTML = `
    <div style="margin-bottom:.5rem;color:var(--text-muted);font-size:.82rem">${list.length} devotee${list.length === 1 ? '' : 's'}</div>
    <div class="table-scroll">
      <table class="report-table">
        <thead><tr>
          <th>#</th><th>Name</th><th>Mobile</th><th>Reference</th><th>Team</th><th>Calling By</th><th style="text-align:center">C.R.</th>
        </tr></thead>
        <tbody>${list.map((d, i) => `<tr>
          <td style="color:var(--text-muted)">${i + 1}</td>
          <td><button class="cm-link" onclick="closeModal('care-detail-modal'); openProfileModal('${d.id}')">${d.name || '—'}</button></td>
          <td>${d.mobile ? contactIcons(d.mobile) + ' <span style="font-size:.78rem">' + d.mobile + '</span>' : '—'}</td>
          <td style="font-size:.82rem">${d.reference_by || '—'}</td>
          <td>${teamBadge(d.team_name)}</td>
          <td style="font-size:.82rem">${d.calling_by || '—'}</td>
          <td style="text-align:center">${d.chanting_rounds || 0}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>`;
  openModal('care-detail-modal');
}

// Renders care list directly into an inline panel (no modal) — used by Attendance tab care sub-tabs
function _renderCareSection(careKey, targetEl) {
  if (!targetEl) return;
  if (careKey === 'newComers') { _renderNewComersTable((_careCache.newComers || {}).list || [], targetEl); return; }
  const bucket = _careCache[careKey];
  if (!bucket) { targetEl.innerHTML = '<div class="empty-state"><p>No data</p></div>'; return; }
  const list = bucket.list || [];
  const TH = `style="padding:.4rem .5rem;background:#0d2d5a;color:#fff;font-weight:700;font-size:.78rem"`;
  if (!list.length) {
    targetEl.innerHTML = `<div class="empty-state"><i class="fas fa-check-circle" style="color:#16a34a"></i><p>All clear — no devotees in this category</p></div>`;
    return;
  }
  targetEl.innerHTML = `
    <div style="font-size:.82rem;color:#64748b;margin-bottom:.6rem"><strong>${list.length}</strong> devotee${list.length===1?'':'s'}</div>
    <div class="table-scroll">
      <table style="width:100%;border-collapse:collapse;border:2px solid #000;font-size:.82rem">
        <thead><tr>
          <th ${TH} style="text-align:center;width:2rem">#</th>
          <th ${TH}>Name</th>
          <th ${TH}>Mobile</th>
          <th ${TH}>Team</th>
          <th ${TH}>Calling By</th>
        </tr></thead>
        <tbody>
          ${list.map((d, i) => `<tr style="${i%2===0?'background:#fff':'background:#f5f7fa'}">
            <td style="padding:.38rem .5rem;border:1px solid #d1d5db;text-align:center;color:#94a3b8;font-size:.75rem">${i+1}</td>
            <td style="padding:.38rem .55rem;border:1px solid #d1d5db;font-weight:700;cursor:pointer;color:#0d2d5a"
                onclick="openProfileModal('${d.id}')">${d.name||'—'}</td>
            <td style="padding:.38rem .55rem;border:1px solid #d1d5db;font-size:.8rem;color:#374151">${d.mobile||'—'}</td>
            <td style="padding:.38rem .55rem;border:1px solid #d1d5db;font-size:.78rem;white-space:nowrap">${d.team_name||'—'}</td>
            <td style="padding:.38rem .55rem;border:1px solid #d1d5db;font-size:.78rem;color:#64748b">${d.calling_by||'—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}
window._renderCareSection = _renderCareSection;

// New Comers this session — table with arrival time
function _renderNewComersTable(list, targetEl) {
  const TH = `style="padding:.4rem .5rem;background:#0d2d5a;color:#fff;font-weight:700;font-size:.78rem"`;
  if (!list.length) {
    targetEl.innerHTML = `<div class="empty-state"><i class="fas fa-seedling" style="color:#16a34a"></i><p>No new devotees in this session</p></div>`;
    return;
  }
  const fmtTime = ts => {
    if (!ts) return '—';
    try { const d = ts.toDate ? ts.toDate() : new Date(ts); return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }); }
    catch { return '—'; }
  };
  targetEl.innerHTML = `
    <div style="font-size:.82rem;color:#64748b;margin-bottom:.6rem"><strong>${list.length}</strong> new devotee${list.length===1?'':'s'} this session</div>
    <div class="table-scroll">
      <table style="width:100%;border-collapse:collapse;border:2px solid #000;font-size:.82rem">
        <thead><tr>
          <th ${TH} style="text-align:center;width:2rem">#</th>
          <th ${TH}>Name</th>
          <th ${TH}>Mobile</th>
          <th ${TH}>Team</th>
          <th ${TH}>Ref By</th>
          <th ${TH}>Arrived</th>
        </tr></thead>
        <tbody>
          ${list.map((d, i) => `<tr style="${i%2===0?'background:#fff':'background:#f5f7fa'}">
            <td style="padding:.38rem .5rem;border:1px solid #d1d5db;text-align:center;color:#94a3b8;font-size:.75rem">${i+1}</td>
            <td style="padding:.38rem .55rem;border:1px solid #d1d5db;font-weight:700;cursor:pointer;color:#0d2d5a"
                onclick="openProfileModal('${d.id}')">${d.name||'—'}</td>
            <td style="padding:.38rem .55rem;border:1px solid #d1d5db;font-size:.8rem;color:#374151">${d.mobile||'—'}</td>
            <td style="padding:.38rem .55rem;border:1px solid #d1d5db;font-size:.78rem;white-space:nowrap">${d.team_name||'—'}</td>
            <td style="padding:.38rem .55rem;border:1px solid #d1d5db;font-size:.78rem;color:#64748b">${d.reference_by||'—'}</td>
            <td style="padding:.38rem .55rem;border:1px solid #d1d5db;font-size:.78rem;color:#374151">${fmtTime(d.marked_at)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// Returning New Comers — all "New Devotee" status with 8-session attendance grid + joining date
async function loadReturningNewComers(targetEl) {
  if (!targetEl) return;
  targetEl.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';
  try {
    const { sessions, devotees } = await DB.getReturningNewComers();
    _renderReturningNewComers(targetEl, sessions, devotees);
  } catch (e) {
    console.error('loadReturningNewComers', e);
    targetEl.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load</p></div>';
  }
}
window.loadReturningNewComers = loadReturningNewComers;

function _renderReturningNewComers(targetEl, sessions, devotees) {
  if (!devotees.length) {
    targetEl.innerHTML = `<div class="empty-state"><i class="fas fa-seedling" style="color:#16a34a"></i><p>No devotees with "New Devotee" status remaining</p></div>`;
    return;
  }
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const fmtCol = dateStr => {
    if (!dateStr) return '?';
    try { const [, m, d] = dateStr.split('-'); return `${parseInt(d)} ${MONTHS[parseInt(m)-1]}`; }
    catch { return dateStr; }
  };
  const fmtJoined = str => {
    if (!str) return '—';
    try { const [y, m, d] = str.split('-'); return `${parseInt(d)} ${MONTHS[parseInt(m)-1]} ${y.slice(2)}`; }
    catch { return str; }
  };

  // ── sticky column widths ──
  const SNO_W  = 34;   // px — serial number column
  const NAME_W = 110;  // px — name column

  // Header cells
  const TH_BASE = `position:sticky;top:0;z-index:3;background:#0d2d5a;color:#fff;font-weight:700;font-size:.75rem;white-space:nowrap;border:1px solid #1e3a5f;padding:.42rem .45rem`;
  const TH_CTR  = `${TH_BASE};text-align:center`;
  // Corner sticky cells (# and Name in header — sticky both top AND left)
  const TH_SNO  = `${TH_CTR};position:sticky;top:0;left:0;z-index:5;width:${SNO_W}px;min-width:${SNO_W}px`;
  const TH_NAME = `${TH_BASE};position:sticky;top:0;left:${SNO_W}px;z-index:5;min-width:${NAME_W}px`;
  const sessCols = sessions.map(s => `<th style="${TH_CTR}">${fmtCol(s.date)}</th>`).join('');

  // Body rows
  const rows = devotees.map((d, i) => {
    const rowBg = i % 2 === 0 ? '#fff' : '#f5f7fa';
    const attCells = d.attendance.map(came =>
      came
        ? `<td style="padding:.35rem .4rem;border:1px solid #d1d5db;text-align:center;background:#dcfce7;color:#16a34a;font-weight:800;font-size:.9rem">✓</td>`
        : `<td style="padding:.35rem .4rem;border:1px solid #d1d5db;text-align:center;color:#d1d5db;font-size:.85rem">—</td>`
    ).join('');
    return `<tr>
      <td style="position:sticky;left:0;z-index:2;background:${rowBg};width:${SNO_W}px;min-width:${SNO_W}px;padding:.38rem .35rem;border:1px solid #d1d5db;text-align:center;color:#94a3b8;font-size:.75rem">${i+1}</td>
      <td style="position:sticky;left:${SNO_W}px;z-index:2;background:${rowBg};min-width:${NAME_W}px;padding:.38rem .55rem;border:1px solid #d1d5db;font-weight:700;cursor:pointer;color:#0d2d5a"
          onclick="openProfileModal('${d.id}')">${d.name||'—'}</td>
      <td style="padding:.38rem .45rem;border:1px solid #d1d5db;font-size:.75rem;white-space:nowrap;background:${rowBg}">${d.team_name||'—'}</td>
      <td style="padding:.38rem .45rem;border:1px solid #d1d5db;font-size:.75rem;color:#64748b;white-space:nowrap;background:${rowBg}">${fmtJoined(d.date_of_joining)}</td>
      ${attCells}
    </tr>`;
  }).join('');

  targetEl.innerHTML = `
    <div style="font-size:.82rem;color:#64748b;margin-bottom:.6rem"><strong>${devotees.length}</strong> devotee${devotees.length===1?'':'s'} still in "New Devotee" status</div>
    <div style="overflow:auto;max-height:65vh;border:2px solid #000;border-radius:4px">
      <table style="width:100%;border-collapse:separate;border-spacing:0;font-size:.82rem">
        <thead><tr>
          <th style="${TH_SNO}">#</th>
          <th style="${TH_NAME}">Name</th>
          <th style="${TH_BASE}">Team</th>
          <th style="${TH_BASE}">Joined</th>
          ${sessCols}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ── MERGED ABSENT TAB ─────────────────────────────────────────────────────────
// Combines "Absent This Week", "Absent 2+ Weeks", "Inactivity Alerts" into one
// panel with a 3-chip filter row.

let _careAbsentFilter = 'week'; // 'week' | '2weeks' | 'inactive'

async function loadCareAbsentTab(targetEl) {
  if (!targetEl) return;
  targetEl.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';
  _careAbsentFilter = 'week';
  try {
    await loadCareData();
    _renderCareAbsentMergedFull(targetEl);
  } catch (e) {
    console.error('loadCareAbsentTab', e);
    targetEl.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load</p></div>';
  }
}
window.loadCareAbsentTab = loadCareAbsentTab;

function _renderCareAbsentMergedFull(targetEl) {
  const chipStyle = key => _careAbsentFilter === key
    ? 'background:#0d2d5a;color:#fff;border:1.5px solid #0d2d5a;font-weight:700'
    : 'background:#fff;color:#374151;border:1.5px solid #d1d5db';
  targetEl.innerHTML = `
    <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.85rem">
      <button style="padding:.38rem .9rem;border-radius:20px;font-size:.82rem;cursor:pointer;${chipStyle('week')}"
              onclick="setCareAbsentFilter('week',this)">This Week</button>
      <button style="padding:.38rem .9rem;border-radius:20px;font-size:.82rem;cursor:pointer;${chipStyle('2weeks')}"
              onclick="setCareAbsentFilter('2weeks',this)">2+ Weeks</button>
      <button style="padding:.38rem .9rem;border-radius:20px;font-size:.82rem;cursor:pointer;${chipStyle('inactive')}"
              onclick="setCareAbsentFilter('inactive',this)">Inactivity (3+ wk)</button>
    </div>
    <div id="att-care-absent-list"></div>`;
  const listEl = document.getElementById('att-care-absent-list');
  _renderCareAbsentList(listEl);
}

function _renderCareAbsentList(listEl) {
  if (!listEl) return;
  const careKey = { week: 'absentWeek', '2weeks': 'absent2Weeks', inactive: 'inactive' }[_careAbsentFilter];
  _renderCareSection(careKey, listEl);
}

window.setCareAbsentFilter = function(key, btn) {
  _careAbsentFilter = key;
  // Re-render the full merged panel (easiest way to update chip styles too)
  const targetEl = document.getElementById('att-care-absent-merged-content');
  if (targetEl) _renderCareAbsentMergedFull(targetEl);
};

// ── END MERGED ABSENT TAB ─────────────────────────────────────────────────────

async function exportCareDetail() {
  if (!_careCurrentType) return;
  const bucket = _careCache[_careCurrentType];
  const list   = bucket?.list || [];
  if (!list.length) { showToast('Nothing to export', 'error'); return; }
  const rows = list.map((d, i) => ({
    '#':            i + 1,
    Name:           d.name || '',
    Mobile:         d.mobile || '',
    Reference:      d.reference_by || '',
    Team:           d.team_name || '',
    'Calling By':   d.calling_by || '',
    'Chanting Rounds': d.chanting_rounds || 0,
  }));
  downloadExcel(rows, `care_${_careCurrentType}_${getToday()}.xlsx`);
}

// ── REPEAT ABSENTEES TAB ─────────────────────────────────────────────────────
// Shows devotees who said "Coming" but didn't show across multiple past weeks.
let _repeatAbsentWeekFilter = 3; // default: last 3 weeks

async function loadRepeatAbsenteesTab() {
  const el = document.getElementById('att-repeat-absent-content');
  if (!el) return;
  el.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';
  try {
    await _renderRepeatAbsentees(el, _repeatAbsentWeekFilter);
  } catch (e) {
    el.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load</p></div>';
    console.error('loadRepeatAbsenteesTab', e);
  }
}
window.loadRepeatAbsenteesTab = loadRepeatAbsenteesTab;

async function _renderRepeatAbsentees(el, numWeeks) {
  const anchorSession = (typeof getFilterSessionId === 'function') ? getFilterSessionId() : null;
  const today = getToday();

  // Fetch last N sessions up to the anchor (or today)
  const anchor = (anchorSession && anchorSession <= today) ? anchorSession : today;
  const sessSnap = await fdb.collection('sessions')
    .where('sessionDate', '<=', anchor)
    .orderBy('sessionDate', 'desc').limit(numWeeks).get();

  const sessions = sessSnap.docs
    .map(d => ({ id: d.id, date: d.data().sessionDate, cancelled: d.data().isCancelled }))
    .filter(s => !s.cancelled);

  if (!sessions.length) {
    el.innerHTML = '<div class="empty-state"><p>No sessions found</p></div>';
    return;
  }

  // For each session, get the calling Saturday and fetch Said-Coming-But-Not-Come
  const results = await Promise.all(sessions.map(async sess => {
    const sun = sess.date;
    const sat = new Date(sun + 'T00:00:00');
    sat.setDate(sat.getDate() - 1);
    const satStr = `${sat.getFullYear()}-${String(sat.getMonth()+1).padStart(2,'0')}-${String(sat.getDate()).padStart(2,'0')}`;
    const { list } = await DB.getYesAbsentList(satStr, sun).catch(() => ({ list: [] }));
    return { date: sun, list };
  }));

  // Count how many weeks each devotee appears in
  const countMap = {};  // id → { name, team, mobile, count, weeks }
  results.forEach(({ date, list }) => {
    list.forEach(d => {
      if (!countMap[d.id]) countMap[d.id] = { ...d, count: 0, weeks: [] };
      countMap[d.id].count++;
      countMap[d.id].weeks.push(new Date(date + 'T00:00:00').toLocaleDateString('en-IN', { day:'numeric', month:'short' }));
    });
  });

  // Only show devotees who missed 2+ weeks
  const repeaters = Object.values(countMap)
    .filter(d => d.count >= 2)
    .sort((a, b) => b.count - a.count || (a.name||'').localeCompare(b.name||''));

  // Build the header with week filter buttons
  const weekBtns = [2,3,4].map(n => `
    <button onclick="setRepeatAbsentFilter(${n})"
      style="padding:.35rem .8rem;border-radius:99px;border:1.5px solid ${n===numWeeks?'#0d2d5a':'#e2e8f0'};
             background:${n===numWeeks?'#0d2d5a':'#fff'};color:${n===numWeeks?'#fff':'#374151'};
             font-weight:700;font-size:.8rem;cursor:pointer;transition:.15s">
      Last ${n} weeks
    </button>`).join('');

  const TH = `style="padding:.4rem .55rem;background:#0d2d5a;color:#fff;font-weight:700;font-size:.78rem"`;
  const countColor = c => c >= numWeeks ? '#b91c1c' : c >= numWeeks - 1 ? '#d97706' : '#64748b';

  const tableHtml = repeaters.length ? `
    <div class="table-scroll">
      <table style="width:100%;border-collapse:collapse;border:2px solid #000;font-size:.82rem">
        <thead><tr>
          <th ${TH} style="text-align:center;width:2rem">#</th>
          <th ${TH}>Name</th>
          <th ${TH}>Mobile</th>
          <th ${TH};white-space:nowrap">Team</th>
          <th ${TH} style="text-align:center">Times</th>
          <th ${TH}>Sessions Missed</th>
        </tr></thead>
        <tbody>
          ${repeaters.map((d, i) => `
            <tr style="${i%2===0?'background:#fff':'background:#fef2f2'}">
              <td style="padding:.38rem .5rem;border:1px solid #d1d5db;text-align:center;color:#94a3b8;font-size:.75rem">${i+1}</td>
              <td style="padding:.38rem .55rem;border:1px solid #d1d5db;font-weight:700;cursor:pointer;color:#0d2d5a"
                  onclick="openProfileModal('${d.id}')">${d.name||'—'}</td>
              <td style="padding:.38rem .55rem;border:1px solid #d1d5db;font-size:.8rem;color:#374151">${d.mobile||'—'}</td>
              <td style="padding:.38rem .55rem;border:1px solid #d1d5db;font-size:.78rem;white-space:nowrap">${d.teamName||d.team_name||'—'}</td>
              <td style="padding:.38rem .55rem;border:1px solid #d1d5db;text-align:center;font-weight:900;font-size:1rem;color:${countColor(d.count)}">${d.count}/${sessions.length}</td>
              <td style="padding:.38rem .55rem;border:1px solid #d1d5db;font-size:.72rem;color:#64748b">${d.weeks.join(', ')}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>` : `<div class="empty-state"><i class="fas fa-check-circle" style="color:#16a34a"></i><p>No repeat absentees in the last ${numWeeks} weeks 🙏</p></div>`;

  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.5rem;margin-bottom:.75rem">
      <div>
        <span style="font-size:.82rem;color:#64748b">Devotees who said "Coming" but missed</span>
        ${repeaters.length ? `<strong style="color:#b91c1c;margin-left:.4rem">${repeaters.length} found</strong>` : ''}
      </div>
      <div style="display:flex;gap:.4rem">${weekBtns}</div>
    </div>
    ${tableHtml}`;
}
window._renderRepeatAbsentees = _renderRepeatAbsentees;

function setRepeatAbsentFilter(n) {
  _repeatAbsentWeekFilter = n;
  const el = document.getElementById('att-repeat-absent-content');
  if (el) {
    el.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';
    _renderRepeatAbsentees(el, n).catch(() => {});
  }
}
window.setRepeatAbsentFilter = setRepeatAbsentFilter;

// ── EVENTS TAB ────────────────────────────────────────
async function loadEvents() {
  const grid = document.getElementById('events-list');
  grid.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';
  try {
    const events = await DB.getEvents();
    if (!events.length) { grid.innerHTML = '<div class="empty-state"><i class="fas fa-calendar-times"></i><p>No events yet. Create one!</p></div>'; return; }
    grid.innerHTML = events.map(ev => `
      <div class="event-card" onclick="openEventDetail('${ev.id}')">
        <div class="event-card-header">
          <div><div class="event-name">${ev.event_name}</div><div class="event-date"><i class="fas fa-calendar"></i> ${formatDate(ev.event_date) || 'Date TBD'}</div></div>
          <div class="event-actions" onclick="event.stopPropagation()">
            <button class="btn-icon" onclick="openEditEventModal('${ev.id}')" title="Edit"><i class="fas fa-pencil-alt"></i></button>
            <button class="btn-icon close" onclick="deleteEvent('${ev.id}')" title="Delete"><i class="fas fa-trash"></i></button>
          </div>
        </div>
        ${ev.description ? `<div class="event-desc">${ev.description}</div>` : ''}
        <div class="event-count"><i class="fas fa-users"></i> Click to manage devotees</div>
      </div>`).join('');
  } catch (_) { grid.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load</p></div>'; }
}

function openNewEventModal() {
  document.getElementById('e-id').value = '';
  ['e-name','e-description'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('e-date').value = '';
  document.getElementById('event-form-title').textContent = 'New Event';
  openModal('event-form-modal');
}

async function openEditEventModal(id) {
  try {
    const events = await DB.getEvents();
    const ev = events.find(e => e.id === id);
    if (!ev) return;
    document.getElementById('e-id').value          = ev.id;
    document.getElementById('e-name').value        = ev.event_name;
    document.getElementById('e-date').value        = ev.event_date || '';
    document.getElementById('e-description').value = ev.description || '';
    document.getElementById('event-form-title').textContent = 'Edit Event';
    openModal('event-form-modal');
  } catch (_) {}
}

async function saveEvent(e) {
  e.preventDefault();
  const id = document.getElementById('e-id').value;
  const payload = { event_name: document.getElementById('e-name').value.trim(), event_date: document.getElementById('e-date').value || null, description: document.getElementById('e-description').value.trim() };
  try {
    if (id) await DB.updateEvent(id, payload); else await DB.createEvent(payload);
    closeModal('event-form-modal'); loadEvents();
    showToast('Event saved!', 'success');
  } catch (_) { showToast('Error saving event', 'error'); }
}

async function deleteEvent(id) {
  if (!confirm('Delete this event and all its devotee assignments?')) return;
  try { await DB.deleteEvent(id); loadEvents(); showToast('Event deleted'); }
  catch (_) { showToast('Error', 'error'); }
}

async function openEventDetail(id) {
  AppState.currentEventId = id;
  openModal('event-detail-modal');
  const events = await DB.getEvents().catch(() => []);
  const ev = events.find(e => e.id === id);
  document.getElementById('event-detail-title').textContent = ev?.event_name || 'Event';
  document.getElementById('event-devotee-search').value = '';
  document.getElementById('event-search-results').innerHTML = '';
  loadEventDevotees();
}

async function loadEventDevotees() {
  const list = document.getElementById('event-devotee-list');
  try {
    const devotees = await DB.getEventDevotees(AppState.currentEventId);
    if (!devotees.length) { list.innerHTML = '<div style="text-align:center;padding:.75rem;color:var(--text-muted);font-size:.82rem">No devotees added yet. Search above to add.</div>'; return; }
    list.innerHTML = devotees.map(d => `
      <div class="care-item">
        <div class="devotee-avatar" style="width:30px;height:30px;font-size:.7rem;flex-shrink:0">${initials(d.name)}</div>
        <div style="flex:1"><div class="care-item-name">${d.name}</div><div class="care-item-meta">${d.team_name||''} ${d.mobile||''}</div></div>
        ${contactIcons(d.mobile)}
        <button class="btn-icon close" style="width:26px;height:26px;font-size:.75rem" onclick="removeEventDevotee('${d.devotee_id}')"><i class="fas fa-times"></i></button>
      </div>`).join('');
  } catch (_) {}
}

async function searchEventDevotees() {
  const q = document.getElementById('event-devotee-search').value.trim();
  const results = document.getElementById('event-search-results');
  if (!q) { results.innerHTML = ''; return; }
  try {
    const devotees = await DB.getDevotees({ search: q });
    if (!devotees.length) { results.innerHTML = '<div style="font-size:.85rem;color:var(--text-muted);padding:.5rem">No results</div>'; return; }
    results.innerHTML = devotees.slice(0, 8).map(d => `
      <div class="event-search-item">
        <div><span style="font-weight:600">${d.name}</span><span style="font-size:.78rem;color:var(--text-muted)"> · ${d.team_name||''}</span></div>
        <button class="btn btn-primary" style="padding:.25rem .7rem;font-size:.8rem" onclick="addEventDevotee('${d.id}', '${d.name.replace(/'/g,"\\'")}')"><i class="fas fa-plus"></i> Add</button>
      </div>`).join('');
  } catch (_) {}
}

async function addEventDevotee(devoteeId, name) {
  try {
    const devotee = await DB.getDevotee(devoteeId);
    await DB.addEventDevotee(AppState.currentEventId, devotee);
    showToast(name + ' added!', 'success');
    document.getElementById('event-devotee-search').value = '';
    document.getElementById('event-search-results').innerHTML = '';
    loadEventDevotees();
  } catch (e) {
    if (e.error === 'Already added') showToast('Already in this event');
    else showToast('Error adding', 'error');
  }
}

async function removeEventDevotee(devoteeId) {
  try { await DB.removeEventDevotee(AppState.currentEventId, devoteeId); loadEventDevotees(); }
  catch (_) { showToast('Error removing', 'error'); }
}

async function exportEventDevotees() {
  if (!AppState.currentEventId) return;
  try {
    const [eventDevotees, allDevotees] = await Promise.all([
      DB.getEventDevotees(AppState.currentEventId),
      DevoteeCache.all(),
    ]);
    if (!eventDevotees.length) return showToast('No devotees in this event', 'error');
    const devMap = Object.fromEntries(allDevotees.map(d => [d.id, d]));
    const rows = eventDevotees.map(d => {
      const full = devMap[d.devotee_id] || {};
      return {
        Name:                d.name,
        Mobile:              d.mobile || '',
        Team:                d.team_name || '',
        'Chanting Rounds':   full.chantingRounds || 0,
        'Gopi Dress':        full.gopiDress ? 'Yes' : 'No',
        'Lifetime AT':       full.lifetimeAttendance || 0,
        'Plays Instrument':  full.playsInstrument || '',
        'Instrument':        full.instrumentName || '',
      };
    });
    downloadExcel(rows, 'event_devotees.xlsx');
  } catch (_) { showToast('Export failed', 'error'); }
}

// ══ MANAGEMENT TAB ══════════════════════════════════════

function toggleMgmtConfig(btn) {
  const row = document.getElementById('mgmt-config-row');
  const hidden = row.classList.toggle('hidden');
  btn.innerHTML = hidden
    ? '<i class="fas fa-cog"></i> Configure'
    : '<i class="fas fa-times"></i> Close';
}

async function saveMgmtCallingDates() {
  const cd = document.getElementById('mgmt-config-calling-date')?.value;
  const sd = document.getElementById('mgmt-config-session-date')?.value;
  if (!cd) { showToast('Please enter a calling date', 'error'); return; }
  try {
    await Promise.all([
      DB.setCallingWeekConfig(cd, sd),
      DB.setCallingWeekHistory(cd, sd),
    ]);
    showToast('Dates saved!', 'success');
    // Collapse config row and reset button label
    const row = document.getElementById('mgmt-config-row');
    if (row) row.classList.add('hidden');
    const cfgBtn = document.querySelector('#tab-management .btn[onclick*="toggleMgmtConfig"]');
    if (cfgBtn) cfgBtn.innerHTML = '<i class="fas fa-cog"></i> Configure';
    // Keep calling tab hidden-input in sync so Export Calling FY works
    const hw = document.getElementById('calling-week');
    if (hw) hw.value = cd;
    window._callingSessionDate = sd;
    loadMgmtTab();
  } catch (e) { showToast('Failed: ' + (e.message || 'Error'), 'error'); }
}

async function loadMgmtTab() {
  const el = document.getElementById('mgmt-tab-content');
  if (!el) return;

  // Pre-fill date config inputs
  const cfg = await DB.getCallingWeekConfig().catch(() => null);
  if (cfg?.callingDate) {
    const i = document.getElementById('mgmt-config-calling-date');
    if (i) i.value = cfg.callingDate;
  }
  if (cfg?.sessionDate) {
    const i = document.getElementById('mgmt-config-session-date');
    if (i) i.value = cfg.sessionDate;
  }

  el.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';
  try {
    const weeks = await DB.getCallingWeekHistory(4);
    const [gridData, allDevotees] = await Promise.all([
      weeks.length ? DB.getMgmtGridData(weeks) : Promise.resolve([]),
      DevoteeCache.all(),
    ]);
    // Compute separate lists from the already-loaded allDevotees array.
    const lists = {
      online:        allDevotees.filter(d => d.callingMode === 'online'),
      festival:      allDevotees.filter(d => d.callingMode === 'festival'),
      notInterested: allDevotees.filter(d => d.callingMode === 'not_interested' || d.isNotInterested === true),
    };
    const activeDevotees = allDevotees.filter(d =>
      d.isActive !== false && d.callingBy && !d.callingMode && !d.isNotInterested
    );
    el.innerHTML = _buildMgmtGrid(gridData, activeDevotees) + _buildMgmtSeparateLists(lists);
  } catch (e) {
    console.error('loadMgmtTab', e);
    el.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load</p></div>';
  }
}

function _buildMgmtGrid(weekData, devotees) {
  if (!devotees.length) {
    return '<div class="empty-state"><i class="fas fa-inbox"></i><p>No devotees with calling assignments found</p></div>';
  }
  const teamMap = {};
  devotees.forEach(d => {
    const t = d.teamName || 'Unknown';
    if (!teamMap[t]) teamMap[t] = [];
    teamMap[t].push(d);
  });

  function fmt(dateStr) {
    if (!dateStr) return '—';
    const [y, m, d] = dateStr.split('-');
    return `${d}.${m}.${y.slice(-2)}`;
  }

  const wkHdr1 = weekData.map(w => {
    const dt = new Date(w.callingDate + 'T00:00:00');
    const lbl = dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' });
    return `<th colspan="2" style="text-align:center;background:#1e40af;color:#fff;white-space:nowrap">${lbl}</th>`;
  }).join('');

  const wkHdr2 = weekData.map(w =>
    `<th style="text-align:center;font-size:.7rem;background:#2d7a57;color:#fff;padding:.25rem .4rem;white-space:nowrap">CS<br><span style="font-weight:400">${fmt(w.callingDate)}</span></th>` +
    `<th style="text-align:center;font-size:.7rem;background:#2d7a57;color:#fff;padding:.25rem .4rem;white-space:nowrap">AT<br><span style="font-weight:400">${fmt(w.sessionDate)}</span></th>`
  ).join('');

  function csCell(cs) {
    if (!cs) return '<td style="background:#fafafa;min-width:32px"></td>';
    const s = cs.comingStatus, r = cs.callingReason;
    if (s === 'Yes') return '<td style="background:#a5d6a7;text-align:center;font-weight:700;font-size:.75rem">✓</td>';
    if (r === 'online_class') return '<td style="background:#bbdefb;text-align:center;font-size:.7rem" title="Online">OL</td>';
    if (r === 'festival_calling') return '<td style="background:#fff9c4;text-align:center;font-size:.7rem" title="Festival">FE</td>';
    if (r === 'not_interested_now') return '<td style="background:#ffcdd2;text-align:center;font-size:.7rem" title="Not Interested">NI</td>';
    if (r) return `<td style="background:#ffe0b2;text-align:center;font-size:.65rem" title="${r}">✗</td>`;
    return '<td style="background:#fafafa"></td>';
  }

  function atCell(devoteeId, atSet) {
    return atSet && atSet.has(devoteeId)
      ? '<td style="background:#4caf50;color:#fff;text-align:center;font-weight:700;font-size:.75rem">P</td>'
      : '<td style="background:#fafafa"></td>';
  }

  let html = `<div class="table-scroll">
  <table style="border-collapse:collapse;min-width:600px;width:100%;font-size:.8rem">
    <thead>
      <tr>
        <th rowspan="2" class="mgmt-col-sticky" style="left:0;min-width:30px;background:#1e40af;color:#fff;padding:.4rem .3rem">#</th>
        <th rowspan="2" class="mgmt-col-sticky" style="left:30px;min-width:160px;background:#1e40af;color:#fff;text-align:left;padding:.4rem .6rem">Name</th>
        <th rowspan="2" style="min-width:80px;background:#1e40af;color:#fff">Team</th>
        <th rowspan="2" style="min-width:110px;background:#1e40af;color:#fff">Calling By</th>
        ${wkHdr1}
        <th rowspan="2" style="text-align:center;background:#1e40af;color:#fff;min-width:44px">Total<br>AT</th>
        <th rowspan="2" style="text-align:center;background:#1e40af;color:#fff;min-width:60px">Action</th>
      </tr>
      <tr>${wkHdr2}</tr>
    </thead>
    <tbody>`;

  let sno = 1;
  TEAMS.forEach(team => {
    const members = teamMap[team];
    if (!members) return;
    html += `<tr style="background:#e8f5e9">
      <td class="mgmt-col-sticky" style="left:0;background:#e8f5e9;text-align:center;font-size:.75rem;color:var(--primary);font-weight:700">${members.length}</td>
      <td class="mgmt-col-sticky" style="left:30px;background:#e8f5e9;font-weight:700;color:var(--primary);padding:.35rem .6rem">${team}</td>
      <td colspan="${2 + weekData.length * 2 + 2}" style="background:#e8f5e9"></td>
    </tr>`;
    members.forEach(d => {
      const wkCells = weekData.map(w => csCell(w.csMap[d.id]) + atCell(d.id, w.atSet)).join('');
      const totalAt = weekData.reduce((n, w) => n + (w.atSet && w.atSet.has(d.id) ? 1 : 0), 0);
      html += `<tr>
        <td class="mgmt-col-sticky" style="left:0;background:#fff;text-align:center;color:var(--text-muted);border-bottom:1px solid #f0f0f0">${sno++}</td>
        <td class="mgmt-col-sticky" style="left:30px;background:#fff;border-bottom:1px solid #f0f0f0;padding:.3rem .5rem">
          <button onclick="openMgmtAction('${d.id}','${(d.name||'').replace(/'/g,"\\'")}')"
            style="background:none;border:none;cursor:pointer;font-weight:600;color:var(--primary);padding:0;text-align:left;font-size:.8rem;width:100%">${d.name}</button>
          ${d.mobile ? `<div style="font-size:.68rem;color:var(--text-muted)">${d.mobile}</div>` : ''}
        </td>
        <td style="border-bottom:1px solid #f0f0f0;padding:.3rem .4rem;white-space:nowrap">
          ${teamBadge(team)}
          <button onclick="showMgmtTeamHistory('${d.id}','${(d.name||'').replace(/'/g,"\\'")}')" title="Team change history" style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:.72rem;padding:.1rem .25rem;margin-left:.15rem;vertical-align:middle;opacity:.7">
            <i class="fas fa-pencil-alt"></i>
          </button>
        </td>
        <td style="border-bottom:1px solid #f0f0f0;padding:.3rem .4rem;font-size:.75rem;color:var(--text-muted)">${d.callingBy || '—'}</td>
        ${wkCells}
        <td style="text-align:center;font-weight:700;color:var(--primary);border-bottom:1px solid #f0f0f0">${d.lifetimeAttendance || totalAt}</td>
        <td style="border-bottom:1px solid #f0f0f0;padding:.3rem .4rem;text-align:center">
          <button onclick="openMgmtAction('${d.id}','${(d.name||'').replace(/'/g,"\\'")}')"
            style="font-size:.72rem;padding:.2rem .5rem;background:var(--accent-light);border:1px solid var(--border);border-radius:4px;cursor:pointer;color:var(--primary);font-weight:600;white-space:nowrap">
            <i class="fas fa-bolt"></i> Action
          </button>
        </td>
      </tr>`;
    });
  });
  html += `</tbody></table></div>`;
  return html;
}

function _buildMgmtSeparateLists({ online, festival, notInterested }) {
  function section(title, icon, bgColor, items) {
    if (!items.length) return '';
    const rows = items.map((d, i) => `<tr style="font-size:.82rem">
      <td style="color:var(--text-muted);text-align:center">${i + 1}</td>
      <td style="font-weight:600">${d.name || ''}</td>
      <td style="font-size:.75rem">${d.mobile || '—'}</td>
      <td style="white-space:nowrap">
        ${teamBadge(d.teamName)}
        <button onclick="showMgmtTeamHistory('${d.id}','${(d.name||'').replace(/'/g,"\\'")}')" title="Team change history" style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:.72rem;padding:.1rem .25rem;margin-left:.15rem;vertical-align:middle;opacity:.7">
          <i class="fas fa-pencil-alt"></i>
        </button>
      </td>
      <td style="font-size:.75rem;color:var(--text-muted)">${d.callingBy || '—'}</td>
      <td><button onclick="restoreMgmtDevotee('${d.id}')"
        style="font-size:.72rem;padding:.15rem .45rem;background:#e8f5e9;border:1px solid var(--secondary);border-radius:4px;cursor:pointer;color:var(--primary)">
        <i class="fas fa-undo"></i> Restore
      </button></td>
    </tr>`).join('');
    return `<div class="sr-team-block" style="margin-bottom:1.25rem">
      <div class="sr-team-banner" style="background:${bgColor};color:#fff">
        <i class="${icon}"></i> ${title} <span style="font-size:.8rem;font-weight:400;opacity:.85">(${items.length})</span>
      </div>
      <table class="calling-table sr-table" style="margin:0">
        <thead><tr><th>#</th><th>Name</th><th>Mobile</th><th>Team</th><th>Calling By</th><th>Restore</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }
  const parts = [
    section('Online Class', 'fas fa-laptop', '#1565c0', online),
    section('Festival Calling', 'fas fa-star', '#e65100', festival),
    section('Not Interested', 'fas fa-ban', '#b71c1c', notInterested),
  ].filter(Boolean);
  if (!parts.length) return '';
  return `<div style="margin-top:1.75rem">
    <div style="font-size:.85rem;font-weight:600;color:var(--text-muted);margin-bottom:.75rem;padding-bottom:.35rem;border-bottom:2px solid var(--border)">
      <i class="fas fa-layer-group"></i> Shifted Devotees — Removed from Calling List
    </div>${parts.join('')}
  </div>`;
}

function openMgmtAction(devoteeId, devoteeName) {
  document.getElementById('mgmt-action-devotee-id').value = devoteeId;
  document.getElementById('mgmt-action-name').textContent = devoteeName;
  document.getElementById('mgmt-team-picker').style.display = 'none';
  document.getElementById('mgmt-action-modal').classList.remove('hidden');
}

async function doMgmtAction(type) {
  const devoteeId = document.getElementById('mgmt-action-devotee-id').value;
  if (!devoteeId) return;
  if (type === 'team') {
    const picker = document.getElementById('mgmt-team-picker');
    picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
    return;
  }
  if (type === 'team_confirm') {
    const newTeam = document.getElementById('mgmt-new-team').value;
    if (!newTeam) return;
    try {
      const allD = await DevoteeCache.all();
      const oldTeam = allD.find(d => d.id === devoteeId)?.teamName || '';
      await fdb.collection('devotees').doc(devoteeId).update({ teamName: newTeam, updatedAt: TS() });
      await fdb.collection('profileChanges').add({ devoteeId, fieldName: 'team_name', oldValue: oldTeam, newValue: newTeam, changedBy: AppState.userName, changedAt: TS() });
      DevoteeCache.bust();
      closeModal('mgmt-action-modal');
      showToast('Team changed!', 'success');
      loadMgmtTab();
    } catch (e) { showToast('Failed: ' + (e.message || 'Error'), 'error'); }
    return;
  }
  const labels = { online: 'Online Class', festival: 'Festival Calling', not_interested: 'Not Interested' };
  const name = document.getElementById('mgmt-action-name').textContent;
  if (!confirm(`Shift "${name}" to ${labels[type]}?\n\nThis will remove them from the calling list and clear their Calling By assignment.`)) return;
  try {
    await DB.setDevoteeCallingMode(devoteeId, type);
    closeModal('mgmt-action-modal');
    showToast(`Shifted to ${labels[type]}!`, 'success');
    loadMgmtTab();
  } catch (e) { showToast('Failed: ' + (e.message || 'Error'), 'error'); }
}

async function restoreMgmtDevotee(devoteeId) {
  if (!confirm('Restore to regular calling list?\nTheir Calling By will need to be reassigned.')) return;
  try {
    await fdb.collection('devotees').doc(devoteeId).update({ callingMode: '', isNotInterested: false, updatedAt: TS() });
    DevoteeCache.bust();
    showToast('Restored!', 'success');
    loadMgmtTab();
  } catch (e) { showToast('Failed', 'error'); }
}

async function showMgmtTeamHistory(devoteeId, devoteeName) {
  const titleEl = document.getElementById('history-modal-title');
  const content = document.getElementById('history-content');
  if (titleEl) titleEl.textContent = `Team History — ${devoteeName}`;
  content.innerHTML = '<div class="loading" style="padding:1.5rem"><i class="fas fa-spinner"></i></div>';
  openModal('history-modal');
  try {
    const history = await DB.getTeamChangeHistory(devoteeId);
    if (!history.length) {
      content.innerHTML = '<div class="empty-state" style="padding:2rem"><i class="fas fa-users"></i><p>No team changes recorded</p></div>';
      return;
    }
    content.innerHTML = history.map((h, i) => {
      const oldTeam = h.oldValue || history[i + 1]?.newValue || '—';
      const newTeam = h.newValue || '—';
      const iso = h.changedAt?.toDate ? h.changedAt.toDate().toISOString() : (h.changedAt || null);
      return `<div class="history-item">
        <div class="history-field"><i class="fas fa-users" style="color:var(--primary);margin-right:.35rem"></i> Team Change</div>
        <div class="history-change"><span class="old">${oldTeam}</span> <i class="fas fa-arrow-right" style="color:var(--text-muted);font-size:.7rem"></i> <span class="new">${newTeam}</span></div>
        <div class="history-date">${formatDateTime(iso)}<br><span style="font-size:.7rem">by ${h.changedBy || '—'}</span></div>
      </div>`;
    }).join('');
  } catch (_) {
    content.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load history</p></div>';
  }
}

async function exportMgmtFY() {
  showToast('Preparing FY export…');
  try {
    const now = new Date();
    const fyStartYear = (now.getMonth() + 1) >= 4 ? now.getFullYear() : now.getFullYear() - 1;
    const fyStart = `${fyStartYear}-04-01`;
    const today = getToday();
    const allWeeks = await DB.getCallingWeekHistory(52);
    const fyWeeks = allWeeks.filter(w => w.callingDate >= fyStart && w.callingDate <= today);
    if (!fyWeeks.length) { showToast('No data for this FY', 'error'); return; }
    // Process in batches of 10 weeks to avoid firing 100+ parallel Firestore
    // queries at once (a full FY can have up to 52 weeks × 3 queries each).
    const allDevotees = await DevoteeCache.all();
    const gridData = [];
    for (let i = 0; i < fyWeeks.length; i += 10) {
      const chunk = await DB.getMgmtGridData(fyWeeks.slice(i, i + 10));
      gridData.push(...chunk);
    }
    const activeDevotees = allDevotees.filter(d =>
      d.isActive !== false && d.callingBy && !d.callingMode && !d.isNotInterested
    );
    const XS = _xls();
    const wb = XLSX.utils.book_new();
    const HDR = XS.hdr('1A5C3A', 'FFFFFF');
    const SUB = XS.hdr('C8E6C9', '1B5E20');
    const GRD = XS.hdr('0D3B22', 'FFFFFF');
    function fmt(dateStr) {
      if (!dateStr) return '—';
      const [y, m, d] = dateStr.split('-');
      return `${d}.${m}.${y.slice(-2)}`;
    }
    const baseHdrs = ['#', 'Name', 'Mobile', 'Team', 'Calling By'];
    const weekHdrs = fyWeeks.flatMap(w => [`CS ${fmt(w.callingDate)}`, `AT ${fmt(w.sessionDate)}`]);
    const headers = [...baseHdrs, ...weekHdrs, 'Total AT'];
    const colW = [{ wch: 4 }, { wch: 28 }, { wch: 14 }, { wch: 14 }, { wch: 20 },
      ...fyWeeks.flatMap(() => [{ wch: 9 }, { wch: 9 }]), { wch: 8 }];
    const rows = [headers.map(h => ({ v: h, s: HDR }))];
    let sno = 1;
    TEAMS.forEach(team => {
      const members = activeDevotees.filter(d => (d.teamName || '') === team);
      if (!members.length) return;
      rows.push([team, ...Array(headers.length - 1).fill('')].map((v, i) => ({ v, s: i === 0 ? SUB : XS.hdr('C8E6C9', '1B5E20') })));
      members.forEach(d => {
        const wkVals = fyWeeks.flatMap(w => {
          const cs = w.csMap[d.id];
          return [cs?.comingStatus === 'Yes' ? 'Yes' : (cs?.callingReason || ''), w.atSet?.has(d.id) ? 'P' : ''];
        });
        const totalAt = fyWeeks.reduce((n, w) => n + (w.atSet?.has(d.id) ? 1 : 0), 0);
        rows.push([sno++, d.name, d.mobile || '', d.teamName || '', d.callingBy || '', ...wkVals, totalAt].map(v => ({ v, s: XS.cell() })));
      });
    });
    const ws = _xlsSheet(rows, colW);
    XLSX.utils.book_append_sheet(wb, ws, `FY ${fyStartYear}-${String(fyStartYear + 1).slice(-2)}`);
    XLSX.writeFile(wb, `Mgmt_FY${fyStartYear}-${String(fyStartYear + 1).slice(-2)}.xlsx`);
    showToast('Downloaded!');
  } catch (e) {
    console.error(e);
    showToast('Export failed', 'error');
  }
}

// ══ REPORTS → YEARLY SHEET SUB-TAB ══════════════════════════════════════════

function _fyRangeFor(dateStr) {
  const ref = dateStr || getToday();
  const [y, m] = ref.split('-').map(Number);
  const startYear = m >= 4 ? y : y - 1;
  return { start: `${startYear}-04-01`, end: `${startYear + 1}-03-31` };
}

async function loadYearlySheet() {
  const wrap = document.getElementById('yearly-sheet-wrap');
  if (!wrap) return;
  const r = _reportRange();
  const start = r.start, end = r.end;
  const teamFilter = getFilterTeam();
  wrap.innerHTML = '<div class="loading" style="padding:2rem"><i class="fas fa-spinner"></i> Loading…</div>';
  try {
    const [sheetData, stats] = await Promise.all([
      DB.getSheetData(start, end),
      AppState.currentSessionId
        ? DB.getSessionStats(AppState.currentSessionId).catch(() => null)
        : Promise.resolve(null)
    ]);
    const { sessions, devotees, attMap, attTimeMap, csMap } = sheetData;
    if (!sessions.length) {
      wrap.innerHTML = `<div class="empty-state"><i class="fas fa-table"></i><p>No sessions in this ${r.period} for ${teamFilter || 'any team'}</p></div>`;
      return;
    }
    const statsBar = stats ? `
      <div class="sh-stats-bar">
        <div class="sh-stat-pill" style="border-top:3px solid var(--brand)">
          <span class="sh-stat-num" style="color:var(--brand)">${stats.confirmed}</span>
          <span class="sh-stat-lbl">Confirmed</span>
        </div>
        <div class="sh-stat-pill" style="border-top:3px solid var(--success)">
          <span class="sh-stat-num" style="color:var(--success)">${stats.present}</span>
          <span class="sh-stat-lbl">Present</span>
        </div>
        <div class="sh-stat-pill" style="border-top:3px solid var(--gold)">
          <span class="sh-stat-num" style="color:var(--gold)">${stats.newDevotees}</span>
          <span class="sh-stat-lbl">New</span>
        </div>
        <div class="sh-stat-pill" style="border-top:3px solid #6366f1">
          <span class="sh-stat-num" style="color:#6366f1">${stats.totalPresent}</span>
          <span class="sh-stat-lbl">Total Present</span>
        </div>
      </div>` : '';
    wrap.innerHTML = statsBar + buildFullSheetTable(devotees, sessions, attMap, csMap, teamFilter, attTimeMap);
  } catch (e) {
    console.error('loadYearlySheet', e);
    wrap.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load</p></div>';
  }
}

// ══ ATTENDANCE TAB — ACCURACY REPORT ════════════════════════════════════════
// Shows: per-team and per-caller breakdown of who said Yes vs who actually came.
// Logic mirrors _loadAccuracyReport() in ui-calling.js but lives in the
// Attendance tab so users don't need to switch tabs to check calling accuracy.

async function loadAttAccuracyReport() {
  const el = document.getElementById('att-accuracy-content');
  if (!el) return;
  el.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';

  try {
    const sessionId = AppState.currentSessionId;
    if (!sessionId) {
      el.innerHTML = '<div class="empty-state"><i class="fas fa-calendar-alt"></i><p>No session selected</p></div>';
      return;
    }

    // Derive the calling date (Saturday) that corresponds to this session (Sunday).
    // The session doc only stores sessionDate — callingDate is always sessionDate − 1 day.
    // Exception: for the currently configured week, settings/callingWeek may store a
    // custom callingDate (e.g. if calling was done on a non-Saturday). Use that when available.
    const [sessSnap, cfgSnap] = await Promise.all([
      fdb.collection('sessions').doc(sessionId).get(),
      fdb.collection('settings').doc('callingWeek').get(),
    ]);
    const sessionDate = sessSnap.exists ? sessSnap.data().sessionDate : sessionId;
    const cfg = cfgSnap.exists ? cfgSnap.data() : null;

    let callingDate;
    if (cfg?.sessionDate === sessionDate && cfg.callingDate) {
      callingDate = cfg.callingDate;
    } else {
      // Standard: calling Saturday = session Sunday − 1 day
      const d = new Date(sessionDate + 'T00:00:00');
      d.setDate(d.getDate() - 1);
      callingDate = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }

    // Pass sessionDate so getCallingReport doesn't have to re-derive it from callingDate+1,
    // which would be wrong when the calling date is not the standard Saturday before the session.
    const report = await DB.getCallingReport(callingDate, sessionDate);
    const teams = Object.keys(report).filter(k => !k.startsWith('_'));

    if (!teams.length) {
      el.innerHTML = '<div class="empty-state"><i class="fas fa-chart-bar"></i><p>No calling data for this session</p></div>';
      return;
    }

    if (!report._hasSession) {
      const sd = new Date(sessionDate + 'T00:00:00');
      const sdLabel = sd.toLocaleDateString('en-IN', { weekday:'short', day:'numeric', month:'short', year:'numeric' });
      el.innerHTML = `<div class="empty-state"><i class="fas fa-clock"></i><p>Attendance not yet marked for ${sdLabel}.<br>Accuracy report is available after the session attendance is entered.</p></div>`;
      return;
    }

    const weekLabel = new Date(callingDate + 'T00:00:00').toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' });
    let grandYes = 0, grandCame = 0, grandAbsent = 0;
    let bodyRows = '';

    teams.forEach(team => {
      const t = report[team];
      // Skip teams with no calling data at all
      if (!t.yes && !t.yesAndCame && !t.yesNotCame) return;

      grandYes    += t.yes;
      grandCame   += t.yesAndCame;
      grandAbsent += t.yesNotCame;

      const teamAcc = t.yes > 0 ? Math.round(t.yesAndCame / t.yes * 100) : 0;
      const teamAccStyle = `font-weight:700;color:${teamAcc >= 80 ? 'var(--success)' : teamAcc >= 50 ? '#f57f17' : '#c62828'}`;
      const teamAbsentCell = t.yesNotCame > 0
        ? `<button class="acc-absent-btn" onclick='openAbsentModal("${callingDate}",null,"${team.replace(/"/g,'&quot;')}")'>${t.yesNotCame}</button>`
        : `<span style="color:var(--text-muted)">0</span>`;

      bodyRows += `<tr style="background:var(--accent-light);font-weight:700;font-size:.83rem">
        <td>${teamBadge(team)}</td>
        <td style="text-align:center">${t.yes}</td>
        <td style="text-align:center;color:var(--success)">${t.yesAndCame}</td>
        <td style="text-align:center">${teamAbsentCell}</td>
        <td style="${teamAccStyle}">${teamAcc}%</td>
      </tr>`;

      // Per-caller rows (submitted callers only — unsubmitted have no yesAndCame data)
      const sortedCallers = Object.entries(t.callers).sort(([,a],[,b]) => {
        if (a.isCoordinator && !b.isCoordinator) return -1;
        if (!a.isCoordinator && b.isCoordinator) return 1;
        return 0;
      });
      sortedCallers.forEach(([caller, s]) => {
        if (!s.submitted) {
          bodyRows += `<tr style="font-size:.8rem;background:#fff8e1">
            <td style="padding-left:1.4rem;color:var(--text-muted)">${caller}</td>
            <td colspan="4" style="color:#c62828;font-size:.78rem"><i class="fas fa-clock"></i> Not Submitted — accuracy unavailable</td>
          </tr>`;
          return;
        }
        const callerAcc = s.yes > 0 ? Math.round(s.yesAndCame / s.yes * 100) : null;
        const callerAccStyle = callerAcc === null ? 'color:var(--text-muted)' :
          `color:${callerAcc >= 80 ? 'var(--success)' : callerAcc >= 50 ? '#f57f17' : '#c62828'}`;
        const callerAbsentCell = s.yesNotCame > 0
          ? `<button class="acc-absent-btn" onclick='openAbsentModal("${callingDate}","${caller.replace(/"/g,'&quot;')}","${team.replace(/"/g,'&quot;')}")'>${s.yesNotCame}</button>`
          : `<span style="color:var(--text-muted)">0</span>`;
        bodyRows += `<tr style="font-size:.82rem">
          <td style="padding-left:1.4rem;color:var(--text-muted)">${caller}</td>
          <td style="text-align:center">${s.yes}</td>
          <td style="text-align:center;color:var(--success)">${s.yesAndCame}</td>
          <td style="text-align:center">${callerAbsentCell}</td>
          <td style="text-align:center;${callerAccStyle}">${callerAcc !== null ? callerAcc + '%' : '—'}</td>
        </tr>`;
      });
    });

    const grandAcc = grandYes > 0 ? Math.round(grandCame / grandYes * 100) : 0;
    const grandAbsentCell = grandAbsent > 0
      ? `<button class="acc-absent-btn" onclick='openAbsentModal("${callingDate}",null,null)'>${grandAbsent}</button>`
      : `<span>0</span>`;
    const grandAccStyle = `color:${grandAcc >= 80 ? '#a5d6a7' : grandAcc >= 50 ? '#ffe082' : '#ef9a9a'}`;

    el.innerHTML = `
      <div style="font-size:.84rem;margin-bottom:.55rem">
        <strong><i class="fas fa-bullseye"></i> Calling Accuracy — ${weekLabel}</strong>
        <span style="margin-left:.65rem;font-size:.78rem;color:var(--text-muted)">
          Click an absent count to see who didn't come
        </span>
      </div>
      <div class="table-scroll">
        <table class="calling-table cs-report-table" style="margin:0;min-width:360px">
          <thead><tr>
            <th style="min-width:120px">Team / Calling By</th>
            <th style="text-align:center;min-width:46px;color:#a5d6a7">Said Yes</th>
            <th style="text-align:center;min-width:40px;color:#a5d6a7">Came</th>
            <th style="text-align:center;min-width:46px;color:#ef9a9a">Absent</th>
            <th style="text-align:center;min-width:52px">Accuracy %</th>
          </tr></thead>
          <tbody>
            ${bodyRows || '<tr><td colspan="5" style="text-align:center;padding:1.5rem;color:var(--text-muted)">No data for this session</td></tr>'}
            <tr style="background:#1e40af;color:#fff;font-weight:700;font-size:.83rem">
              <td>Grand Total</td>
              <td style="text-align:center">${grandYes}</td>
              <td style="text-align:center">${grandCame}</td>
              <td style="text-align:center">${grandAbsentCell}</td>
              <td style="text-align:center;${grandAccStyle}">${grandAcc}%</td>
            </tr>
          </tbody>
        </table>
      </div>`;
  } catch (e) {
    console.error('loadAttAccuracyReport', e);
    el.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load accuracy report</p></div>';
  }
}

// ══ CALLING MANAGEMENT DASHBOARD TAB (superAdmin only) ══════════════════════

let _cmActiveSubtab = 'calling';
let _cmData = null;

function toggleCMConfig(btn) {
  const row = document.getElementById('cm-config-row');
  const hidden = row.classList.toggle('hidden');
  btn.innerHTML = hidden ? '<i class="fas fa-cog"></i> Configure' : '<i class="fas fa-times"></i> Close';
}

async function saveCMCallingDates() {
  const cd = document.getElementById('cm-config-calling-date')?.value;
  const sd = document.getElementById('cm-config-session-date')?.value;
  if (!cd) { showToast('Please enter a calling date', 'error'); return; }
  try {
    await Promise.all([
      DB.setCallingWeekConfig(cd, sd),
      DB.setCallingWeekHistory(cd, sd),
    ]);
    showToast('Dates saved!', 'success');
    const row = document.getElementById('cm-config-row');
    if (row) row.classList.add('hidden');
    const cfgBtn = document.querySelector('#tab-calling-mgmt .btn[onclick*="toggleCMConfig"]');
    if (cfgBtn) cfgBtn.innerHTML = '<i class="fas fa-cog"></i> Configure';
    // Keep calling tab in sync
    const hw = document.getElementById('calling-week');
    if (hw) hw.value = cd;
    window._callingSessionDate = sd;
    // Also sync mgmt tab inputs
    const mi = document.getElementById('mgmt-config-calling-date');
    if (mi) mi.value = cd;
    const msi = document.getElementById('mgmt-config-session-date');
    if (msi) msi.value = sd || '';
    loadCallingMgmtTab();
  } catch (e) { showToast('Failed: ' + (e.message || 'Error'), 'error'); }
}

function switchCallingMgmtTab(tab, btn) {
  _cmActiveSubtab = tab;
  document.querySelectorAll('#calling-mgmt-tabs .att-sub-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  else document.querySelector(`#calling-mgmt-tabs .att-sub-tab[onclick*="'${tab}'"]`)?.classList.add('active');
  ['calling', 'newcomers', 'online', 'notinterested', 'festival'].forEach(p => {
    const el = document.getElementById('calling-mgmt-panel-' + p);
    if (el) el.classList.toggle('active', p === tab);
  });
  if (tab === 'calling')       _renderCMWeek();
  if (tab === 'newcomers')     _renderCMNewComers();
  if (tab === 'online')        _renderCMSingleList('online');
  if (tab === 'notinterested') _renderCMSingleList('notinterested');
  if (tab === 'festival')      _renderCMSingleList('festival');
  renderBreadcrumb?.();
}

// Cache CM data so team / callingBy changes are pure re-renders (no network).
// Keyed by the calling week — if config hasn't changed and no write busted the
// cache, we skip the fetch entirely and just re-render with current filters.
let _cmCacheKey = null;
function _bustCMCache() { _cmCacheKey = null; _cmData = null; }
window._bustCMCache = _bustCMCache;

async function loadCallingMgmtTab() {
  const weekEl = document.getElementById('cm-week-content');

  // Resolve the cache key first (cheap config read) so we can short-circuit.
  let cfg;
  try { cfg = await DB.getCallingWeekConfig().catch(() => null); }
  catch (_) { cfg = null; }
  const currentWeek    = cfg?.callingDate || '';
  const currentSession = cfg?.sessionDate || '';
  const key = currentWeek;

  // CACHE HIT — just re-render the active sub-tab with current filters. Instant.
  if (_cmData && _cmCacheKey === key) {
    _cmDispatchSubtabRender();
    return;
  }

  // CACHE MISS — spinner, fetch, cache, render.
  if (weekEl) weekEl.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';

  try {
    // Pre-fill config inputs
    const ci = document.getElementById('cm-config-calling-date');
    if (ci && currentWeek) ci.value = currentWeek;
    const si = document.getElementById('cm-config-session-date');
    if (si && currentSession) si.value = currentSession;

    // getCallingWeekHistory returns oldest-first (it .reverse()s the desc query)
    const histWeeks = await DB.getCallingWeekHistory(4);

    // If current week wasn't saved to history yet, append it
    let weeks = histWeeks;
    if (currentWeek && !weeks.some(w => w.callingDate === currentWeek)) {
      weeks = [...weeks, { callingDate: currentWeek, sessionDate: currentSession }].slice(-4);
    }

    const [gridData, allDevotees] = await Promise.all([
      weeks.length ? DB.getMgmtGridData(weeks) : Promise.resolve([]),
      DevoteeCache.all(),
    ]);

    _cmData = { devotees: allDevotees, weeks, gridData, currentWeek };
    _cmCacheKey = key;

    _cmDispatchSubtabRender();
  } catch (e) {
    console.error('loadCallingMgmtTab', e);
    if (weekEl) weekEl.innerHTML = `<div class="empty-state"><i class="fas fa-exclamation-circle"></i>
      <p>Failed to load.<br><small style="color:var(--danger)">If this is your first time: deploy Firestore rules in Firebase Console → Firestore → Rules, then refresh.</small></p></div>`;
  }
}

function _cmDispatchSubtabRender() {
  if (_cmActiveSubtab === 'calling')       _renderCMWeek();
  if (_cmActiveSubtab === 'newcomers')     _renderCMNewComers();
  if (_cmActiveSubtab === 'online')        _renderCMSingleList('online');
  if (_cmActiveSubtab === 'notinterested') _renderCMSingleList('notinterested');
  if (_cmActiveSubtab === 'festival')      _renderCMSingleList('festival');
}

// Bulk selection state for Calling Mgmt — long-press to enter select mode
let _cmSelected  = new Set();
let _cmSelectMode = false;
let _cmPressTimer = null;
let _cmJustTriggered = false;     // suppress the click that follows a long-press
const _CM_LONG_PRESS_MS = 600;

function _enterCMSelectMode() {
  _cmSelectMode = true;
  document.getElementById('cm-week-content')?.classList.add('cm-select-mode');
  if (navigator.vibrate) navigator.vibrate(40);
}
function _exitCMSelectMode() {
  _cmSelectMode = false;
  _cmSelected.clear();
  const host = document.getElementById('cm-week-content');
  host?.classList.remove('cm-select-mode');
  host?.querySelectorAll('input.cm-row-check').forEach(b => b.checked = false);
  const master = document.getElementById('cm-check-all');
  if (master) master.checked = false;
  _updateBulkBar();
}
function _cmStartPress(id) {
  if (_cmSelectMode) return;
  clearTimeout(_cmPressTimer);
  _cmPressTimer = setTimeout(() => {
    _enterCMSelectMode();
    _cmSelected.add(id);
    const box = document.querySelector(`#cm-week-content input.cm-row-check[data-id="${id}"]`);
    if (box) box.checked = true;
    _updateBulkBar();
    // Ignore the click that fires on release — otherwise it would toggle the
    // checkbox straight back off and drop us out of select mode.
    _cmJustTriggered = true;
    setTimeout(() => { _cmJustTriggered = false; }, 500);
  }, _CM_LONG_PRESS_MS);
}
function _cmEndPress() { clearTimeout(_cmPressTimer); }
function _cmRowTap(id, ev) {
  if (_cmJustTriggered) { _cmJustTriggered = false; return; }
  if (!_cmSelectMode) return;
  const tag = (ev.target.tagName || '').toUpperCase();
  if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || ev.target.closest('button, a, input')) return;
  const box = document.querySelector(`#cm-week-content input.cm-row-check[data-id="${id}"]`);
  if (!box) return;
  box.checked = !box.checked;
  _toggleCMSel(id, box.checked);
  if (!_cmSelected.size) _exitCMSelectMode();
}

function _toggleCMSel(id, checked) {
  if (checked) _cmSelected.add(id); else _cmSelected.delete(id);
  _updateBulkBar();
}
function _toggleCMSelAll(checked) {
  if (checked && !_cmSelectMode) _enterCMSelectMode();
  const boxes = document.querySelectorAll('#cm-week-content input.cm-row-check');
  boxes.forEach(b => { b.checked = checked; _toggleCMSel(b.dataset.id, checked); });
  if (!checked && !_cmSelected.size) _exitCMSelectMode();
}
function _updateBulkBar() {
  const bar = document.getElementById('cm-bulk-bar');
  if (!bar) return;
  const n = _cmSelected.size;
  bar.classList.toggle('cm-bulk-visible', n > 0);
  const cnt = bar.querySelector('.cm-bulk-count');
  if (cnt) cnt.textContent = n;
}
function _clearCMSelection() { _exitCMSelectMode(); }

// Explicit "Select" toggle — tappable on mobile so users don't have to rely
// on long-press, which can get cancelled by scroll/OS gestures.
function _toggleCMSelectMode() {
  if (_cmSelectMode) _exitCMSelectMode();
  else _enterCMSelectMode();
}

function _renderCMWeek() {
  const el = document.getElementById('cm-week-content');
  if (!el) return;
  if (!_cmData) { el.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i></div>'; return; }

  const { devotees, gridData, currentWeek } = _cmData;
  _cmSelected.clear();

  if (!currentWeek) {
    el.innerHTML = `<div class="empty-state"><i class="fas fa-calendar-times"></i>
      <p>No calling date configured yet.<br>Click <strong>Configure</strong> above to set dates.</p></div>`;
    return;
  }

  // Team + Calling By come from the master filter bar; search stays local.
  const savedTeam = (typeof getFilterTeam      === 'function') ? getFilterTeam()      : '';
  const savedBy   = (typeof getFilterCallingBy === 'function') ? getFilterCallingBy() : '';
  const savedQ    = (document.getElementById('cm-filter-search')?.value || '').trim().toLowerCase();

  const currentWkData = gridData.find(w => w.callingDate === currentWeek) || { csMap: {}, atSet: new Set() };
  const histWkData    = gridData.filter(w => w.callingDate !== currentWeek);

  // Only show devotees in normal calling mode — exclude online/festival/not_interested
  // modes since they are managed separately and should not inflate the "Not Called" count.
  const activeDevotees = devotees.filter(d =>
    d.is_active !== false && !d.calling_mode && !d.is_not_interested
  );

  function isUncalled(d) {
    const cs = currentWkData.csMap[d.id];
    return !cs || (!cs.comingStatus && !cs.callingReason);
  }

  let filtered = activeDevotees;
  if (savedTeam) filtered = filtered.filter(d => d.teamName === savedTeam);
  if (savedBy)   filtered = filtered.filter(d => d.callingBy === savedBy);
  if (savedQ)    filtered = filtered.filter(d =>
    (d.name || '').toLowerCase().includes(savedQ) ||
    (d.mobile || '').includes(savedQ) ||
    (d.mobileAlt || '').includes(savedQ)
  );

  const uncalledCount = filtered.filter(d => isUncalled(d)).length;
  const comingCount   = filtered.filter(d => currentWkData.csMap[d.id]?.comingStatus === 'Yes').length;

  const histHdrs = histWkData.map(w => {
    const lbl = new Date(w.callingDate + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    return `<th style="text-align:center;min-width:50px;background:#2d7a57;color:#fff;font-size:.7rem">${lbl}</th>`;
  }).join('');

  const teamMap = {};
  filtered.forEach(d => {
    const t = d.teamName || 'Unknown';
    if (!teamMap[t]) teamMap[t] = [];
    teamMap[t].push(d);
  });

  // Team + Calling By come from master filter bar — no per-tab dropdowns here.

  function csChip(cs) {
    if (!cs || (!cs.comingStatus && !cs.callingReason))
      return '<span class="cm-pill cm-none"><i class="fas fa-circle-notch"></i> Not called</span>';
    let main;
    if (cs.comingStatus === 'Yes') {
      main = '<span class="cm-pill cm-yes"><i class="fas fa-check-circle"></i> Confirmed Coming</span>';
    } else if (cs.callingReason) {
      const lbl = (typeof _reasonLabel === 'function' ? _reasonLabel(cs.callingReason) : cs.callingReason);
      const avail = cs.availableFrom ? ` · from ${formatDate(cs.availableFrom)}` : '';
      main = `<span class="cm-pill cm-reason">${lbl}${avail}</span>`;
    } else {
      main = '<span class="cm-pill cm-none">—</span>';
    }
    const notes = cs.callingNotes
      ? `<div class="cm-notes">"${(cs.callingNotes+'').replace(/"/g,'&quot;')}"</div>`
      : '';
    return `<div class="cm-status-cell">${main}${notes}</div>`;
  }

  function histDots(devoteeId) {
    return histWkData.map(w => {
      const cs = w.csMap[devoteeId];
      const at = w.atSet?.has(devoteeId);
      let chip;
      if (at) {
        chip = `<span style="background:#e8f5e9;color:#2e7d32;padding:.1rem .3rem;border-radius:3px;font-size:.68rem;font-weight:700;white-space:nowrap"><i class="fas fa-check"></i> Came</span>`;
      } else if (cs?.comingStatus === 'Yes') {
        chip = `<span style="background:#fff9c4;color:#f57f17;padding:.1rem .3rem;border-radius:3px;font-size:.68rem;white-space:nowrap">Yes—Absent</span>`;
      } else if (cs?.callingReason) {
        const lbl = _reasonLabel ? _reasonLabel(cs.callingReason) : cs.callingReason;
        chip = `<span style="background:#fff3e0;color:#e65100;padding:.1rem .3rem;border-radius:3px;font-size:.68rem;white-space:nowrap">${lbl}</span>`;
      } else if (cs) {
        chip = `<span style="color:var(--text-muted);font-size:.68rem;white-space:nowrap">Called</span>`;
      } else {
        chip = `<span style="color:#bdbdbd;font-size:.68rem;white-space:nowrap">—</span>`;
      }
      return `<td style="text-align:left;padding:.3rem .4rem;min-width:80px">${chip}</td>`;
    }).join('');
  }

  let rows = '';
  let sno  = 1;
  // Render TEAMS in canonical order, then any extra teams present in DB but not in TEAMS list
  const orderedTeams = [
    ...TEAMS.filter(t => teamMap[t]?.length),
    ...Object.keys(teamMap).filter(t => !TEAMS.includes(t) && teamMap[t]?.length).sort()
  ];
  orderedTeams.forEach(team => {
    const members = teamMap[team];
    if (!members?.length) return;
    rows += `<tr style="background:#e8f5e9">
      <td class="cm-check-cell" style="background:#e8f5e9;padding:.3rem .3rem;text-align:center">
        <input type="checkbox" onchange="_cmSelectTeam('${team.replace(/'/g,"\\'")}', this.checked)" title="Select all in ${team}">
      </td>
      <td colspan="${5 + histWkData.length + 3}" style="font-weight:700;color:var(--primary);padding:.3rem .6rem">
        <i class="fas fa-users" style="font-size:.7rem"></i> ${team}
        <span style="font-size:.74rem;font-weight:400;opacity:.75"> (${members.length})</span>
      </td>
    </tr>`;
    members.forEach(d => {
      const cs       = currentWkData.csMap[d.id];
      const uncalled = isUncalled(d);
      const safeName = (d.name || '').replace(/'/g, "\\'");
      const safeTeam = (team || '').replace(/'/g, "\\'");
      rows += `<tr class="cm-row" style="${uncalled ? 'background:#fffde7' : ''}"
        onmousedown="_cmStartPress('${d.id}')" onmouseup="_cmEndPress()" onmouseleave="_cmEndPress()"
        ontouchstart="_cmStartPress('${d.id}')" ontouchend="_cmEndPress()" ontouchcancel="_cmEndPress()"
        onclick="_cmRowTap('${d.id}', event)">
        <td class="cm-check-cell" style="text-align:center;padding:.3rem .3rem">
          <input type="checkbox" class="cm-row-check" data-id="${d.id}" data-team="${safeTeam}" onchange="_toggleCMSel('${d.id}', this.checked)" onclick="event.stopPropagation()">
        </td>
        <td style="text-align:center;color:var(--text-muted);font-size:.74rem;padding:.3rem .3rem">${sno++}</td>
        <td style="padding:.3rem .5rem;min-width:140px">
          <button class="cm-link" onclick="openProfileModal('${d.id}')" title="Open profile">${d.name}</button>
          ${d.mobile ? `<div style="font-size:.68rem;color:var(--text-muted)">${d.mobile}${d.mobileAlt ? ` · <span style="color:var(--text-light)">+1</span>` : ''}</div>` : ''}
        </td>
        <td style="padding:.3rem .4rem;white-space:nowrap">
          ${contactIcons(d.mobile, { altMobile: d.mobileAlt, devoteeId: d.id, name: d.name })}
        </td>
        <td style="padding:.3rem .4rem;white-space:nowrap">
          <button class="cm-team-btn" onclick="openTeamChangeQuick('${d.id}','${safeName}','${safeTeam}')" title="Change team">
            ${teamBadge(team)}
          </button>
          <button class="cm-team-history-btn" onclick="showMgmtTeamHistory('${d.id}','${safeName}')" title="Past team history">
            <i class="fas fa-pencil-alt"></i>
          </button>
        </td>
        <td style="padding:.3rem .4rem">
          ${d.callingBy
            ? `<button class="cm-link cm-link-muted" onclick="openChangeCallingBy('${d.id}','${safeName}','${safeTeam}','${(d.callingBy||'').replace(/'/g,"\\'")}')">${d.callingBy}</button>`
            : `<button class="cm-link cm-link-muted" onclick="openChangeCallingBy('${d.id}','${safeName}','${safeTeam}','')">— Assign —</button>`
          }
        </td>
        <td style="padding:.3rem .4rem;min-width:170px">${csChip(cs)}</td>
        ${histDots(d.id)}
        <td style="text-align:center;font-weight:700;color:var(--primary);font-size:.8rem">${d.lifetimeAttendance || 0}</td>
        <td style="padding:.3rem .4rem">
          <button onclick="openMgmtAction('${d.id}','${safeName}')"
            style="font-size:.72rem;padding:.2rem .5rem;background:var(--accent-light);border:1px solid var(--border);border-radius:4px;cursor:pointer;color:var(--primary);font-weight:600;white-space:nowrap">
            <i class="fas fa-bolt"></i> Action
          </button>
        </td>
      </tr>`;
    });
  });

  const dateLabel = new Date(currentWeek + 'T00:00:00').toLocaleDateString('en-IN',
    { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

  el.innerHTML = `
    <div class="cm-header-row">
      <div style="font-size:.84rem;color:var(--text-muted)">
        <i class="fas fa-phone-alt"></i> Week: <strong style="color:var(--primary)">${dateLabel}</strong>
      </div>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap">
        <span style="background:#fff3e0;color:#e65100;padding:.2rem .6rem;border-radius:4px;font-size:.78rem;font-weight:600">
          <i class="fas fa-circle-notch"></i> ${uncalledCount} not called
        </span>
        <span style="background:#e8f5e9;color:#2e7d32;padding:.2rem .6rem;border-radius:4px;font-size:.78rem;font-weight:600">
          <i class="fas fa-check-circle"></i> ${comingCount} confirmed
        </span>
      </div>
      <div class="cm-filters">
        <div class="cm-search-wrap">
          <i class="fas fa-search"></i>
          <input type="text" id="cm-filter-search" placeholder="Search name or mobile…"
            value="${savedQ.replace(/"/g,'&quot;')}"
            autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
            data-form-type="other" data-lpignore="true" data-1p-ignore="true"
            readonly onfocus="this.removeAttribute('readonly')"
            oninput="_onCMSearch(this.value)">
        </div>
      </div>
    </div>

    <!-- Select toggle — visible entry point (long-press still works too) -->
    <div class="cm-select-toggle-row">
      <button class="btn btn-secondary cm-select-toggle" onclick="_toggleCMSelectMode()">
        <i class="fas fa-check-square"></i> <span class="cm-select-toggle-label">Select (Bulk Action)</span>
      </button>
      <span class="cm-hint"><i class="fas fa-hand-pointer"></i> or long-press any row</span>
    </div>

    <!-- Bulk action bar — appears at top of list when selections exist -->
    <div id="cm-bulk-bar" class="cm-bulk-bar">
      <span class="cm-bulk-info"><i class="fas fa-check-square"></i> <span class="cm-bulk-count">0</span> selected</span>
      <button class="btn btn-primary" onclick="openBulkAction()"><i class="fas fa-layer-group"></i> Bulk Action</button>
      <button class="btn btn-secondary" onclick="_clearCMSelection()"><i class="fas fa-times"></i> Exit Select</button>
    </div>

    <div class="table-scroll">
    <table style="border-collapse:collapse;min-width:720px;width:100%;font-size:.8rem">
      <thead>
        <tr style="background:#1e40af;color:#fff">
          <th class="cm-check-cell" style="padding:.4rem .3rem;min-width:28px">
            <input type="checkbox" id="cm-check-all" onchange="_toggleCMSelAll(this.checked)" title="Select all">
          </th>
          <th style="padding:.4rem .3rem;min-width:28px">#</th>
          <th style="padding:.4rem .6rem;text-align:left;min-width:140px">Name</th>
          <th style="min-width:80px;text-align:center">Contact</th>
          <th style="min-width:90px">Team</th>
          <th style="min-width:110px;padding:.4rem">Calling By</th>
          <th style="min-width:170px">This Week</th>
          ${histHdrs}
          <th style="text-align:center;min-width:48px" title="Lifetime Attendance">🕉️ AT</th>
          <th style="min-width:72px">Action</th>
        </tr>
      </thead>
      <tbody>${rows || '<tr><td colspan="99" style="text-align:center;padding:2rem;color:var(--text-muted)">No devotees match these filters</td></tr>'}</tbody>
    </table></div>
    <div style="margin-top:.5rem;font-size:.72rem;color:var(--text-muted)">
      <span style="background:#fffde7;color:#e65100;padding:.1rem .4rem;border-radius:3px">Yellow rows = not called this week</span>
    </div>`;

  _updateBulkBar();
}

function _cmSelectTeam(team, checked) {
  const boxes = document.querySelectorAll(`#cm-week-content input.cm-row-check[data-team="${team.replace(/"/g,'\\"')}"]`);
  boxes.forEach(b => { b.checked = checked; _toggleCMSel(b.dataset.id, checked); });
}

function _onCMTeamChange() {
  // Reset Calling By when Team changes — byOpts are regenerated on re-render.
  const by = document.getElementById('cm-filter-by');
  if (by) by.value = '';
  _renderCMWeek();
}

let _cmSearchTimer = null;
function _onCMSearch(_v) {
  clearTimeout(_cmSearchTimer);
  _cmSearchTimer = setTimeout(() => {
    _renderCMWeek();
    // Re-focus the regenerated input and place the caret at end so typing flows
    setTimeout(() => {
      const inp = document.getElementById('cm-filter-search');
      if (inp) {
        inp.removeAttribute('readonly');
        inp.focus();
        const n = inp.value.length;
        try { inp.setSelectionRange(n, n); } catch (_) {}
      }
    }, 0);
  }, 220);
}

function openTeamChangeQuick(devoteeId, devoteeName, currentTeam) {
  openMgmtAction(devoteeId, devoteeName);
  // Auto-expand the Change Team picker
  setTimeout(() => {
    const picker = document.getElementById('mgmt-team-picker');
    if (picker) picker.style.display = 'flex';
    const sel = document.getElementById('mgmt-new-team');
    if (sel && currentTeam) sel.value = currentTeam;
  }, 40);
}

async function openChangeCallingBy(devoteeId, devoteeName, team, currentCaller) {
  document.getElementById('cb-devotee-id').value   = devoteeId;
  document.getElementById('cb-devotee-team').value = team || '';
  document.getElementById('cb-devotee-name').textContent = devoteeName;
  document.getElementById('cb-team-display').textContent = team || '— Any —';
  const sel = document.getElementById('cb-user-select');
  sel.innerHTML = '<option value="">— Loading callers —</option>';
  openModal('change-callingby-modal');
  try {
    const users = await DB.getUsersForTeam(team || '');
    if (!users.length) {
      sel.innerHTML = `<option value="">— No callers in ${team || 'any team'} —</option>`;
      return;
    }
    sel.innerHTML = '<option value="">— Select caller —</option>' +
      users.map(u => {
        const pos = u.position || (u.role === 'teamAdmin' ? 'Coordinator' : 'Facilitator');
        const selected = (u.name === currentCaller) ? ' selected' : '';
        return `<option value="${(u.name||'').replace(/"/g,'&quot;')}"${selected}>${u.name} (${pos})</option>`;
      }).join('');
  } catch (e) {
    sel.innerHTML = '<option value="">— Failed to load —</option>';
  }
}

async function doSaveCallingBy() {
  const devoteeId = document.getElementById('cb-devotee-id').value;
  const newCaller = document.getElementById('cb-user-select').value;
  if (!devoteeId) return;
  if (!newCaller) { showToast('Please select a caller', 'error'); return; }
  try {
    await fdb.collection('devotees').doc(devoteeId).update({ callingBy: newCaller, updatedAt: TS() });
    await fdb.collection('profileChanges').add({
      devoteeId, fieldName: 'calling_by',
      newValue: newCaller, changedBy: AppState.userName, changedAt: TS()
    });
    DevoteeCache.bust();
    closeModal('change-callingby-modal');
    showToast('Calling By updated!', 'success');
    loadCallingMgmtTab?.();
  } catch (e) {
    showToast('Update failed: ' + (e.message || 'Error'), 'error');
  }
}

function _renderCMGrid() {
  const el = document.getElementById('cm-grid-content');
  if (!el) return;
  if (!_cmData) { el.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i></div>'; return; }
  const { devotees, weeks, gridData } = _cmData;
  const active = devotees.filter(d => d.isActive !== false && d.callingBy && !d.callingMode && !d.isNotInterested);
  if (!weeks.length) {
    el.innerHTML = `<div class="empty-state"><i class="fas fa-info-circle"></i>
      <p>No weeks saved yet. Configure calling dates and click Save Dates first.</p></div>`;
    return;
  }
  el.innerHTML = _buildMgmtGrid(gridData, active);
}

function _renderCMShifted() {
  const el = document.getElementById('cm-shifted-content');
  if (!el) return;
  if (!_cmData) { el.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i></div>'; return; }
  const { devotees } = _cmData;
  const lists = {
    online:        devotees.filter(d => d.callingMode === 'online'),
    festival:      devotees.filter(d => d.callingMode === 'festival'),
    notInterested: devotees.filter(d => d.callingMode === 'not_interested' || d.isNotInterested === true),
  };
  const html = _buildMgmtSeparateLists(lists);
  el.innerHTML = html || `<div class="empty-state"><i class="fas fa-check-circle" style="color:var(--success)"></i><p>No shifted devotees</p></div>`;
}

// ── NEW COMERS data: any devotee who joined for / attended the latest past
// session as new — covers two paths:
//   1. Registered via the Attendance FAB → has attendanceRecord.isNewDevotee
//   2. Added directly via Devotees tab with dateOfJoining === session date
async function _getNewComersForLatestSession() {
  const today = getToday();
  const sessSnap = await fdb.collection('sessions')
    .where('sessionDate', '<=', today)
    .orderBy('sessionDate', 'desc').limit(1).get();
  if (sessSnap.empty) return { sessionDate: null, sessionId: null, list: [] };
  const sess = sessSnap.docs[0];
  const sessionId   = sess.id;
  const sessionDate = sess.data().sessionDate;

  const [attSnap, all] = await Promise.all([
    fdb.collection('attendanceRecords')
      .where('sessionId', '==', sessionId)
      .where('isNewDevotee', '==', true).get(),
    DevoteeCache.all(),
  ]);

  const byId       = Object.fromEntries(all.map(d => [d.id, d]));
  const seen       = new Set();
  const list       = [];

  // 1) Attendance-flagged new devotees
  attSnap.docs.forEach(doc => {
    const a = doc.data();
    if (seen.has(a.devoteeId)) return;
    seen.add(a.devoteeId);
    const d = byId[a.devoteeId] || {};
    list.push({
      id:        a.devoteeId,
      name:      d.name || a.devoteeName || '—',
      mobile:    d.mobile || a.mobile || '',
      mobileAlt: d.mobileAlt || '',
      teamName:  d.teamName || a.teamName || '',
      callingBy: d.callingBy || a.callingBy || '',
      referenceBy:    d.referenceBy || '',
      chantingRounds: d.chantingRounds || 0,
      source: 'attended',
    });
  });

  // 2) Devotees whose dateOfJoining is the same session date — even if
  //    they were added directly to the database without being marked present
  all.forEach(d => {
    if (seen.has(d.id))                  return;
    if (d.isActive === false)            return;
    if (!d.dateOfJoining)                return;
    if (d.dateOfJoining !== sessionDate) return;
    seen.add(d.id);
    list.push({
      id:        d.id,
      name:      d.name || '—',
      mobile:    d.mobile || '',
      mobileAlt: d.mobileAlt || '',
      teamName:  d.teamName || '',
      callingBy: d.callingBy || '',
      referenceBy:    d.referenceBy || '',
      chantingRounds: d.chantingRounds || 0,
      source: 'joined',
    });
  });

  return { sessionDate, sessionId, list };
}

// ── CALLING MGMT — NEW COMERS sub-tab ──
async function _renderCMNewComers() {
  const el = document.getElementById('cm-newcomers-content');
  if (!el) return;
  el.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';
  try {
    const { sessionDate, list } = await _getNewComersForLatestSession();
    if (!sessionDate) {
      el.innerHTML = '<div class="empty-state"><i class="fas fa-user-plus"></i><p>No past session found yet.</p></div>';
      return;
    }
    if (!list.length) {
      el.innerHTML = `<div class="empty-state"><i class="fas fa-seedling"></i><p>No new devotees for ${formatDate(sessionDate)}.</p></div>`;
      return;
    }
    const rows = list.map((d, i) => {
      const safeName = (d.name || '—').replace(/'/g, "\\'");
      const safeTeam = (d.teamName || '').replace(/'/g, "\\'");
      const sourceTag = d.source === 'attended'
        ? '<span class="newcomer-tag tag-attended">Attended</span>'
        : '<span class="newcomer-tag tag-joined">Joined</span>';
      return `<tr>
        <td style="color:var(--text-muted);text-align:center">${i + 1}</td>
        <td>
          <button class="cm-link" onclick="openProfileModal('${d.id}')">${d.name}</button>
          ${d.mobile ? `<div style="font-size:.7rem;color:var(--text-muted)">${d.mobile}</div>` : ''}
        </td>
        <td>${sourceTag}</td>
        <td style="font-size:.78rem">${d.referenceBy || '—'}</td>
        <td style="padding:.3rem .4rem;white-space:nowrap">
          ${d.teamName
            ? `<button class="cm-team-btn" onclick="openTeamChangeQuick('${d.id}','${safeName}','${safeTeam}')" title="Change team">${teamBadge(d.teamName)}</button>
               <button class="cm-team-history-btn" onclick="showMgmtTeamHistory('${d.id}','${safeName}')" title="Past team history"><i class="fas fa-pencil-alt"></i></button>`
            : `<button class="btn btn-secondary" style="padding:.18rem .55rem;font-size:.72rem" onclick="openTeamChangeQuick('${d.id}','${safeName}','')"><i class="fas fa-users"></i> Assign Team</button>`
          }
        </td>
        <td>
          ${d.callingBy
            ? `<button class="cm-link cm-link-muted" onclick="openChangeCallingBy('${d.id}','${safeName}','${safeTeam}','${d.callingBy.replace(/'/g,"\\'")}')">${d.callingBy}</button>`
            : `<button class="btn btn-secondary" style="padding:.18rem .55rem;font-size:.72rem" onclick="openChangeCallingBy('${d.id}','${safeName}','${safeTeam}','')"><i class="fas fa-headset"></i> Assign Caller</button>`
          }
        </td>
        <td style="text-align:center">${d.chantingRounds || 0}</td>
        <td style="text-align:center">
          <button onclick="openMgmtAction('${d.id}','${safeName}')"
            style="font-size:.72rem;padding:.2rem .5rem;background:var(--accent-light);border:1px solid var(--border);border-radius:4px;cursor:pointer;color:var(--primary);font-weight:600;white-space:nowrap">
            <i class="fas fa-bolt"></i> Action
          </button>
        </td>
      </tr>`;
    }).join('');
    el.innerHTML = `
      <div style="font-size:.84rem;margin-bottom:.6rem;color:var(--text-muted)">
        <i class="fas fa-user-plus"></i> ${list.length} new devotee${list.length === 1 ? '' : 's'} for
        <strong style="color:var(--primary)">${formatDate(sessionDate)}</strong>
        <span style="margin-left:.5rem;font-size:.72rem;color:var(--text-light)">(joined or attended fresh)</span>
      </div>
      <div class="table-scroll">
        <table class="calling-table">
          <thead><tr>
            <th style="min-width:30px">#</th>
            <th style="min-width:160px">Name</th>
            <th style="min-width:80px">Source</th>
            <th style="min-width:120px">Reference</th>
            <th style="min-width:120px">Team</th>
            <th style="min-width:140px">Calling By</th>
            <th style="min-width:48px;text-align:center">C.R.</th>
            <th style="min-width:70px;text-align:center">Action</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } catch (e) {
    console.error('_renderCMNewComers', e);
    el.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load</p></div>';
  }
}

function _renderCMSingleList(type) {
  const el = document.getElementById(`cm-${type}-content`);
  if (!el) return;
  if (!_cmData) { el.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i></div>'; return; }
  const { devotees } = _cmData;
  let items, title, icon, bgColor;
  if (type === 'online') {
    items = devotees.filter(d => d.callingMode === 'online');
    title = 'Online Class'; icon = 'fas fa-laptop'; bgColor = '#1565c0';
  } else if (type === 'festival') {
    items = devotees.filter(d => d.callingMode === 'festival');
    title = 'Festival Calling'; icon = 'fas fa-star'; bgColor = '#e65100';
  } else {
    items = devotees.filter(d => d.callingMode === 'not_interested' || d.isNotInterested === true);
    title = 'Not Interested'; icon = 'fas fa-ban'; bgColor = '#b71c1c';
  }
  if (!items.length) {
    el.innerHTML = `<div class="empty-state"><i class="${icon}"></i><p>No devotees in ${title}</p></div>`;
    return;
  }
  // Bulk permanent-delete is offered ONLY on the Not Interested list, and only
  // to super admins (it's a hard delete — irreversible).
  const canDelete = (type === 'notinterested') && AppState.userRole === 'superAdmin';
  if (canDelete) _niSelected.clear();

  const rows = items.map((d, i) => `<tr style="font-size:.82rem">
    ${canDelete ? `<td style="text-align:center"><input type="checkbox" class="ni-check" data-id="${d.id}" onchange="_niToggle('${d.id}', this.checked)"></td>` : ''}
    <td style="color:var(--text-muted);text-align:center">${i + 1}</td>
    <td style="font-weight:600">${d.name || ''}</td>
    <td style="font-size:.75rem">${d.mobile || '—'}</td>
    <td style="white-space:nowrap">
      ${teamBadge(d.teamName)}
      <button onclick="showMgmtTeamHistory('${d.id}','${(d.name||'').replace(/'/g,"\\'")}')" title="Team change history"
        style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:.72rem;padding:.1rem .25rem;vertical-align:middle;opacity:.7">
        <i class="fas fa-pencil-alt"></i>
      </button>
    </td>
    <td style="font-size:.75rem;color:var(--text-muted)">${d.callingBy || '—'}</td>
    <td>
      <button onclick="openMgmtAction('${d.id}','${(d.name||'').replace(/'/g,"\\'")}')"
        style="font-size:.72rem;padding:.15rem .45rem;background:var(--accent-light);border:1px solid var(--border);border-radius:4px;cursor:pointer;color:var(--primary);margin-right:.3rem">
        <i class="fas fa-bolt"></i> Action
      </button>
      <button onclick="restoreMgmtDevotee('${d.id}')"
        style="font-size:.72rem;padding:.15rem .45rem;background:#e8f5e9;border:1px solid var(--secondary);border-radius:4px;cursor:pointer;color:var(--primary)">
        <i class="fas fa-undo"></i> Restore
      </button>
    </td>
  </tr>`).join('');

  const deleteBar = canDelete ? `
    <div id="ni-bulk-bar" style="display:none;align-items:center;gap:.6rem;flex-wrap:wrap;background:#fff5f5;border:1px solid #f3c2c2;border-radius:var(--radius-xs);padding:.5rem .7rem;margin-bottom:.6rem">
      <span style="font-weight:700;color:#b71c1c"><i class="fas fa-check-square"></i> <span id="ni-bulk-count">0</span> selected</span>
      <button class="btn btn-danger" style="font-size:.78rem" onclick="_niDeleteSelected()"><i class="fas fa-trash"></i> Delete Permanently</button>
      <button class="btn btn-secondary" style="font-size:.78rem" onclick="_niClear()"><i class="fas fa-times"></i> Clear</button>
    </div>` : '';

  el.innerHTML = `<div class="sr-team-block">
    <div class="sr-team-banner" style="background:${bgColor};color:#fff">
      <i class="${icon}"></i> ${title}
      <span style="font-size:.8rem;font-weight:400;opacity:.85"> (${items.length})</span>
    </div>
    ${canDelete ? `<div style="font-size:.74rem;color:var(--text-muted);margin:.5rem 0 .35rem"><i class="fas fa-info-circle"></i> Tick devotees and use <strong>Delete Permanently</strong> to remove them from the app for good (irreversible).</div>` : ''}
    ${deleteBar}
    <table class="calling-table sr-table" style="margin:0">
      <thead><tr>${canDelete ? '<th style="width:30px;text-align:center"><input type="checkbox" onchange="_niToggleAll(this.checked)" title="Select all"></th>' : ''}<th>#</th><th>Name</th><th>Mobile</th><th>Team</th><th>Calling By</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
  if (canDelete) _niSyncBar();
}

// ── Not-Interested bulk permanent delete (super-admin only) ──────────────
let _niSelected = new Set();
function _niToggle(id, checked) { if (checked) _niSelected.add(id); else _niSelected.delete(id); _niSyncBar(); }
function _niToggleAll(checked) {
  document.querySelectorAll('#cm-notinterested-content input.ni-check').forEach(b => {
    b.checked = checked;
    if (checked) _niSelected.add(b.dataset.id); else _niSelected.delete(b.dataset.id);
  });
  _niSyncBar();
}
function _niClear() {
  _niSelected.clear();
  document.querySelectorAll('#cm-notinterested-content input[type="checkbox"]').forEach(b => b.checked = false);
  _niSyncBar();
}
function _niSyncBar() {
  const bar = document.getElementById('ni-bulk-bar');
  if (bar) bar.style.display = _niSelected.size ? 'flex' : 'none';
  const c = document.getElementById('ni-bulk-count');
  if (c) c.textContent = _niSelected.size;
}
async function _niDeleteSelected() {
  if (AppState.userRole !== 'superAdmin') { showToast('Only Super Admin can delete permanently', 'error'); return; }
  const ids = [..._niSelected];
  if (!ids.length) { showToast('Select at least one devotee', 'error'); return; }
  if (!confirm(`Permanently DELETE ${ids.length} devotee(s) from the app?\n\nThis removes their profiles entirely and CANNOT be undone.`)) return;
  if (!confirm('Are you absolutely sure? This is permanent and irreversible.')) return;
  try {
    const n = await DB.hardDeleteDevotees(ids);
    _niSelected.clear();
    _bustCMCache?.();
    showToast(`${n} devotee(s) deleted permanently`, 'success');
    loadCallingMgmtTab();
  } catch (e) {
    showToast('Delete failed: ' + (e.message || 'Error'), 'error');
  }
}
window._niToggle = _niToggle;
window._niToggleAll = _niToggleAll;
window._niClear = _niClear;
window._niDeleteSelected = _niDeleteSelected;

// ── BULK ACTIONS (Calling Mgmt) ───────────────────────
function openBulkAction() {
  if (!_cmSelected.size) { showToast('Select at least one devotee', 'error'); return; }
  document.getElementById('bulk-count').textContent  = _cmSelected.size;
  document.getElementById('bulk-action-type').value  = '';
  document.getElementById('bulk-team-wrap').style.display       = 'none';
  document.getElementById('bulk-callingby-wrap').style.display  = 'none';
  document.getElementById('bulk-confirm-msg').style.display     = 'none';
  openModal('bulk-action-modal');
}

async function _onBulkActionTypeChange() {
  const t = document.getElementById('bulk-action-type').value;
  const teamWrap = document.getElementById('bulk-team-wrap');
  const byWrap   = document.getElementById('bulk-callingby-wrap');
  const msg      = document.getElementById('bulk-confirm-msg');
  teamWrap.style.display = (t === 'team') ? 'flex' : 'none';
  byWrap.style.display   = (t === 'callingby') ? 'flex' : 'none';
  msg.style.display      = 'none';
  if (t === 'online' || t === 'festival' || t === 'not_interested' || t === 'restore') {
    const lbl = { online:'Shift to Online Class', festival:'Shift to Festival Calling',
                  not_interested:'Mark Not Interested', restore:'Restore to Regular' }[t];
    msg.textContent = `This will ${lbl.toLowerCase()} for all ${_cmSelected.size} selected devotees.`;
    msg.style.display = 'block';
  }
  if (t === 'callingby') {
    const sel = document.getElementById('bulk-callingby');
    sel.innerHTML = '<option value="">— Loading —</option>';
    try {
      const users = await DB.getUsersForTeam('');
      sel.innerHTML = '<option value="">— Select caller —</option>' +
        users.map(u => {
          const pos = u.position || (u.role === 'teamAdmin' ? 'Coordinator' : 'Facilitator');
          const team = u.teamName ? ` · ${u.teamName}` : '';
          return `<option value="${(u.name||'').replace(/"/g,'&quot;')}">${u.name} (${pos}${team})</option>`;
        }).join('');
    } catch (_) { sel.innerHTML = '<option value="">— Failed to load —</option>'; }
  }
}

async function doBulkApply() {
  const t  = document.getElementById('bulk-action-type').value;
  const ids = [...(_cmSelected || [])];
  if (!t)       { showToast('Choose an action', 'error'); return; }
  if (!ids.length) { showToast('No devotees selected', 'error'); return; }

  try {
    if (t === 'team') {
      const newTeam = document.getElementById('bulk-team').value;
      if (!newTeam) { showToast('Select a team', 'error'); return; }
      const batch = fdb.batch();
      ids.forEach(id => {
        batch.update(fdb.collection('devotees').doc(id), { teamName: newTeam, updatedAt: TS() });
        const ref = fdb.collection('profileChanges').doc();
        batch.set(ref, { devoteeId: id, fieldName: 'team_name', newValue: newTeam, changedBy: AppState.userName, changedAt: TS() });
      });
      await batch.commit();
    } else if (t === 'callingby') {
      const newCaller = document.getElementById('bulk-callingby').value;
      if (!newCaller) { showToast('Select a caller', 'error'); return; }
      const batch = fdb.batch();
      ids.forEach(id => {
        batch.update(fdb.collection('devotees').doc(id), { callingBy: newCaller, updatedAt: TS() });
        const ref = fdb.collection('profileChanges').doc();
        batch.set(ref, { devoteeId: id, fieldName: 'calling_by', newValue: newCaller, changedBy: AppState.userName, changedAt: TS() });
      });
      await batch.commit();
    } else if (t === 'restore') {
      const batch = fdb.batch();
      ids.forEach(id => batch.update(fdb.collection('devotees').doc(id),
        { callingMode: '', isNotInterested: false, updatedAt: TS() }));
      await batch.commit();
    } else {
      // online / festival / not_interested — write one-by-one (each records profileChanges)
      for (const id of ids) {
        // eslint-disable-next-line no-await-in-loop
        await DB.setDevoteeCallingMode(id, t);
      }
    }
    DevoteeCache.bust();
    closeModal('bulk-action-modal');
    showToast(`Applied to ${ids.length} devotees!`, 'success');
    _cmSelected.clear();
    loadCallingMgmtTab?.();
  } catch (e) {
    console.error(e);
    showToast('Bulk action failed: ' + (e.message || 'Error'), 'error');
  }
}

// ══ TARGET MANAGEMENT ═══════════════════════════════════

async function openTargetMgmt() {
  openModal('target-mgmt-modal');
  await _loadTargetMgmtBody();
}

async function _loadTargetMgmtBody() {
  const body = document.getElementById('target-mgmt-body');
  body.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';
  try {
    const [cfg, devotees] = await Promise.all([
      DB.getAttendanceTargets(),
      DevoteeCache.all(),
    ]);
    const type = cfg.type || 'class';
    const saved = cfg.teams || {};

    // Count active callable members per team for placeholder hints
    const memberCount = {};
    TEAMS.forEach(t => {
      memberCount[t] = devotees.filter(d =>
        d.teamName === t && d.isActive !== false && !d.isNotInterested
        && d.callingMode !== 'not_interested' && d.callingMode !== 'online'
      ).length;
    });

    const globalVal = cfg.global > 0 ? cfg.global : '';
    body.innerHTML = `
      <div style="margin-bottom:1rem">
        <p style="font-size:.82rem;color:var(--text-muted);margin-bottom:.75rem">
          Set the attendance target for each team. The dashboard uses this as the denominator for the <strong>%</strong> column.
        </p>
        <div style="display:flex;gap:1rem;margin-bottom:1.25rem;flex-wrap:wrap">
          <label style="display:flex;align-items:center;gap:.4rem;cursor:pointer;font-size:.88rem">
            <input type="radio" name="target-type" value="class" ${type === 'class' ? 'checked' : ''}> Class Target
            <span style="font-size:.75rem;color:var(--text-muted)">(per session)</span>
          </label>
          <label style="display:flex;align-items:center;gap:.4rem;cursor:pointer;font-size:.88rem">
            <input type="radio" name="target-type" value="monthly" ${type === 'monthly' ? 'checked' : ''}> Monthly Target
          </label>
        </div>
        <div style="display:flex;align-items:center;gap:.6rem;padding:.6rem .75rem;background:var(--color-bg-subtle,#f5f7f5);border-radius:var(--radius-sm);margin-bottom:.75rem">
          <label style="font-size:.85rem;font-weight:600;white-space:nowrap">Default for all teams:</label>
          <input type="number" id="tgt-global" value="${globalVal}" placeholder="e.g. 11" min="0" max="9999"
            style="width:80px;text-align:center;padding:.3rem .5rem;border:1px solid var(--color-border);border-radius:var(--radius-xs);font-size:.88rem">
          <button type="button" onclick="_applyGlobalTarget()"
            style="padding:.3rem .75rem;font-size:.82rem;background:var(--color-primary);color:#fff;border:none;border-radius:var(--radius-xs);cursor:pointer">
            Apply to all
          </button>
          <span style="font-size:.75rem;color:var(--text-muted)">Used when a team has no specific target</span>
        </div>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:.88rem">
        <thead>
          <tr>
            <th style="text-align:left;padding:.4rem .5rem;border-bottom:1px solid var(--color-border);color:var(--text-muted);font-weight:600">Team</th>
            <th style="text-align:center;padding:.4rem .5rem;border-bottom:1px solid var(--color-border);color:var(--text-muted);font-weight:600">Members</th>
            <th style="text-align:center;padding:.4rem .5rem;border-bottom:1px solid var(--color-border);color:var(--text-muted);font-weight:600">Target</th>
          </tr>
        </thead>
        <tbody>
          ${TEAMS.map(team => `
            <tr>
              <td style="padding:.45rem .5rem;font-weight:500">${team}</td>
              <td style="text-align:center;padding:.45rem .5rem;color:var(--text-muted)">${memberCount[team] || 0}</td>
              <td style="text-align:center;padding:.45rem .5rem">
                <input type="number" id="tgt-${team.replace(/\s+/g,'_')}"
                  value="${saved[team] ?? ''}"
                  placeholder="${memberCount[team] || ''}"
                  min="0" max="999"
                  style="width:70px;text-align:center;padding:.3rem .4rem;border:1px solid var(--color-border);border-radius:var(--radius-xs);font-size:.88rem">
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <p style="font-size:.75rem;color:var(--text-muted);margin-top:.75rem">
        Leave blank to use the default target (or member count if no default).
      </p>`;
  } catch (e) {
    document.getElementById('target-mgmt-body').innerHTML =
      '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load targets</p></div>';
  }
}

function _applyGlobalTarget() {
  const g = parseInt(document.getElementById('tgt-global')?.value, 10);
  if (!g || g <= 0) return;
  TEAMS.forEach(team => {
    const input = document.getElementById('tgt-' + team.replace(/\s+/g, '_'));
    if (input) input.value = g;
  });
}

// ══ MONTHLY REPORTS ══════════════════════════════════

function openMonthlyReports() {
  const el = document.getElementById('monthly-report-month');
  if (el && !el.value) {
    const now = new Date();
    el.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }
  openModal('monthly-reports-modal');
}

function openFYReports() {
  const sel = document.getElementById('fy-report-year');
  if (sel && !sel.options.length) {
    const now = new Date();
    const currentFY = (now.getMonth() + 1) >= 4 ? now.getFullYear() : now.getFullYear() - 1;
    for (let y = currentFY; y >= currentFY - 4; y--) {
      const opt = document.createElement('option');
      opt.value = y;
      opt.textContent = `FY ${y}–${String(y + 1).slice(-2)}  (Apr ${y} – Mar ${y + 1})`;
      sel.appendChild(opt);
    }
  }
  openModal('fy-reports-modal');
}

async function saveTargetMgmt() {
  const typeEl = document.querySelector('input[name="target-type"]:checked');
  if (!typeEl) return;
  const type = typeEl.value;
  const globalVal = parseInt(document.getElementById('tgt-global')?.value, 10);
  const global = (!isNaN(globalVal) && globalVal > 0) ? globalVal : 0;
  const teams = {};
  TEAMS.forEach(team => {
    const input = document.getElementById('tgt-' + team.replace(/\s+/g, '_'));
    const val = input ? parseInt(input.value, 10) : NaN;
    if (!isNaN(val) && val > 0) teams[team] = val;
  });
  try {
    await DB.setAttendanceTargets(type, teams, global);
    showToast('Targets saved!', 'success');
    closeModal('target-mgmt-modal');
    loadDashboard();
  } catch (e) {
    showToast('Failed to save: ' + (e.message || 'Error'), 'error');
  }
}

// ══ LATE COMERS REPORT ════════════════════════════════════════
// Lists devotees who arrived AFTER 12:45 PM for the selected session.
// Yellow rows = 12:45–13:00, Red rows = after 13:00.
// Filter chips: All Present / On Time / Late / Very Late.

let _lateFilter = 'all_late'; // 'all_late' | 'verylate' | 'late' | 'all'
let _lateDataCache = null;    // last fetched present devotees with timestamps

async function loadLateComersReport() {
  const wrap = document.getElementById('late-comers-content');
  if (!wrap) return;
  _lateFilter = 'all_late'; // always reset to "All Late" on fresh load
  wrap.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';

  try {
    const sessionDate = (typeof getFilterSessionId === 'function') ? getFilterSessionId() : null;
    let sessionId = AppState._currentSessionId || null;

    if (!sessionId && sessionDate) {
      const snap = await fdb.collection('sessions').where('sessionDate', '==', sessionDate).limit(1).get();
      if (!snap.empty) sessionId = snap.docs[0].id;
    }
    if (!sessionId) {
      wrap.innerHTML = '<div class="empty-state"><i class="fas fa-info-circle"></i><p>No session selected. Pick a session from the Session filter at the top.</p></div>';
      return;
    }

    // Reuse the existing "session attendance with timestamps" DB call
    const records = await DB.getSessionAttendance(sessionId);

    const teamFilter = (typeof getFilterTeam === 'function') ? getFilterTeam() : '';
    const filtered = teamFilter ? records.filter(r => r.team_name === teamFilter) : records;

    _lateDataCache = filtered;
    _renderLateComers();
  } catch (e) {
    console.error('loadLateComersReport', e);
    wrap.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load: ' + (e.message || 'Error') + '</p></div>';
  }
}

function _bucketByLateness(records) {
  // Returns indexes by bucket.
  const out = { ontime: [], late: [], verylate: [] };
  records.forEach(r => {
    if (!r.marked_at) { out.ontime.push(r); return; }
    const d = new Date(r.marked_at);
    const mins = d.getHours() * 60 + d.getMinutes();
    if (mins >= 13 * 60) out.verylate.push(r);
    else if (mins >= 12 * 60 + 45) out.late.push(r);
    else out.ontime.push(r);
  });
  return out;
}

function setLateFilter(key) {
  _lateFilter = key;
  _renderLateComers();
}

function _renderLateComers() {
  const wrap = document.getElementById('late-comers-content');
  if (!wrap || !_lateDataCache) return;
  const all = _lateDataCache;
  const buckets = _bucketByLateness(all);

  const allLateCount = buckets.verylate.length + buckets.late.length;
  const chips = [
    { key: 'all_late', label: 'All Late',            count: allLateCount,              color: '#b91c1c' },
    { key: 'verylate', label: 'Very Late (after 1:00)', count: buckets.verylate.length, color: '#dc2626' },
    { key: 'late',     label: 'Late (12:45–1:00)',   count: buckets.late.length,       color: '#ea580c' },
    { key: 'all',      label: 'All Present',          count: all.length,                color: '#1E40AF' },
  ];
  const chipsHtml = chips.map(c => {
    const active = c.key === _lateFilter;
    return `<button onclick="setLateFilter('${c.key}')"
      style="border:1px solid ${active ? c.color : 'var(--color-border)'};
             background:${active ? c.color : '#fff'};
             color:${active ? '#fff' : c.color};
             padding:.25rem .7rem;border-radius:9999px;font-size:.78rem;font-weight:600;cursor:pointer">
      ${c.label} <span style="opacity:.85;font-weight:700">${c.count}</span>
    </button>`;
  }).join(' ');

  // Build row list based on filter; most late always at top
  let rows;
  if      (_lateFilter === 'all_late') rows = [...buckets.verylate, ...buckets.late];
  else if (_lateFilter === 'verylate') rows = [...buckets.verylate];
  else if (_lateFilter === 'late')     rows = [...buckets.late];
  else                                 rows = [...buckets.verylate, ...buckets.late, ...buckets.ontime];
  rows.sort((a, b) => (b.marked_at || '').localeCompare(a.marked_at || ''));

  const fmtTime = iso => {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  };

  const rowBg = r => {
    if (!r.marked_at) return '';
    const d = new Date(r.marked_at), mins = d.getHours() * 60 + d.getMinutes();
    if (mins >= 13 * 60)       return 'background:#fff0f0';   // very late — light red
    if (mins >= 12 * 60 + 45) return 'background:#fff8ee';   // late — light orange
    return '';
  };

  const timeBadge = r => {
    if (!r.marked_at) return '<span style="color:#6b7280">—</span>';
    const d = new Date(r.marked_at), mins = d.getHours() * 60 + d.getMinutes();
    const t = fmtTime(r.marked_at);
    if (mins >= 13 * 60)
      return `<span style="background:#fecaca;color:#b91c1c;padding:.1rem .45rem;border-radius:9999px;font-weight:800;font-size:.78rem;white-space:nowrap">${t}</span>`;
    if (mins >= 12 * 60 + 45)
      return `<span style="background:#fed7aa;color:#c2410c;padding:.1rem .45rem;border-radius:9999px;font-weight:700;font-size:.78rem;white-space:nowrap">${t}</span>`;
    return `<span style="color:#16a34a;font-weight:600;font-size:.78rem">${t}</span>`;
  };

  const th = s => `<th style="padding:.45rem .55rem;border:1.5px solid #000;font-weight:800;background:#1e40af;color:#fff;white-space:nowrap;${s||''}">`;
  const tableHtml = !rows.length
    ? '<div class="empty-state"><i class="fas fa-check-circle" style="color:#16a34a"></i><p>No one is late in this session</p></div>'
    : `<div class="table-scroll">
        <table style="width:100%;border-collapse:collapse;font-size:.82rem;border:2px solid #000">
          <thead style="position:sticky;top:0;z-index:2">
            <tr>
              ${th('text-align:center;width:2rem')}#</th>
              ${th('text-align:left')}Name</th>
              ${th('text-align:left')}Mobile</th>
              ${th('text-align:left;min-width:110px')}Team</th>
              ${th('text-align:center')}Time</th>
            </tr>
          </thead>
          <tbody>
          ${rows.map((r, i) => `
            <tr style="${rowBg(r)}">
              <td style="padding:.4rem .55rem;text-align:center;color:#6b7280;font-size:.75rem;border:1px solid #d1d5db">${i + 1}</td>
              <td style="padding:.4rem .55rem;font-weight:700;color:#1a1a1a;cursor:pointer;border:1px solid #d1d5db"
                  onclick="openProfileModal('${r.devotee_id || ''}')">${r.name || '—'}</td>
              <td style="padding:.4rem .55rem;color:#374151;border:1px solid #d1d5db">${r.mobile || '—'}</td>
              <td style="padding:.4rem .55rem;color:#374151;white-space:nowrap;border:1px solid #d1d5db">${r.team_name || '—'}</td>
              <td style="padding:.4rem .55rem;text-align:center;border:1px solid #d1d5db">${timeBadge(r)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

  wrap.innerHTML = `
    <div style="display:flex;flex-wrap:wrap;gap:.4rem;margin-bottom:.75rem">
      ${chipsHtml}
    </div>
    ${tableHtml}
  `;
}

// ══ PERSONAL MEETINGS ══════════════════════════════════════════
// Track meetings between devotees and senior Prabhujis. 30-day threshold:
// any active devotee not met in 30+ days appears in Overdue.

let _meetingsCache = null;       // last fetched meetings
let _meetingsDevoteesCache = null;
let _editingMeetingDevotee = null; // selected devotee object during form
let _overdueListCache = null;     // computed overdue list (with last-met info)
let _overdueFilter = 'all';       // 'all' | 'Most Serious' | 'Serious' | 'Expected to be Serious' | 'New Devotee' | 'Inactive'
let _pmRenderState = { upcoming: [], recent: [] };

// LEGACY entry point — kept so the old sidebar/admin shortcuts keep working.
// Now redirects to the main Meetings tab instead of opening the modal.
async function openPersonalMeetings() {
  closeSidebar?.();
  const btn = document.querySelector('.tab-btn[data-tab="meetings"]');
  if (typeof switchTab === 'function') switchTab('meetings', btn);
  else loadMeetingsTab();
}

// ── MEETINGS TAB ─────────────────────────────────────────────
// State for the Meetings tab. Sub-tab + status-filter + cached data.
let _meetActiveSubTab = 'overdue';   // overdue | scheduled | completed | recent
let _meetStatusFilter = 'all';        // all | Most Serious | Serious | ETS | New Devotee | Inactive

function switchMeetingsSubTab(btn, sub) {
  _meetActiveSubTab = sub;
  document.querySelectorAll('.meet-sub-panel').forEach(p => p.classList.add('hidden'));
  document.getElementById('meet-panel-' + sub)?.classList.remove('hidden');
  const labels = { overdue:'Overdue', scheduled:'Scheduled', completed:'Completed', recent:'Recently Met', ptm:'PTM', 'my-log':'My Log' };
  const lbl = document.getElementById('meet-active-label');
  if (lbl) lbl.textContent = labels[sub] || '';

  if (sub === 'ptm')    { _loadPTMTab();   return; }
  if (sub === 'my-log') { _loadMyLogTab(); return; }
  _renderMeetingsTabContent();
}
window.switchMeetingsSubTab = switchMeetingsSubTab;

function setMeetStatusFilter(key) {
  _meetStatusFilter = key;
  document.querySelectorAll('#meet-status-chips .ds-chip').forEach(c => c.classList.remove('ds-chip--active'));
  document.querySelector(`#meet-status-chips .ds-chip[data-status="${key}"]`)?.classList.add('ds-chip--active');
  _renderMeetingsTabContent();
}
window.setMeetStatusFilter = setMeetStatusFilter;

async function loadMeetingsTab() {
  await _loadPersonalMeetings();   // reuse existing data fetch — populates _overdueListCache + _pmRenderState
  _renderMeetingsTabContent();
}
window.loadMeetingsTab = loadMeetingsTab;

// ── INTERACTION LEVELS ────────────────────────────────────────────────────────
const INTERACTION_LEVELS = {
  1: { name: 'HG Ram Atirapriya Prabhuji', abbr: 'Prabhuji (L1)', color: '#7c3aed', bg: '#f5f3ff' },
  2: { name: 'HG Sulakshana Sita Mataji',  abbr: 'Mataji (L2)',   color: '#0369a1', bg: '#eff6ff' },
  3: { name: 'Naveena (Senior)',            abbr: 'Senior (L3)',   color: '#0f766e', bg: '#f0fdfa' },
  4: { name: 'Team Coordinator',           abbr: 'Coordinator (L4)', color: '#0d2d5a', bg: '#eef3fb' },
};
window.INTERACTION_LEVELS = INTERACTION_LEVELS;

const TYPE_LABELS = { call: '📞 Call', meet: '🤝 Meet', 'parent-meet': '👨‍👩 Parent Meet' };

// ── PTM TAB ───────────────────────────────────────────────────────────────────
async function _loadPTMTab() {
  const el = document.getElementById('meet-panel-ptm');
  if (!el) return;
  el.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';
  try {
    const all = await DevoteeCache.all();
    const team = (typeof getFilterTeam === 'function') ? getFilterTeam() : '';
    const pool = team ? all.filter(d => d.teamName === team) : all;
    const active = pool.filter(d => d.isActive !== false && !d.isNotInterested);

    // Section A: family members already attending
    const secA = active.filter(d =>
      (parseInt(d.familyParticipants) > 0) ||
      (d.familyFavourable?.toLowerCase().includes('attend'))
    );
    const secAIds = new Set(secA.map(d => d.id));

    // Section B: senior has met the devotee's PARENTS (parent-meet interaction exists)
    //            and family is NOT already attending (not in Section A)
    // Fetch parent-meet interactions to find which devotees have had a parent meeting logged
    const pmSnap = await fdb.collection('interactions')
      .where('type', '==', 'parent-meet').get().catch(() => ({ docs: [] }));
    const parentMetIds = new Set(pmSnap.docs.map(d => d.data().devoteeId).filter(Boolean));
    const secB = active.filter(d => parentMetIds.has(d.id) && !secAIds.has(d.id));

    const renderRow = (d, i) => `
      <tr>
        <td style="padding:.35rem .5rem;color:#94a3b8;font-size:.75rem;text-align:center">${i+1}</td>
        <td style="padding:.35rem .55rem;font-weight:700;color:#0d2d5a;cursor:pointer"
            onclick="openInteractionHistory('${d.id}','${(d.name||'').replace(/'/g,"\\'")}','${d.teamName||''}')">${d.name || '—'}</td>
        <td style="padding:.35rem .55rem;font-size:.8rem;color:#374151">${d.mobile || '—'}</td>
        <td style="padding:.35rem .55rem;font-size:.78rem;color:#374151">${d.teamName || '—'}</td>
        <td style="padding:.35rem .55rem;font-size:.75rem;color:#64748b">${d.familyMembers || 0} members</td>
      </tr>`;

    const TH = `style="padding:.4rem .5rem;background:#0d2d5a;color:#fff;font-weight:700;font-size:.78rem;white-space:nowrap"`;
    const tableHtml = rows => `
      <div class="table-scroll" style="margin-bottom:1.2rem">
        <table style="width:100%;border-collapse:collapse;border:2px solid #000;font-size:.82rem">
          <thead><tr>
            <th ${TH} style="text-align:center;width:2rem">#</th>
            <th ${TH}>Name</th><th ${TH}>Mobile</th><th ${TH}>Team</th><th ${TH}>Family</th>
          </tr></thead>
          <tbody>${rows.map((d,i) => renderRow(d,i)).join('')}</tbody>
        </table>
      </div>`;

    el.innerHTML = `
      <div style="margin-bottom:.75rem;display:flex;justify-content:flex-end">
        <button class="btn btn-primary btn-sm" onclick="openLogInteractionModal()">
          <i class="fas fa-plus"></i> Log Interaction
        </button>
      </div>
      <div style="margin-bottom:1rem">
        <div class="panel-header" style="margin-bottom:.5rem">
          <h2 style="font-size:.9rem"><i class="fas fa-users"></i> Section A — Family Members Attending (${secA.length})</h2>
        </div>
        ${secA.length ? tableHtml(secA) : '<p style="color:#94a3b8;font-size:.82rem;padding:.5rem 0">No devotees in this category</p>'}
      </div>
      <div>
        <div class="panel-header" style="margin-bottom:.5rem">
          <h2 style="font-size:.9rem"><i class="fas fa-handshake"></i> Section B — Parents Met by Senior (${secB.length})</h2>
        </div>
        ${!secB.length ? `<p style="color:#94a3b8;font-size:.82rem;padding:.3rem 0">No parent-meet interactions logged yet. Use <strong>Log Interaction</strong> → type "Parent Meet" to record when a senior meets a devotee's parents.</p>` : ''}
        ${secB.length ? tableHtml(secB) : '<p style="color:#94a3b8;font-size:.82rem;padding:.5rem 0">No devotees in this category</p>'}
      </div>`;
  } catch (e) {
    el.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load PTM data</p></div>';
    console.error('_loadPTMTab', e);
  }
}

// ── MY LOG TAB ─────────────────────────────────────────────────────────────────
async function _loadMyLogTab() {
  const el = document.getElementById('meet-panel-my-log');
  if (!el) return;
  el.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';
  try {
    const [myInteractions, allDevotees] = await Promise.all([
      DB.getMyInteractions(AppState.userId),
      DevoteeCache.all(),
    ]);
    const byDevotee = {};
    myInteractions.forEach(ix => {
      if (!byDevotee[ix.devoteeId]) byDevotee[ix.devoteeId] = { name: ix.devoteeName, team: ix.teamName, interactions: [] };
      byDevotee[ix.devoteeId].interactions.push(ix);
    });

    const entries = Object.entries(byDevotee).sort((a, b) => {
      const aLast = a[1].interactions[0]?.atClient || '';
      const bLast = b[1].interactions[0]?.atClient || '';
      return bLast.localeCompare(aLast);
    });

    if (!entries.length) {
      el.innerHTML = `
        <div style="text-align:center;padding:2rem">
          <div style="font-size:2.5rem;margin-bottom:.5rem">📋</div>
          <p style="color:#64748b;font-size:.9rem">No interactions logged yet.<br>Use "Log Interaction" to track your calls and meetings.</p>
          <button class="btn btn-primary" style="margin-top:1rem" onclick="openLogInteractionModal()">
            <i class="fas fa-plus"></i> Log First Interaction
          </button>
        </div>`;
      return;
    }

    const fmt = iso => iso ? new Date(iso).toLocaleString('en-IN', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit', hour12:true }) : '—';
    const levelPill = lv => {
      const l = INTERACTION_LEVELS[lv] || INTERACTION_LEVELS[4];
      return `<span style="background:${l.bg};color:${l.color};font-size:.65rem;font-weight:700;padding:.1rem .35rem;border-radius:4px">${l.abbr}</span>`;
    };

    el.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem">
        <span style="font-size:.82rem;color:#64748b"><strong>${entries.length}</strong> devotees · <strong>${myInteractions.length}</strong> total interactions</span>
        <button class="btn btn-primary btn-sm" onclick="openLogInteractionModal()">
          <i class="fas fa-plus"></i> Log
        </button>
      </div>
      ${entries.map(([devId, info]) => `
        <div style="background:#fff;border:1.5px solid #e2e8f0;border-radius:10px;padding:.7rem .9rem;margin-bottom:.6rem">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.45rem">
            <div>
              <span style="font-weight:700;color:#0d2d5a;cursor:pointer;font-size:.9rem"
                    onclick="openInteractionHistory('${devId}','${(info.name||'').replace(/'/g,"\\'")}','${info.team||''}')">${info.name}</span>
              <span style="font-size:.72rem;color:#94a3b8;margin-left:.4rem">${info.team || ''}</span>
            </div>
            <span style="font-size:.7rem;color:#94a3b8">${info.interactions.length} interactions</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:.3rem">
            ${info.interactions.slice(0,3).map(ix => `
              <div style="display:flex;align-items:center;gap:.4rem;font-size:.76rem;color:#374151">
                ${levelPill(ix.level)}
                <span style="font-weight:600">${TYPE_LABELS[ix.type] || ix.type}</span>
                <span style="color:#94a3b8;margin-left:auto">${fmt(ix.atClient)}</span>
              </div>`).join('')}
            ${info.interactions.length > 3 ? `<div style="font-size:.72rem;color:#94a3b8;text-align:right">+${info.interactions.length-3} more</div>` : ''}
          </div>
        </div>`).join('')}`;
  } catch (e) {
    el.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load</p></div>';
    console.error('_loadMyLogTab', e);
  }
}

// ── INTERACTION HISTORY MODAL (deep-dive) ─────────────────────────────────────
async function openInteractionHistory(devoteeId, devoteeName, teamName) {
  const modal = document.getElementById('interaction-history-modal');
  const body  = document.getElementById('ih-body');
  document.getElementById('ih-title').innerHTML = `<i class="fas fa-chart-bar"></i> ${devoteeName}`;
  body.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';
  modal.classList.remove('hidden');
  try {
    const interactions = await DB.getDevoteeInteractions(devoteeId);

    // Matrix: level × type counts
    const matrix = {};
    [1,2,3,4].forEach(l => { matrix[l] = { call:0, meet:0, 'parent-meet':0 }; });
    interactions.forEach(ix => { if (matrix[ix.level]) matrix[ix.level][ix.type] = (matrix[ix.level][ix.type]||0) + 1; });

    const levelPill = lv => {
      const l = INTERACTION_LEVELS[lv];
      return `<span style="background:${l.bg};color:${l.color};font-size:.65rem;font-weight:700;padding:.12rem .4rem;border-radius:4px">${l.abbr}</span>`;
    };
    const fmt = iso => iso ? new Date(iso).toLocaleString('en-IN', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', hour12:true }) : '—';

    const matrixHtml = `
      <div style="margin-bottom:1rem">
        <div style="font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#94a3b8;margin-bottom:.4rem">Interaction Matrix</div>
        <table style="width:100%;border-collapse:collapse;font-size:.8rem">
          <thead><tr style="background:#f5f7fa">
            <th style="padding:.4rem .55rem;text-align:left;font-weight:700;color:#374151;border-bottom:1.5px solid #e2e8f0">Level</th>
            <th style="padding:.4rem .55rem;text-align:center;font-weight:700;color:#374151;border-bottom:1.5px solid #e2e8f0">📞 Calls</th>
            <th style="padding:.4rem .55rem;text-align:center;font-weight:700;color:#374151;border-bottom:1.5px solid #e2e8f0">🤝 Meets</th>
            <th style="padding:.4rem .55rem;text-align:center;font-weight:700;color:#374151;border-bottom:1.5px solid #e2e8f0">👨‍👩 Parent</th>
          </tr></thead>
          <tbody>
            ${[1,2,3,4].map(l => {
              const m = matrix[l]; const total = m.call + m.meet + m['parent-meet'];
              return `<tr style="${total > 0 ? 'background:#fafbff' : ''}">
                <td style="padding:.4rem .55rem;border-bottom:1px solid #f1f5f9">${levelPill(l)}</td>
                <td style="padding:.4rem .55rem;text-align:center;border-bottom:1px solid #f1f5f9;font-weight:${m.call > 0 ? 700 : 400};color:${m.call > 0 ? '#0d2d5a' : '#94a3b8'}">${m.call || '—'}</td>
                <td style="padding:.4rem .55rem;text-align:center;border-bottom:1px solid #f1f5f9;font-weight:${m.meet > 0 ? 700 : 400};color:${m.meet > 0 ? '#15803d' : '#94a3b8'}">${m.meet || '—'}</td>
                <td style="padding:.4rem .55rem;text-align:center;border-bottom:1px solid #f1f5f9;font-weight:${m['parent-meet'] > 0 ? 700 : 400};color:${m['parent-meet'] > 0 ? '#b45309' : '#94a3b8'}">${m['parent-meet'] || '—'}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;

    const timelineHtml = interactions.length ? `
      <div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.5rem">
          <div style="font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#94a3b8">Timeline (${interactions.length})</div>
          <button class="btn btn-primary btn-sm" onclick="openLogInteractionModal('${devoteeId}','${devoteeName.replace(/'/g,"\\'")}')">
            <i class="fas fa-plus"></i> Add
          </button>
        </div>
        ${interactions.map(ix => {
          const l = INTERACTION_LEVELS[ix.level] || INTERACTION_LEVELS[4];
          return `<div style="border-left:3px solid ${l.color};padding:.4rem .7rem;margin-bottom:.45rem;background:#fff;border-radius:0 6px 6px 0;box-shadow:0 1px 3px rgba(0,0,0,.05)">
            <div style="display:flex;align-items:center;gap:.4rem;flex-wrap:wrap">
              <span style="background:${l.bg};color:${l.color};font-size:.65rem;font-weight:700;padding:.1rem .35rem;border-radius:4px">${l.abbr}</span>
              <span style="font-weight:700;font-size:.8rem">${TYPE_LABELS[ix.type] || ix.type}</span>
              <span style="font-size:.72rem;color:#94a3b8;margin-left:auto">${fmt(ix.atClient)}</span>
            </div>
            <div style="font-size:.72rem;color:#64748b;margin-top:.2rem">by ${ix.by}</div>
            ${ix.notes ? `<div style="font-size:.75rem;color:#374151;margin-top:.2rem;font-style:italic">"${ix.notes}"</div>` : ''}
          </div>`;
        }).join('')}
      </div>` : `
      <div style="text-align:center;padding:1rem">
        <p style="color:#94a3b8;font-size:.85rem">No interactions logged yet</p>
        <button class="btn btn-primary btn-sm" style="margin-top:.5rem"
                onclick="openLogInteractionModal('${devoteeId}','${devoteeName.replace(/'/g,"\\'")}')">
          <i class="fas fa-plus"></i> Log First Interaction
        </button>
      </div>`;

    body.innerHTML = matrixHtml + timelineHtml;
  } catch (e) {
    body.innerHTML = '<div class="empty-state"><p>Failed to load</p></div>';
    console.error('openInteractionHistory', e);
  }
}
window.openInteractionHistory = openInteractionHistory;

// ── LOG INTERACTION MODAL ─────────────────────────────────────────────────────
let _liPrefillDevoteeId = null;
let _liPrefillDevoteeName = '';

function openLogInteractionModal(devoteeId, devoteeName) {
  _liPrefillDevoteeId = devoteeId || null;
  _liPrefillDevoteeName = devoteeName || '';
  document.getElementById('li-devotee-id').value   = devoteeId || '';
  document.getElementById('li-devotee-name').value = devoteeName || '';
  document.getElementById('li-notes').value = '';
  document.getElementById('li-error').style.display = 'none';
  document.querySelector('input[name="li-type"][value="call"]').checked = true;
  document.getElementById('li-level').value = '4';
  openModal('log-interaction-modal');
}
window.openLogInteractionModal = openLogInteractionModal;

async function _liSearchDevotee(q) {
  const menu = document.getElementById('li-picker-menu');
  if (!q || q.length < 2) { menu.classList.add('hidden'); return; }
  const all = await DevoteeCache.all().catch(() => []);
  const ql = q.toLowerCase();
  const matches = all.filter(d => d.isActive !== false && (d.name||'').toLowerCase().includes(ql)).slice(0,8);
  if (!matches.length) { menu.classList.add('hidden'); return; }
  menu.innerHTML = matches.map(d =>
    `<div class="picker-option" style="padding:.45rem .7rem;cursor:pointer;font-size:.85rem"
          onclick="_liSelectDevotee('${d.id}','${(d.name||'').replace(/'/g,"\\'")}')">
       ${d.name} <span style="color:#94a3b8;font-size:.75rem">${d.teamName||''}</span>
     </div>`).join('');
  menu.classList.remove('hidden');
}
window._liSearchDevotee = _liSearchDevotee;

function _liSelectDevotee(id, name) {
  document.getElementById('li-devotee-id').value   = id;
  document.getElementById('li-devotee-name').value = name;
  document.getElementById('li-picker-menu').classList.add('hidden');
}
window._liSelectDevotee = _liSelectDevotee;

async function saveInteraction() {
  const devoteeId   = document.getElementById('li-devotee-id').value.trim();
  const devoteeName = document.getElementById('li-devotee-name').value.trim();
  const level       = parseInt(document.getElementById('li-level').value);
  const type        = document.querySelector('input[name="li-type"]:checked')?.value || 'call';
  const notes       = document.getElementById('li-notes').value.trim();
  const errEl       = document.getElementById('li-error');
  errEl.style.display = 'none';

  if (!devoteeId || !devoteeName) {
    errEl.textContent = 'Please select a devotee.'; errEl.style.display = 'block'; return;
  }
  const all = await DevoteeCache.all().catch(() => []);
  const dev = all.find(d => d.id === devoteeId) || {};

  try {
    await DB.logInteraction({ devoteeId, devoteeName, teamName: dev.teamName || '', level, type, notes, by: AppState.userName, byUserId: AppState.userId });
    closeModal('log-interaction-modal');
    showToast('Interaction logged! Hare Krishna 🙏', 'success');
    // Refresh whichever meet sub-tab is active
    if (_meetActiveSubTab === 'my-log') _loadMyLogTab();
  } catch (e) {
    errEl.textContent = 'Save failed: ' + e.message; errEl.style.display = 'block';
  }
}
window.saveInteraction = saveInteraction;

// Returns the bucket function for a given devoteeStatus matching the chip key.
function _meetMatchesStatus(devoteeStatus, isActive, filterKey) {
  if (filterKey === 'all') return true;
  if (filterKey === 'Inactive') return devoteeStatus === 'Inactive' || isActive === false;
  if (filterKey === 'ETS') return !devoteeStatus || devoteeStatus === 'Expected to be Serious';
  return devoteeStatus === filterKey;
}

// Re-render whichever sub-panel is active + update chip counts.
function _renderMeetingsTabContent() {
  const overdue   = _overdueListCache || [];
  const upcoming  = _pmRenderState?.upcoming || [];
  const recent    = _pmRenderState?.recent || [];
  const completed = (_meetingsCache || []).filter(m => m.status === 'completed')
                      .sort((a, b) => (b.completedDate || b.scheduledDate || '').localeCompare(a.completedDate || a.scheduledDate || ''));

  // Determine which list the chip filter applies to (depends on active sub-tab).
  const activeList =
      _meetActiveSubTab === 'overdue'   ? overdue
    : _meetActiveSubTab === 'scheduled' ? upcoming
    : _meetActiveSubTab === 'completed' ? completed
    : recent;

  // Update chip counts based on active list's status distribution.
  _updateMeetingsChipCounts(activeList, _meetActiveSubTab);

  // Apply status filter.
  const filtered = activeList.filter(item => {
    const d = item.devotee || (item.devoteeId ? { devoteeStatus: item.devoteeStatus, isActive: true } : item);
    const status = item.devotee?.devoteeStatus ?? item.devoteeStatus ?? '';
    const isActive = item.devotee?.isActive ?? true;
    return _meetMatchesStatus(status, isActive, _meetStatusFilter);
  });

  // Render into the active panel.
  if (_meetActiveSubTab === 'overdue') {
    const target = document.getElementById('meet-panel-overdue');
    if (target) target.innerHTML = filtered.length
      ? _overdueTableHtml(filtered.slice(0, 300))
      : '<div class="meet-empty"><i class="fas fa-check-circle"></i><p>All clear — no overdue meetings in this category.</p></div>';
  } else if (_meetActiveSubTab === 'scheduled') {
    const target = document.getElementById('meet-panel-scheduled');
    if (target) target.innerHTML = filtered.length
      ? _meetingsListHtml(filtered, 'scheduled')
      : '<div class="meet-empty"><i class="fas fa-calendar"></i><p>No upcoming meetings scheduled.</p></div>';
  } else if (_meetActiveSubTab === 'completed') {
    const target = document.getElementById('meet-panel-completed');
    if (target) target.innerHTML = _renderCompletedMeetings(filtered);
  } else if (_meetActiveSubTab === 'recent') {
    const target = document.getElementById('meet-panel-recent');
    if (target) target.innerHTML = filtered.length
      ? _meetingsListHtml(filtered, 'recent')
      : '<div class="meet-empty"><i class="fas fa-clock"></i><p>No recent meetings in the last 30 days.</p></div>';
  }
}

function _updateMeetingsChipCounts(list, subTab) {
  const counts = { all: list.length, 'Most Serious': 0, 'Serious': 0, 'ETS': 0, 'New Devotee': 0, 'Inactive': 0 };
  list.forEach(item => {
    const status = item.devotee?.devoteeStatus ?? item.devoteeStatus ?? '';
    const isActive = item.devotee?.isActive ?? true;
    if (status === 'Most Serious') counts['Most Serious']++;
    else if (status === 'Serious') counts['Serious']++;
    else if (status === 'New Devotee') counts['New Devotee']++;
    else if (status === 'Inactive' || isActive === false) counts['Inactive']++;
    else counts['ETS']++;
  });
  Object.entries(counts).forEach(([key, n]) => {
    const el = document.querySelector(`#meet-status-chips [data-count="${key}"]`);
    if (el) el.textContent = n;
  });
}

// Render a meetings list (Scheduled / Completed / Recent) as cards.
function _meetingsListHtml(list, mode) {
  return list.slice(0, 300).map(m => {
    const dateStr = (mode === 'scheduled' || !m.completedDate) ? m.scheduledDate : m.completedDate;
    const dateLbl = dateStr ? _meetingDateLabel(dateStr) : '—';
    const dateBg  = mode === 'scheduled' ? 'var(--accent-light)' : 'var(--success-light)';
    const dateColor = mode === 'scheduled' ? 'var(--accent)' : 'var(--success)';
    const remarks = m.authorityRemarks ? `
      <div style="margin-top:.4rem;padding:.45rem .65rem;background:var(--accent-light);border-left:3px solid var(--accent);border-radius:var(--radius-xs);font-size:.78rem;color:#5a3a1a">
        <strong style="font-size:.7rem;text-transform:uppercase;letter-spacing:.4px;display:block;margin-bottom:.15rem">Authority Remarks</strong>
        ${m.authorityRemarks}
      </div>` : '';
    return `
      <div style="border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:.7rem .85rem;margin-bottom:.55rem;background:var(--bg-card)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.6rem;flex-wrap:wrap">
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:.95rem;cursor:pointer;color:var(--color-primary)" onclick="openProfileModal('${m.devoteeId}')">${m.devoteeName || '—'}</div>
            <div style="font-size:.74rem;color:var(--text-muted);margin-top:.15rem">${m.teamName || ''}${m.devoteeStatus ? ' · ' + m.devoteeStatus : ''}</div>
          </div>
          <div style="background:${dateBg};color:${dateColor};padding:.22rem .6rem;border-radius:var(--radius-xs);font-size:.78rem;font-weight:700;white-space:nowrap">${dateLbl}</div>
        </div>
        <div style="font-size:.78rem;color:var(--text-muted);margin-top:.35rem">
          ${m.metBy ? `<i class="fas fa-user" style="opacity:.6"></i> ${m.metBy}` : ''}
        </div>
        ${m.notes ? `<div style="font-size:.78rem;color:#444;margin-top:.3rem;font-style:italic">"${m.notes}"</div>` : ''}
        ${remarks}
        <div style="margin-top:.55rem;display:flex;gap:.4rem;flex-wrap:wrap">
          <button class="btn btn-ghost btn-sm" style="font-size:.74rem" onclick="openScheduleMeetingForm('${m.id}')"><i class="fas fa-edit"></i> Edit / Add Remarks</button>
          ${mode === 'scheduled' ? `<button class="btn btn-primary btn-sm" style="font-size:.74rem" onclick="markMeetingComplete('${m.id}')"><i class="fas fa-check"></i> Mark Complete</button>` : ''}
          ${mode === 'completed' ? `<button class="btn btn-ghost btn-sm" style="font-size:.74rem;color:var(--danger)" onclick="disconnectMetBadge('${m.devoteeId}','${(m.devoteeName||'').replace(/'/g,"\\'")}')"><i class="fas fa-unlink"></i> Remove © Badge</button>` : ''}
        </div>
      </div>`;
  }).join('');
}

// ── COMPLETED MEETINGS — WhatsApp-Calls-style list ──────────────────────────
// Grouped by devotee: avatar + name + "last met · team · ref" sub-line +
// call/WhatsApp icons. Tap a row → full chronological meeting history modal.
let _completedMeetGroups = [];
function _mhEsc(s) { return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function _renderCompletedMeetings(list) {
  const byDev = {};
  list.forEach(m => {
    const id = m.devoteeId; if (!id) return;
    if (!byDev[id]) byDev[id] = { id, name: m.devoteeName || '—', teamName: m.teamName || '', meetings: [] };
    byDev[id].meetings.push(m);
  });
  const devs = Object.values(byDev);
  const lastOf = dv => (dv.meetings[0]?.completedDate || dv.meetings[0]?.scheduledDate || '');
  devs.forEach(dv => dv.meetings.sort((a, b) =>
    (b.completedDate || b.scheduledDate || '').localeCompare(a.completedDate || a.scheduledDate || '')));
  devs.sort((a, b) => lastOf(b).localeCompare(lastOf(a)));
  _completedMeetGroups = devs;

  return `
    <div class="mtg-toolbar">
      <button class="mtg-tool-btn mtg-tool-btn--primary" onclick="openScheduleMeetingForm()">
        <i class="fas fa-calendar-plus"></i> Schedule
      </button>
      <div class="mtg-search">
        <i class="fas fa-search"></i>
        <input id="mtg-search-input" placeholder="Search devotee…" autocomplete="off"
               oninput="_filterCompletedMeetings(this.value)">
      </div>
    </div>
    <div class="mtg-list" id="mtg-completed-list">${_completedMeetRows(devs)}</div>`;
}

function _completedMeetRows(devs) {
  if (!devs.length) return '<div class="meet-empty"><i class="fas fa-history"></i><p>No completed meetings</p></div>';
  return devs.map(dv => {
    const dev = (_meetingsDevoteesCache || []).find(x => x.id === dv.id) || {};
    const mobile  = dev.mobile || '';
    const altMob  = dev.mobileAlt || '';
    const ref     = dev.referenceBy || '';
    const last    = dv.meetings[0];
    const lastLbl = _meetingDateLabel(last.completedDate || last.scheduledDate);
    const sub = [lastLbl ? `Last met ${lastLbl}` : '', dv.teamName, ref ? `Ref: ${ref}` : '']
                  .filter(Boolean).join('  ·  ');
    const cnt = dv.meetings.length > 1 ? `<span class="mtg-row__count">${dv.meetings.length}</span>` : '';
    const sName = (dv.name || '').replace(/'/g, "\\'");
    return `<div class="mtg-row" onclick="openDevoteeMeetingHistory('${dv.id}')">
      <span class="mtg-row__avatar">${initials(dv.name)}</span>
      <span class="mtg-row__body">
        <span class="mtg-row__name">${dv.name}${cnt}</span>
        <span class="mtg-row__sub">${sub || '—'}</span>
      </span>
      <span class="mtg-row__actions" onclick="event.stopPropagation()">${contactIcons(mobile, { altMobile: altMob, devoteeId: dv.id, name: sName })}</span>
    </div>`;
  }).join('');
}

function _filterCompletedMeetings(q) {
  const ql = (q || '').toLowerCase().trim();
  const filtered = !ql ? _completedMeetGroups
    : _completedMeetGroups.filter(dv => (dv.name || '').toLowerCase().includes(ql));
  const el = document.getElementById('mtg-completed-list');
  if (el) el.innerHTML = _completedMeetRows(filtered);
}
window._filterCompletedMeetings = _filterCompletedMeetings;

// Full meeting history for one devotee — chronological (latest at top),
// each meeting expandable to show its minutes (notes + authority remarks).
function openDevoteeMeetingHistory(devoteeId) {
  const meetings = (_meetingsCache || [])
    .filter(m => m.devoteeId === devoteeId)
    .sort((a, b) => (b.completedDate || b.scheduledDate || '').localeCompare(a.completedDate || a.scheduledDate || ''));
  const dev  = (_meetingsDevoteesCache || []).find(x => x.id === devoteeId) || {};
  const name = meetings[0]?.devoteeName || dev.name || 'Devotee';

  const nameEl = document.getElementById('dmh-name');
  const subEl  = document.getElementById('dmh-sub');
  const body   = document.getElementById('dmh-body');
  if (nameEl) nameEl.textContent = name;
  if (subEl)  subEl.textContent  = [dev.teamName, `${meetings.length} meeting${meetings.length !== 1 ? 's' : ''}`]
                                     .filter(Boolean).join('  ·  ');

  if (body) {
    const items = meetings.map((m, i) => {
      const dateLbl = _meetingDateLabel(m.completedDate || m.scheduledDate) || '—';
      const latest  = i === 0;
      const badge   = m.status === 'completed'
        ? '<span class="dmh-badge dmh-badge--done">Completed</span>'
        : '<span class="dmh-badge dmh-badge--sched">Scheduled</span>';
      const mins = [];
      if (m.notes)            mins.push(`<div class="dmh-min"><strong>Notes</strong><span>${_mhEsc(m.notes)}</span></div>`);
      if (m.authorityRemarks) mins.push(`<div class="dmh-min dmh-min--auth"><strong>Authority remarks</strong><span>${_mhEsc(m.authorityRemarks)}</span></div>`);
      const minsHtml = mins.length ? mins.join('') : '<div class="dmh-min dmh-min--empty">No minutes recorded for this meeting.</div>';
      return `<div class="dmh-item${latest ? ' dmh-open' : ''}">
        <button class="dmh-item__head" onclick="this.parentElement.classList.toggle('dmh-open')">
          <span class="dmh-item__date">${dateLbl}${latest ? '<span class="dmh-latest">Latest</span>' : ''}</span>
          <span class="dmh-item__by"><i class="fas fa-user"></i> ${_mhEsc(m.metBy) || '—'}</span>
          ${badge}
          <i class="fas fa-chevron-down dmh-item__chev"></i>
        </button>
        <div class="dmh-item__min">${minsHtml}</div>
      </div>`;
    }).join('');
    const sName = (name || '').replace(/'/g, "\\'");
    body.innerHTML = (meetings.length ? items : '<div class="meet-empty"><p>No meetings recorded yet.</p></div>')
      + `<div class="dmh-foot">
           <button class="btn btn-ghost btn-sm" onclick="openScheduleMeetingForm(null,'${devoteeId}')"><i class="fas fa-calendar-plus"></i> New meeting</button>
           <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="closeModal('devotee-meeting-history-modal'); disconnectMetBadge('${devoteeId}','${sName}')"><i class="fas fa-unlink"></i> Remove © badge</button>
         </div>`;
  }
  openModal('devotee-meeting-history-modal');
}
window.openDevoteeMeetingHistory = openDevoteeMeetingHistory;

function openTeamRenameModal() {
  document.getElementById('rename-team-from').value = '';
  document.getElementById('rename-team-to').value = '';
  document.getElementById('rename-team-result').innerHTML = '';
  openModal('team-rename-modal');
}
window.openTeamRenameModal = openTeamRenameModal;

async function doTeamRename() {
  const from = document.getElementById('rename-team-from').value.trim();
  const to   = document.getElementById('rename-team-to').value.trim();
  const res  = document.getElementById('rename-team-result');
  if (!from) { res.innerHTML = '<span style="color:var(--danger)">Please select the current team name.</span>'; return; }
  if (!to)   { res.innerHTML = '<span style="color:var(--danger)">Please enter the new team name.</span>'; return; }
  if (from === to) { res.innerHTML = '<span style="color:var(--danger)">Old and new names are the same.</span>'; return; }
  if (!confirm(`Rename team "${from}" → "${to}" everywhere?\n\nThis updates all devotees, calling records, attendance, and activity logs. This cannot be undone.`)) return;
  res.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Renaming…';
  try {
    const count = await DB.renameTeam(from, to);
    res.innerHTML = `<span style="color:var(--success)"><i class="fas fa-check-circle"></i> Done — ${count} records updated. Refresh the page to see changes.</span>`;
    DevoteeCache.bust();
  } catch (e) {
    res.innerHTML = `<span style="color:var(--danger)"><i class="fas fa-exclamation-circle"></i> Failed: ${e.message || 'Unknown error'}</span>`;
  }
}
window.doTeamRename = doTeamRename;

async function _loadPersonalMeetings() {
  const body = document.getElementById('personal-meetings-body');
  body.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';
  try {
    const [meetings, devotees] = await Promise.all([
      DB.getPersonalMeetings(),
      DevoteeCache.all(),
    ]);
    _meetingsCache = meetings;
    _meetingsDevoteesCache = devotees;

    const today = getToday();
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
    const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth()+1).padStart(2,'0')}-${String(cutoff.getDate()).padStart(2,'0')}`;
    const recentCutoff = new Date(); recentCutoff.setDate(recentCutoff.getDate() - 30);
    const recentCutoffStr = `${recentCutoff.getFullYear()}-${String(recentCutoff.getMonth()+1).padStart(2,'0')}-${String(recentCutoff.getDate()).padStart(2,'0')}`;

    // Build per-devotee last-completed map
    const lastCompletedByDev = {};
    meetings.forEach(m => {
      if (m.status !== 'completed') return;
      const d = m.completedDate || m.scheduledDate;
      if (!d) return;
      if (!lastCompletedByDev[m.devoteeId] || lastCompletedByDev[m.devoteeId].date < d) {
        lastCompletedByDev[m.devoteeId] = { date: d, metBy: m.metBy };
      }
    });

    // Upcoming: scheduled, scheduledDate >= today
    const upcoming = meetings
      .filter(m => m.status === 'scheduled' && (m.scheduledDate || '') >= today)
      .sort((a, b) => (a.scheduledDate || '').localeCompare(b.scheduledDate || ''));

    // Recently met: completed in last 30 days
    const recent = meetings
      .filter(m => m.status === 'completed' && (m.completedDate || m.scheduledDate || '') >= recentCutoffStr)
      .sort((a, b) => (b.completedDate || b.scheduledDate || '').localeCompare(a.completedDate || a.scheduledDate || ''));

    // Overdue: only CONNECTING devotees (those who have already met Prabhuji at
    // least once) whose LAST meeting was 30+ days ago — i.e. due for a follow-up.
    // Never-met devotees are excluded (they belong to calling, not meeting follow-up).
    // Also excludes upcoming-scheduled, not-interested, and online-mode callers.
    const upcomingDevIds = new Set(upcoming.map(m => m.devoteeId));
    const eligibleDevotees = devotees.filter(d =>
      !d.isNotInterested && d.callingMode !== 'not_interested'
      // intentionally NOT filtering on isActive — 'Inactive' is a category we surface
    );
    const overdue = eligibleDevotees
      .filter(d => !upcomingDevIds.has(d.id))
      .map(d => {
        const last = lastCompletedByDev[d.id];
        const lastDate = last ? last.date : '';
        const days = lastDate ? Math.floor((new Date(today) - new Date(lastDate)) / 86400000) : Infinity;
        return { devotee: d, lastDate, lastMetBy: last?.metBy || '', days };
      })
      // require lastDate → only those who have met Prabhuji before (connecting)
      .filter(x => x.lastDate && x.days > 30)
      .sort((a, b) => {
        const seriousness = s => s === 'Most Serious' ? 0 : s === 'Serious' ? 1 : s === 'Expected to be Serious' || !s ? 2 : s === 'New Devotee' ? 3 : 4;
        const sa = seriousness(a.devotee.devoteeStatus);
        const sb = seriousness(b.devotee.devoteeStatus);
        if (sa !== sb) return sa - sb;
        return b.days - a.days;
      });

    _overdueListCache = overdue;
    _overdueFilter = 'all';
    _pmRenderState = { upcoming, recent };
    _renderPersonalMeetingsBody();
  } catch (e) {
    console.error('loadPersonalMeetings', e);
    body.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load meetings</p></div>';
  }
}

function _renderMeetingSection(title, count, color, content) {
  return `
    <div style="border:1px solid var(--color-border);border-radius:var(--radius-sm);overflow:hidden;background:var(--bg-card,#fff)">
      <div style="background:${color};color:#fff;padding:.55rem .85rem;font-weight:700;font-size:.85rem;display:flex;justify-content:space-between;align-items:center">
        <span>${title}</span>
        <span style="background:rgba(255,255,255,.22);padding:.1rem .55rem;border-radius:9999px;font-size:.75rem">${count}</span>
      </div>
      <div style="padding:.5rem;max-height:60vh;overflow-y:auto">${content || '<div style="text-align:center;color:var(--text-muted);font-size:.82rem;padding:2rem 0">No items</div>'}</div>
    </div>`;
}

function _meetingDateLabel(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  return `${day} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m-1]} ${y.slice(-2)}`;
}

function _renderUpcomingCards(list) {
  if (!list.length) return '';
  const today = getToday();
  return list.map(m => {
    const isToday = m.scheduledDate === today;
    const dateBg = isToday ? '#fef3c7' : '#f0f9ff';
    return `
    <div style="border:1px solid var(--color-border);border-radius:var(--radius-xs);padding:.55rem .7rem;margin-bottom:.45rem;background:#fff">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem">
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:.92rem;cursor:pointer;color:var(--color-primary)" onclick="openProfileModal('${m.devoteeId}')">${m.devoteeName || '—'}</div>
          <div style="font-size:.74rem;color:var(--text-muted);margin-top:.15rem">${m.teamName || ''} ${m.devoteeStatus ? '· ' + m.devoteeStatus : ''}</div>
        </div>
        <div style="background:${dateBg};padding:.2rem .5rem;border-radius:var(--radius-xs);font-size:.75rem;font-weight:700;white-space:nowrap">
          ${isToday ? 'Today' : _meetingDateLabel(m.scheduledDate)}
        </div>
      </div>
      <div style="font-size:.76rem;color:var(--text-muted);margin-top:.3rem">With: <strong>${m.metBy || '—'}</strong></div>
      ${m.notes ? `<div style="font-size:.74rem;color:#555;margin-top:.25rem;font-style:italic">${m.notes}</div>` : ''}
      <div style="display:flex;gap:.35rem;margin-top:.45rem">
        <button class="btn btn-primary btn-sm" style="flex:1;font-size:.72rem" onclick="markMeetingComplete('${m.id}')"><i class="fas fa-check"></i> Mark Done</button>
        <button class="btn btn-ghost btn-sm" style="font-size:.72rem" onclick="openScheduleMeetingForm('${m.id}')"><i class="fas fa-edit"></i></button>
      </div>
    </div>`;
  }).join('');
}

// Renders the entire Overdue card column: header + filter chips + filtered list.
// Reads _overdueListCache and _overdueFilter from outer scope.
function _renderOverdueSectionInner() {
  const list = _overdueListCache || [];
  const total = list.length;

  // Bucket by category (ETS = Expected to be Serious, also covers blank devoteeStatus)
  const buckets = {
    'all':                     list,
    'Most Serious':            list.filter(x => x.devotee.devoteeStatus === 'Most Serious'),
    'Serious':                 list.filter(x => x.devotee.devoteeStatus === 'Serious'),
    'Expected to be Serious':  list.filter(x => !x.devotee.devoteeStatus || x.devotee.devoteeStatus === 'Expected to be Serious'),
    'New Devotee':             list.filter(x => x.devotee.devoteeStatus === 'New Devotee'),
    'Inactive':                list.filter(x => x.devotee.devoteeStatus === 'Inactive' || x.devotee.isActive === false),
  };

  const chipDef = [
    { key: 'all',                     label: 'All',          color: '#1f2937' },
    { key: 'Most Serious',            label: 'Most Serious', color: '#7f1d1d' },
    { key: 'Serious',                 label: 'Serious',      color: '#9a3412' },
    { key: 'Expected to be Serious',  label: 'ETS',          color: '#92400e' },
    { key: 'New Devotee',             label: 'New',          color: '#1e40af' },
    { key: 'Inactive',                label: 'Inactive',     color: '#374151' },
  ];

  const chips = chipDef.map(c => {
    const active = c.key === _overdueFilter;
    const count = buckets[c.key]?.length || 0;
    return `<button onclick="setOverdueFilter('${c.key.replace(/'/g, "\\'")}')"
      style="border:1px solid ${active ? c.color : 'var(--color-border)'};
             background:${active ? c.color : '#fff'};
             color:${active ? '#fff' : c.color};
             padding:.18rem .55rem;border-radius:9999px;font-size:.72rem;font-weight:600;cursor:pointer">
      ${c.label} <span style="opacity:.85;font-weight:700">${count}</span>
    </button>`;
  }).join(' ');

  const filtered = buckets[_overdueFilter] || [];
  const bodyHtml = !filtered.length
    ? '<div style="text-align:center;color:#16a34a;font-size:.85rem;padding:1.5rem 0">No devotees in this category 🎉</div>'
    : _overdueTableHtml(filtered.slice(0, 200)) +
      (filtered.length > 200 ? `<div style="text-align:center;color:var(--text-muted);font-size:.78rem;padding:.5rem">+ ${filtered.length - 200} more…</div>` : '');

  return `
    <div style="border:1px solid var(--color-border);border-radius:var(--radius-sm);overflow:hidden;background:var(--bg-card,#fff)">
      <div style="background:#dc2626;color:#fff;padding:.55rem .85rem;font-weight:700;font-size:.85rem;display:flex;justify-content:space-between;align-items:center">
        <span>Overdue (30+ days)</span>
        <span style="background:rgba(255,255,255,.22);padding:.1rem .55rem;border-radius:9999px;font-size:.75rem">${total}</span>
      </div>
      <div style="padding:.55rem .55rem .35rem;display:flex;flex-wrap:wrap;gap:.32rem;background:#fafafa;border-bottom:1px solid var(--color-border)">${chips}</div>
      <div style="max-height:60vh;overflow:auto">${bodyHtml}</div>
    </div>`;
}

function _overdueTableHtml(list) {
  const rows = list.map((x, i) => {
    const d = x.devotee;
    const gap = x.days === Infinity ? 'Never met' : `${x.days}d`;
    const gapColor = x.days === Infinity || x.days > 90 ? '#dc2626' : x.days > 60 ? '#ea580c' : '#ca8a04';
    const icons = (typeof contactIcons === 'function')
      ? contactIcons(d.mobile, { altMobile: d.altMobile, devoteeId: d.id, name: d.name || '' })
      : '';
    const status = d.devoteeStatus || (d.isActive === false ? 'Inactive' : '—');
    const lastMet = x.lastDate ? _meetingDateLabel(x.lastDate) : '—';
    return `
      <tr style="border-bottom:1px solid var(--color-border)">
        <td style="padding:.4rem .5rem;color:var(--text-muted);font-size:.75rem">${i + 1}</td>
        <td style="padding:.4rem .5rem">
          <div style="font-weight:700;color:var(--color-primary);cursor:pointer;font-size:.85rem" onclick="openProfileModal('${d.id}')">${d.name || '—'}</div>
          <div style="font-size:.7rem;color:var(--text-muted);margin-top:.1rem">${status}</div>
        </td>
        <td style="padding:.4rem .5rem;white-space:nowrap">
          ${d.mobile ? `<span style="font-size:.78rem;font-weight:600;color:#374151">${d.mobile}</span>` : ''}
          ${icons}
        </td>
        <td style="padding:.4rem .5rem;font-size:.78rem">${d.teamName || '—'}</td>
        <td style="padding:.4rem .5rem;font-size:.78rem">${d.callingBy || '—'}</td>
        <td style="padding:.4rem .5rem;font-size:.78rem;text-align:center">${d.chantingRounds || 0}</td>
        <td style="padding:.4rem .5rem;font-size:.74rem;white-space:nowrap">
          <div style="color:${gapColor};font-weight:700">${gap}</div>
          <div style="color:var(--text-muted);font-size:.7rem">${lastMet}</div>
        </td>
        <td style="padding:.4rem .5rem">
          <button class="btn btn-primary btn-sm" style="font-size:.72rem;white-space:nowrap;padding:.3rem .6rem" onclick="openScheduleMeetingForm(null, '${d.id}')">
            <i class="fas fa-calendar-plus"></i> Schedule
          </button>
        </td>
      </tr>`;
  }).join('');

  return `
    <table class="striped-rows" style="width:100%;border-collapse:collapse;font-size:.82rem">
      <thead style="position:sticky;top:0;z-index:1;background:#1E40AF;color:#fff">
        <tr>
          <th style="padding:.45rem .5rem;text-align:left;font-size:.72rem">#</th>
          <th style="padding:.45rem .5rem;text-align:left;font-size:.72rem">Name</th>
          <th style="padding:.45rem .5rem;text-align:left;font-size:.72rem">Mobile</th>
          <th style="padding:.45rem .5rem;text-align:left;font-size:.72rem">Team</th>
          <th style="padding:.45rem .5rem;text-align:left;font-size:.72rem">Calling By</th>
          <th style="padding:.45rem .5rem;text-align:center;font-size:.72rem">CR</th>
          <th style="padding:.45rem .5rem;text-align:left;font-size:.72rem">Last Met</th>
          <th style="padding:.45rem .5rem;text-align:left;font-size:.72rem">Action</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function _renderPersonalMeetingsBody() {
  const body = document.getElementById('personal-meetings-body');
  if (!body) return;
  const { upcoming, recent } = _pmRenderState;

  if (_overdueFilter === 'all') {
    // Default home view: Upcoming + Recently Met (top) + Overdue with chips (bottom)
    body.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:1rem;margin-bottom:1rem">
        ${_renderMeetingSection('Upcoming', upcoming.length, '#1E40AF', _renderUpcomingCards(upcoming))}
        ${_renderMeetingSection('Recently Met', recent.length, '#2563eb', _renderRecentCards(recent))}
      </div>
      <div id="pm-overdue-section">${_renderOverdueSectionInner()}</div>
    `;
  } else {
    // Single big-card focus view for the selected category
    body.innerHTML = `
      <div style="margin-bottom:.6rem">
        <button class="btn btn-ghost btn-sm" onclick="setOverdueFilter('all')">
          <i class="fas fa-arrow-left"></i> Back to overview
        </button>
      </div>
      <div id="pm-overdue-section">${_renderOverdueSectionInner()}</div>
    `;
  }
}

function setOverdueFilter(key) {
  _overdueFilter = key;
  _renderPersonalMeetingsBody();
}

function _overdueCardHtml(x) {
  const d = x.devotee;
  const gap = x.days === Infinity ? 'Never met' : `${x.days} days ago`;
  const gapBg = x.days === Infinity ? '#fee2e2' : x.days > 90 ? '#fee2e2' : x.days > 60 ? '#fed7aa' : '#fef3c7';
  const icons = (typeof contactIcons === 'function')
    ? contactIcons(d.mobile, { altMobile: d.altMobile, devoteeId: d.id, name: d.name || '' })
    : '';
  const status = d.devoteeStatus || (d.isActive === false ? 'Inactive' : '');
  return `
  <div style="border:1px solid var(--color-border);border-radius:var(--radius-xs);padding:.55rem .7rem;margin-bottom:.45rem;background:#fff">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem">
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:.92rem;cursor:pointer;color:var(--color-primary)" onclick="openProfileModal('${d.id}')">${d.name || '—'}</div>
        <div style="font-size:.74rem;color:var(--text-muted);margin-top:.15rem">${d.teamName || ''}${status ? ' · ' + status : ''}</div>
      </div>
      <div style="background:${gapBg};padding:.2rem .5rem;border-radius:var(--radius-xs);font-size:.72rem;font-weight:700;white-space:nowrap">${gap}</div>
    </div>
    <div style="display:flex;align-items:center;gap:.5rem;margin-top:.35rem;flex-wrap:wrap">
      ${d.mobile ? `<span style="font-size:.78rem;color:#374151;font-weight:600">${d.mobile}</span>` : ''}
      ${icons}
    </div>
    <div style="font-size:.72rem;color:var(--text-muted);margin-top:.3rem;line-height:1.45">
      ${d.callingBy ? `<span><i class="fas fa-phone-volume" style="opacity:.6"></i> ${d.callingBy}</span>` : ''}
      ${d.chantingRounds ? `<span style="margin-left:.6rem"><i class="fas fa-om" style="opacity:.6"></i> ${d.chantingRounds} rounds</span>` : ''}
    </div>
    ${x.lastDate ? `<div style="font-size:.72rem;color:var(--text-muted);margin-top:.25rem">Last met: ${_meetingDateLabel(x.lastDate)}${x.lastMetBy ? ' · ' + x.lastMetBy : ''}</div>` : ''}
    <button class="btn btn-primary btn-sm" style="font-size:.72rem;margin-top:.4rem;width:100%" onclick="openScheduleMeetingForm(null, '${d.id}')"><i class="fas fa-calendar-plus"></i> Schedule</button>
  </div>`;
}

function _renderRecentCards(list) {
  if (!list.length) return '';
  return list.map(m => `
    <div style="border:1px solid var(--color-border);border-radius:var(--radius-xs);padding:.55rem .7rem;margin-bottom:.45rem;background:#fff">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem">
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:.92rem;cursor:pointer;color:var(--color-primary)" onclick="openProfileModal('${m.devoteeId}')">${m.devoteeName || '—'}</div>
          <div style="font-size:.74rem;color:var(--text-muted);margin-top:.15rem">${m.teamName || ''} ${m.devoteeStatus ? '· ' + m.devoteeStatus : ''}</div>
        </div>
        <div style="background:#dcfce7;padding:.2rem .5rem;border-radius:var(--radius-xs);font-size:.75rem;font-weight:700;white-space:nowrap">${_meetingDateLabel(m.completedDate || m.scheduledDate)}</div>
      </div>
      <div style="font-size:.76rem;color:var(--text-muted);margin-top:.3rem">With: <strong>${m.metBy || '—'}</strong></div>
      ${m.notes ? `<div style="font-size:.74rem;color:#555;margin-top:.25rem;font-style:italic">${m.notes}</div>` : ''}
      <button class="btn btn-ghost btn-sm" style="font-size:.72rem;margin-top:.4rem" onclick="openScheduleMeetingForm('${m.id}')"><i class="fas fa-edit"></i> Edit</button>
    </div>
  `).join('');
}

function openScheduleMeetingForm(meetingId = null, devoteeId = null) {
  document.getElementById('meeting-id').value = meetingId || '';
  document.getElementById('schedule-meeting-title').innerHTML = meetingId
    ? '<i class="fas fa-edit"></i> Edit Meeting'
    : '<i class="fas fa-calendar-plus"></i> Schedule Meeting';
  document.getElementById('meeting-delete-btn').classList.toggle('hidden', !meetingId);

  if (meetingId && _meetingsCache) {
    const m = _meetingsCache.find(x => x.id === meetingId);
    if (m) {
      document.getElementById('meeting-devotee').value = m.devoteeName || '';
      _editingMeetingDevotee = { id: m.devoteeId, name: m.devoteeName, teamName: m.teamName, devoteeStatus: m.devoteeStatus };
      document.getElementById('meeting-devotee-info').textContent = `${m.teamName || ''} ${m.devoteeStatus ? '· ' + m.devoteeStatus : ''}`;
      document.getElementById('meeting-date').value = m.scheduledDate || '';
      document.getElementById('meeting-met-by').value = m.metBy || '';
      document.getElementById('meeting-status').value = m.status || 'scheduled';
      document.getElementById('meeting-notes').value = m.notes || '';
      document.getElementById('meeting-authority-remarks').value = m.authorityRemarks || '';
    }
  } else {
    document.getElementById('meeting-devotee').value = '';
    document.getElementById('meeting-devotee-info').textContent = '';
    _editingMeetingDevotee = null;
    document.getElementById('meeting-date').value = getToday();
    document.getElementById('meeting-met-by').value = '';
    document.getElementById('meeting-status').value = 'scheduled';
    document.getElementById('meeting-notes').value = '';
    document.getElementById('meeting-authority-remarks').value = '';
    if (devoteeId && _meetingsDevoteesCache) {
      const d = _meetingsDevoteesCache.find(x => x.id === devoteeId);
      if (d) {
        document.getElementById('meeting-devotee').value = d.name;
        document.getElementById('meeting-devotee-info').textContent = `${d.teamName || ''} ${d.devoteeStatus ? '· ' + d.devoteeStatus : ''}`;
        _editingMeetingDevotee = { id: d.id, name: d.name, teamName: d.teamName, devoteeStatus: d.devoteeStatus };
      }
    }
  }
  openModal('schedule-meeting-modal');
}

async function _meetingDevoteeFilter() {
  const container = document.getElementById('meeting-devotee-picker');
  const inp = document.getElementById('meeting-devotee');
  const dd  = container.querySelector('.picker-dropdown');
  const q = (inp.value || '').toLowerCase().trim();

  // Lazy-load devotee cache if user opened the form without first loading meetings
  if (!_meetingsDevoteesCache) {
    try { _meetingsDevoteesCache = await DevoteeCache.all(); }
    catch (e) { return; }
  }

  // Clear stored selection when user types something different from the chosen name
  if (_editingMeetingDevotee && _editingMeetingDevotee.name.toLowerCase() !== q) {
    _editingMeetingDevotee = null;
    document.getElementById('meeting-devotee-info').textContent = '';
    inp.classList.remove('has-value');
  }

  const matches = _meetingsDevoteesCache
    .filter(d => d.isActive !== false && !d.isNotInterested)
    .filter(d => !q || (d.name || '').toLowerCase().includes(q))
    .slice(0, 12);

  if (!matches.length) {
    dd.innerHTML = '<div class="picker-no-result">No devotee found</div>';
    dd.classList.remove('hidden');
    return;
  }
  dd.innerHTML = matches.map(d => {
    const safeName = (d.name || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const meta = `${d.teamName || ''}${d.devoteeStatus ? ' · ' + d.devoteeStatus : ''}`;
    return `<div class="picker-option" onclick="_meetingPickDevotee('${d.id}')">
      <span>${d.name || ''}</span>
      <span class="picker-team">${meta}</span>
    </div>`;
  }).join('');
  dd.classList.remove('hidden');

  // One-time outside-click handler that hides the dropdown
  if (!container._dismissBound) {
    document.addEventListener('click', (e) => {
      if (!container.contains(e.target)) dd.classList.add('hidden');
    });
    container._dismissBound = true;
  }
}

function _meetingPickDevotee(id) {
  const d = _meetingsDevoteesCache.find(x => x.id === id);
  if (!d) return;
  _editingMeetingDevotee = { id: d.id, name: d.name, teamName: d.teamName, devoteeStatus: d.devoteeStatus };
  const inp = document.getElementById('meeting-devotee');
  inp.value = d.name;
  inp.classList.add('has-value');
  document.getElementById('meeting-devotee-info').textContent = `${d.teamName || ''}${d.devoteeStatus ? ' · ' + d.devoteeStatus : ''}`;
  document.getElementById('meeting-devotee-picker').querySelector('.picker-dropdown').classList.add('hidden');
}

async function saveScheduledMeeting() {
  const id = document.getElementById('meeting-id').value;
  const date = document.getElementById('meeting-date').value;
  const metBy = document.getElementById('meeting-met-by').value;
  const status = document.getElementById('meeting-status').value;
  const notes = document.getElementById('meeting-notes').value.trim();
  const authorityRemarks = document.getElementById('meeting-authority-remarks').value.trim();

  if (!_editingMeetingDevotee) { showToast('Please select a devotee', 'error'); return; }
  if (!date) { showToast('Please select a date', 'error'); return; }
  if (!metBy) { showToast('Please select Met By', 'error'); return; }

  // Firestore rejects `undefined` field values. Always send a real string.
  const data = {
    devoteeId: _editingMeetingDevotee.id,
    devoteeName: _editingMeetingDevotee.name,
    teamName: _editingMeetingDevotee.teamName || '',
    devoteeStatus: _editingMeetingDevotee.devoteeStatus || '',
    scheduledDate: date,
    metBy, status, notes, authorityRemarks,
    completedDate: status === 'completed' ? date : '',
  };

  try {
    if (id) await DB.updatePersonalMeeting(id, data);
    else await DB.addPersonalMeeting(data);
    // Completing a meeting flags the devotee as "met Prabhuji" (© badge).
    if (status === 'completed' && _editingMeetingDevotee.id) {
      await DB.setDevoteeMetPrabhuji(_editingMeetingDevotee.id, true);
    }
    showToast(id ? 'Meeting updated' : 'Meeting scheduled', 'success');
    closeModal('schedule-meeting-modal');
    _loadPersonalMeetings();
  } catch (e) {
    showToast('Failed: ' + (e.message || 'Error'), 'error');
  }
}

async function markMeetingComplete(id) {
  try {
    await DB.updatePersonalMeeting(id, {
      status: 'completed',
      completedDate: getToday(),
    });
    // Flag the devotee as "met Prabhuji" (© badge).
    const m = (_meetingsCache || []).find(x => x.id === id);
    if (m && m.devoteeId) await DB.setDevoteeMetPrabhuji(m.devoteeId, true);
    showToast('Marked as completed', 'success');
    _loadPersonalMeetings();
  } catch (e) {
    showToast('Failed: ' + (e.message || 'Error'), 'error');
  }
}

// Remove the © "met" badge from a devotee — used from the Completed-meetings
// tab when an entry was logged by mistake or the connection should be reset.
async function disconnectMetBadge(devoteeId, name) {
  if (!devoteeId) return;
  if (!confirm(`Remove the "met Prabhuji" © badge from ${name || 'this devotee'}?\n\nThe meeting record stays — only the name badge is removed.`)) return;
  try {
    await DB.setDevoteeMetPrabhuji(devoteeId, false);
    showToast('Badge removed', 'success');
    if (typeof loadDevotees === 'function') loadDevotees();
  } catch (e) {
    showToast('Failed: ' + (e.message || 'Error'), 'error');
  }
}
window.disconnectMetBadge = disconnectMetBadge;

async function deleteCurrentMeeting() {
  const id = document.getElementById('meeting-id').value;
  if (!id) return;
  if (!confirm('Delete this meeting record?')) return;
  try {
    await DB.deletePersonalMeeting(id);
    showToast('Meeting deleted', 'success');
    closeModal('schedule-meeting-modal');
    _loadPersonalMeetings();
  } catch (e) {
    showToast('Failed: ' + (e.message || 'Error'), 'error');
  }
}

// ══ INDIVIDUAL REPORTS ═════════════════════════════════════════
// Per-devotee stats (sessions/attended/books/regs/services) for a chosen
// period (last week / month / year). Click name to open profile.

let _irPeriod = 'week';
let _irData = null; // { devotees, period, label, range }

async function openIndividualReports() {
  // Populate year selector once
  const ySel = document.getElementById('ir-year-input');
  if (ySel && !ySel.options.length) {
    const yr = new Date().getFullYear();
    for (let y = yr; y >= yr - 5; y--) {
      const opt = document.createElement('option');
      opt.value = y; opt.textContent = `${y}`;
      ySel.appendChild(opt);
    }
  }
  // Default month input to current
  const mEl = document.getElementById('ir-month-input');
  if (mEl && !mEl.value) {
    const n = new Date();
    mEl.value = `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}`;
  }
  openModal('individual-reports-modal');
  await _loadIndividualReports();
}

function _irSetPeriod(p) {
  _irPeriod = p;
  document.querySelectorAll('.ir-period-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.period === p);
  });
  document.getElementById('ir-month-input').classList.toggle('hidden', p !== 'month');
  document.getElementById('ir-year-input').classList.toggle('hidden', p !== 'year');
  _loadIndividualReports();
}

function _irGetRange() {
  const today = new Date();
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  if (_irPeriod === 'week') {
    const start = new Date(today); start.setDate(today.getDate() - 6);
    return { start: fmt(start), end: fmt(today), label: `Last 7 days (${fmt(start)} → ${fmt(today)})` };
  }
  if (_irPeriod === 'month') {
    const v = document.getElementById('ir-month-input').value || `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}`;
    const [y, m] = v.split('-').map(Number);
    const start = `${v}-01`;
    const last = new Date(y, m, 0).getDate();
    const end = `${v}-${String(last).padStart(2,'0')}`;
    const label = new Date(y, m-1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
    return { start, end, label };
  }
  // year
  const y = parseInt(document.getElementById('ir-year-input').value) || today.getFullYear();
  return { start: `${y}-01-01`, end: `${y}-12-31`, label: `${y}` };
}

async function _loadIndividualReports() {
  const body = document.getElementById('individual-reports-body');
  body.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';
  try {
    const range = _irGetRange();
    document.getElementById('ir-period-label').textContent = range.label;

    const [sessSnap, allDevotees] = await Promise.all([
      fdb.collection('sessions').where('sessionDate', '>=', range.start).where('sessionDate', '<=', range.end).orderBy('sessionDate', 'asc').get(),
      DevoteeCache.all(),
    ]);
    const sessions = sessSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => !s.isCancelled);
    const totalSessions = sessions.length;

    const atSnaps = await Promise.all(sessions.map(s =>
      fdb.collection('attendanceRecords').where('sessionId', '==', s.id).get()
    ));
    const presentByDev = {};
    sessions.forEach((s, i) => {
      atSnaps[i].docs.forEach(d => {
        const did = d.data().devoteeId;
        presentByDev[did] = (presentByDev[did] || 0) + 1;
      });
    });

    const activeDevotees = allDevotees
      .filter(d => d.isActive !== false && !d.isNotInterested && d.callingMode !== 'not_interested')
      .map(d => ({
        id: d.id,
        name: d.name,
        team: d.teamName || '',
        callingBy: d.callingBy || '',
        status: d.devoteeStatus || '',
        sessions: totalSessions,
        attended: presentByDev[d.id] || 0,
      }))
      .sort((a, b) =>
        (a.team || '').localeCompare(b.team || '') ||
        (a.name || '').localeCompare(b.name || '')
      );

    _irData = { devotees: activeDevotees, range, totalSessions };

    const totals = activeDevotees.reduce((acc, d) => ({
      attended: acc.attended + d.attended,
    }), { attended: 0 });

    body.innerHTML = `
      <div style="font-size:.82rem;color:var(--text-muted);margin-bottom:.6rem">
        Total sessions in period: <strong>${totalSessions}</strong> · ${activeDevotees.length} active devotees
      </div>
      <div class="table-scroll">
      <table class="report-table" style="width:100%;font-size:.82rem">
        <thead>
          <tr style="background:var(--color-primary,#1E40AF);color:#fff">
            <th style="padding:.45rem .55rem;text-align:left">Sno</th>
            <th style="padding:.45rem .55rem;text-align:left">Name</th>
            <th style="padding:.45rem .55rem;text-align:left">Team</th>
            <th style="padding:.45rem .55rem;text-align:center">Sessions</th>
            <th style="padding:.45rem .55rem;text-align:center">Attended</th>
            <th style="padding:.45rem .55rem;text-align:center">%</th>
          </tr>
        </thead>
        <tbody>
          ${activeDevotees.map((d, i) => {
            const pct = totalSessions > 0 ? Math.round((d.attended / totalSessions) * 100) : 0;
            const pctColor = pct >= 75 ? '#16a34a' : pct >= 50 ? '#f59e0b' : '#dc2626';
            return `<tr style="border-bottom:1px solid var(--color-border)">
              <td style="padding:.4rem .55rem;color:var(--text-muted)">${i + 1}</td>
              <td style="padding:.4rem .55rem"><a style="color:var(--color-primary);cursor:pointer;font-weight:600;text-decoration:none" onclick="openProfileModal('${d.id}')">${d.name || '—'}</a></td>
              <td style="padding:.4rem .55rem">${d.team}</td>
              <td style="padding:.4rem .55rem;text-align:center">${d.sessions}</td>
              <td style="padding:.4rem .55rem;text-align:center;font-weight:600">${d.attended}</td>
              <td style="padding:.4rem .55rem;text-align:center;color:${pctColor};font-weight:700">${pct}%</td>
            </tr>`;
          }).join('')}
          <tr style="background:#f5f7f5;font-weight:700">
            <td style="padding:.5rem .55rem"></td>
            <td style="padding:.5rem .55rem">Grand Total</td>
            <td></td>
            <td style="padding:.5rem .55rem;text-align:center">${totalSessions}</td>
            <td style="padding:.5rem .55rem;text-align:center">${totals.attended}</td>
            <td></td>
          </tr>
        </tbody>
      </table>
      </div>
    `;
  } catch (e) {
    console.error('loadIndividualReports', e);
    body.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load</p></div>';
  }
}

function downloadIndividualReports() {
  if (!_irData) { showToast('Load data first', 'error'); return; }
  try {
    const XS = _xls();
    const { devotees, range, totalSessions } = _irData;
    const hdr = XS.hdr();
    const txt = (v) => ({ v, s: XS.cell({ left: true }) });
    const num = (v) => ({ v: v || 0, s: XS.cell({}) });
    const pctCell = (a, t) => {
      const p = t > 0 ? Math.round((a / t) * 100) : 0;
      const bg = p >= 75 ? 'C8E6C9' : p >= 50 ? 'FFF9C4' : 'FFCDD2';
      return { v: `${p}%`, s: XS.cell({ bg, bold: true }) };
    };

    const rows = [
      [{ v: `Individual Report — ${range.label}`, s: hdr }],
      [{ v: `Total sessions: ${totalSessions}`, s: XS.cell({ left: true, bold: true }) }],
      [],
      [
        { v: 'Sno', s: hdr }, { v: 'Name', s: hdr }, { v: 'Team', s: hdr }, { v: 'Calling By', s: hdr }, { v: 'Status', s: hdr },
        { v: 'Sessions', s: hdr }, { v: 'Attended', s: hdr }, { v: '%', s: hdr },
      ],
    ];
    devotees.forEach((d, i) => {
      rows.push([
        num(i + 1), txt(d.name), txt(d.team), txt(d.callingBy), txt(d.status),
        num(d.sessions), num(d.attended), pctCell(d.attended, totalSessions),
      ]);
    });
    const totals = devotees.reduce((a, d) => ({ at: a.at + d.attended }), { at: 0 });
    rows.push([
      { v: '', s: hdr }, { v: 'Grand Total', s: hdr }, { v: '', s: hdr }, { v: '', s: hdr }, { v: '', s: hdr },
      { v: totalSessions, s: hdr }, { v: totals.at, s: hdr }, { v: '', s: hdr },
    ]);

    const ws = _xlsSheet(rows.map(r => r.map(c => (c && 'v' in c) ? c : { v: c ?? '' })),
      [{ wch: 5 }, { wch: 26 }, { wch: 13 }, { wch: 18 }, { wch: 13 }, { wch: 9 }, { wch: 9 }, { wch: 6 }]);
    rows.forEach((row, r) => row.forEach((cell, c) => {
      if (cell?.s) { const addr = XLSX.utils.encode_cell({ r, c }); if (ws[addr]) ws[addr].s = cell.s; }
    }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Individual Report');
    XLSX.writeFile(wb, `Individual_Report_${range.start}_to_${range.end}.xlsx`);
    showToast('Downloaded!', 'success');
  } catch (e) {
    console.error('downloadIndividualReports', e);
    showToast('Failed: ' + (e.message || 'Error'), 'error');
  }
}

// ── COORDINATOR PERFORMANCE TAB (Attendance → Coordinator sub-tab) ──────────
// Moved from Home. Shows the full cross-team table (Called/Yes/Came/Target/%).
// Clicking a team bubble on the home leaderboard routes here with master Team
// filter pre-set, so the table scopes to that one team instantly.
let _cpInFlight = null;
async function loadCoordinatorPerformance() {
  if (_cpInFlight) return _cpInFlight;
  const el = document.getElementById('att-coordinator-content');
  if (!el) return;
  el.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';
  _cpInFlight = (async () => {
    try {
      const ctx = await _dashResolveContext();
      const key  = `${ctx.sessionId || ''}|${ctx.callingDate || ''}`;
      let data;
      if (_dashCache && _dashCache.key === key) {
        data = _dashCache.data;
      } else {
        data = await _dashFetchData(ctx);
        _dashCache = { key, data };
      }
      const sessLbl = ctx.sessionDate
        ? new Date(ctx.sessionDate + 'T00:00:00').toLocaleDateString('en-IN',
            { weekday:'short', day:'numeric', month:'short', year:'numeric' })
        : '— no session selected —';

      el.innerHTML = `
        <div class="cp-session-label"><i class="fas fa-calendar-check"></i> ${sessLbl}</div>
        <div id="dashboard-content" class="ds-card ds-card--flat dashboard-wrap"
             style="padding:var(--s-3);margin-top:var(--s-3)">
          <div class="loading"><i class="fas fa-spinner"></i></div>
        </div>`;
      _dashRender(data, ctx);
    } catch (e) {
      console.error('loadCoordinatorPerformance', e);
      if (el) el.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load</p></div>';
    } finally {
      _cpInFlight = null;
    }
  })();
  return _cpInFlight;
}
window.loadCoordinatorPerformance = loadCoordinatorPerformance;
window.addEventListener('filtersChanged', () => {
  if (AppState._attSubTab === 'coordinator') {
    _cpInFlight = null;
    loadCoordinatorPerformance();
  }
});
