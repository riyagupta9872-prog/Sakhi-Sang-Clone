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

  // Smart hero CTA — adapts to today's day-of-week.
  const cta = document.querySelector('.ss-home-hero-cta');
  if (cta) {
    const dayIdx = new Date().getDay();
    let label, icon, target;
    if (dayIdx === 0) {
      label = "Mark today's attendance"; icon = 'fa-check-circle'; target = ['attendance', 'live'];
    } else if (dayIdx === 6) {
      label = 'Continue calling';        icon = 'fa-phone-alt';    target = ['calling', 'calls'];
    } else {
      label = 'Open calling list';       icon = 'fa-headset';      target = ['calling', 'calls'];
    }
    cta.innerHTML = `<i class="fas ${icon}"></i> ${label} <i class="fas fa-arrow-right ss-home-cta-arrow"></i>`;
    cta.onclick = () => navTabView(target[0], target[1]);
  }

  // Kick off the two new sections (don't await — they update DOM independently).
  renderMyCallingProgress();
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
    renderMyCallingProgress();
    renderTodaysActivity();
  } finally {
    if (icon) icon.classList.remove('fa-spin');
  }
}
window.refreshDashboard = refreshDashboard;

// ══════════════════════════════════════════════════════
// MY CALLING PROGRESS
// Shown only for users with a personal calling list (callingBy = userName).
// Shows: streak chip · called · coming · target % ring · submit state.
// ══════════════════════════════════════════════════════
async function renderMyCallingProgress() {
  const card = document.getElementById('ss-my-calling-progress');
  if (!card) return;

  try {
    // Resolve current calling week (Saturday). Defaults to today's previous Sat.
    const cfg = await DB.getCallingWeekConfig().catch(() => null);
    const weekDate = cfg?.callingDate || _saturdayBefore(new Date());
    if (!weekDate) { card.classList.add('hidden'); return; }

    // User's personal calling list for THIS week.
    const myList = await DB.getCallingStatus(weekDate).catch(() => []);
    if (!myList || !myList.length) { card.classList.add('hidden'); return; }

    card.classList.remove('hidden');

    const total  = myList.length;
    const called = myList.filter(d => d.coming_status || d.calling_reason || d.calling_notes).length;
    const coming = myList.filter(d => d.coming_status === 'Yes').length;

    // Target — from attendance targets (per-team override or global).
    let target = total;
    try {
      const cfg = await DB.getAttendanceTargets();
      if (cfg) {
        const teamTarget = cfg.teams?.[AppState.userTeam || ''];
        target = teamTarget > 0 ? teamTarget : (cfg.global > 0 ? cfg.global : total);
      }
    } catch (_) {}
    const targetPct = target > 0 ? Math.min(100, Math.round((coming / target) * 100)) : 0;

    // Streak — consecutive weeks (from today back) this user has submitted.
    const streak = await _computeCallingStreak(AppState.userId).catch(() => 0);

    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('ss-my-streak-num', streak);
    set('ss-my-called',     called);
    set('ss-my-coming',     coming);
    set('ss-my-ring-pct',   targetPct + '%');

    const ring = document.getElementById('ss-my-ring-circle');
    if (ring) {
      ring.setAttribute('stroke-dasharray', `${targetPct} ${100 - targetPct}`);
      ring.classList.remove('ring-low','ring-mid','ring-good');
      ring.classList.add(targetPct >= 80 ? 'ring-good' : targetPct >= 50 ? 'ring-mid' : 'ring-low');
    }

    // Submit state — has this user submitted for this week?
    const mySub = await DB.getMyCallingSubmission(weekDate, AppState.userId).catch(() => null);
    const foot = document.getElementById('ss-my-progress-foot');
    if (foot) {
      if (mySub && mySub.submittedAtClient) {
        const t = new Date(mySub.submittedAtClient);
        const timeLbl = t.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
        const dayLbl  = t.toLocaleDateString('en-IN', { weekday: 'short' });
        foot.innerHTML = `<div class="ss-my-submitted-box">
          <i class="fas fa-check-circle"></i> Submitted
          <span class="ss-my-submitted-time">${dayLbl} ${timeLbl}</span>
        </div>`;
      } else {
        foot.innerHTML = `
          <div class="ss-my-foot-bar"><i class="fas fa-clock"></i> Submit your calling by 9:00 PM</div>
          <button class="ss-my-cta" onclick="navTabView('calling','calls')">
            <i class="fas fa-phone-alt"></i> Continue calling
            <i class="fas fa-arrow-right"></i>
          </button>`;
      }
    }
  } catch (e) {
    console.error('renderMyCallingProgress', e);
    card.classList.add('hidden');
  }
}

// When master filter changes (team / session / calling-by), the home sections
// that depend on it should re-render. The dashboard table is handled by
// _mfbOnFiltersChanged → loadDashboard; this listener catches the home sections.
window.addEventListener('filtersChanged', () => {
  const activePanel = document.querySelector('.tab-panel.active');
  if (activePanel?.id !== 'tab-dashboard') return;
  renderMyCallingProgress();
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
  try {
    if (dayIdx === 6) {
      // SATURDAY: calling day
      if (title) title.textContent = 'Calling Activity Today';
      if (link)  link.textContent  = 'Team Calling';
      if (icon)  icon.className    = 'fas fa-phone-alt';
      if (linkEl) linkEl.onclick = () => navTabView('calling','team-calling');
      await _renderCallingActivityTable(wrap);
    } else if (dayIdx === 0) {
      // SUNDAY: class day
      if (title) title.textContent = 'Class Attendance Today';
      if (link)  link.textContent  = 'Attendance';
      if (icon)  icon.className    = 'fas fa-users';
      if (linkEl) linkEl.onclick = () => navTabView('attendance','live');
      await _renderAttendanceActivityTiles(wrap);
    } else {
      // Other days — show last Sunday's snapshot
      if (title) title.textContent = 'Last Session Snapshot';
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
  // Resolve session — current Sunday OR latest past Sunday
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  let sessionDate;
  let sessionId;
  if (today.getDay() === 0) {
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

  const totalCalling = inCalling.length;
  const comingCount  = inCalling.filter(d => csByDev[d.id]?.comingStatus === 'Yes').length;
  const cameCount    = inCalling.filter(d => presentSet.has(d.id)).length;
  const noShowCount  = inCalling.filter(d => csByDev[d.id]?.comingStatus === 'Yes' && !presentSet.has(d.id)).length;

  wrap.innerHTML = `
    <div class="ss-act-grid">
      <div class="ss-act-tile"><div class="ss-act-tile-num">${totalCalling}</div><div class="ss-act-tile-lbl">In calling</div></div>
      <div class="ss-act-tile coming"><div class="ss-act-tile-num">${comingCount}</div><div class="ss-act-tile-lbl">Coming</div></div>
      <div class="ss-act-tile came"><div class="ss-act-tile-num">${cameCount}</div><div class="ss-act-tile-lbl">Came</div></div>
      <div class="ss-act-tile noshow"><div class="ss-act-tile-num">${noShowCount}</div><div class="ss-act-tile-lbl">Said coming · no-show</div></div>
    </div>`;
}

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
