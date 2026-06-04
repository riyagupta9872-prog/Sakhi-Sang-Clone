/* ══ UI-HOME.JS – Home tab ══ */

// ── HOME INIT ─────────────────────────────────────────
// Renders the greeting + smart hero CTA (today-aware) + sub-line + kicks
// off the My-Calling-Progress card and Today's-Activity report renderers.
// _dashRender (in ui-analytics.js) replaces the sub-line with richer detail
// once the dashboard fetch completes.
function loadHome() {
  const isSunday = new Date().getDay() === 0;

  // Sunday: show Coordinator Performance only (hide leaderboard).
  // Mon–Sat: show leaderboard only (hide Coordinator Performance).
  document.getElementById('home-lb-podium-section')?.classList.toggle('hidden', isSunday);
  document.getElementById('home-lb-table-section')?.classList.toggle('hidden', isSunday);
  document.getElementById('home-coord-section')?.classList.toggle('hidden', !isSunday);

  if (isSunday) {
    _loadHomeCoordinatorPerformance();
  } else {
    renderHomeLeaderboard();
  }
}

// Re-render when filters change (team / session).
// Debounced — switchTab fires filtersChanged immediately after loadHome(),
// so without debounce the leaderboard would animate twice.
let _lbFilterTimer = null;
window.addEventListener('filtersChanged', () => {
  if (document.querySelector('.tab-panel.active')?.id !== 'tab-dashboard') return;
  clearTimeout(_lbFilterTimer);
  _lbFilterTimer = setTimeout(loadHome, 350);
});

// Sunday: render the FULL Coordinator Performance on Home —
// (1) Session snapshot (ring + 4 stats + calling CTA) into home-coord-snap
// (2) Team table (Called/Yes/Came/Target/%) into home-coord-content
function _loadHomeCoordinatorPerformance() {
  const snapEl    = document.getElementById('home-coord-snap');
  const contentEl = document.getElementById('home-coord-content');
  if (!snapEl || !contentEl) return;
  contentEl.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';

  (async () => {
    try {
      // ── Part 1: session snapshot (ring + 4 stat tiles + calling CTA) ──
      // Reuse _renderAttendanceActivityTiles which renders the snap card HTML.
      if (typeof _renderAttendanceActivityTiles === 'function') {
        await _renderAttendanceActivityTiles(snapEl);
      }

      // ── Part 2: team table via _dashRender ──
      const ctx = await _dashResolveContext();
      const key = `${ctx.sessionId||''}|${ctx.callingDate||''}`;
      let data;
      if (typeof _dashCache !== 'undefined' && _dashCache?.key === key) {
        data = _dashCache.data;
      } else {
        data = await _dashFetchData(ctx);
        if (typeof _dashCache !== 'undefined') window._dashCache = { key, data };
      }
      // Swap ID so _dashRender writes into the home slot.
      contentEl.id = 'dashboard-content';
      _dashRender(data, ctx);
      contentEl.id = 'home-coord-content';
    } catch (e) {
      console.error('_loadHomeCoordinatorPerformance', e);
      if (contentEl) contentEl.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load</p></div>';
    }
  })();
}

// ═══════════════════════════════════════════════════════════════
// HOME LEADERBOARD — podium + heat strip + last 4 sessions
// Same for all roles. Clicking a team → Attendance → Coordinator.
// ═══════════════════════════════════════════════════════════════
const TEAM_COLORS = [
  '#e74c3c','#e67e22','#f1c40f','#2ecc71','#1abc9c',
  '#3498db','#9b59b6','#e91e63','#00bcd4','#8bc34a'
];
function _teamColor(idx) { return TEAM_COLORS[idx % TEAM_COLORS.length]; }

let _lbInFlight = false;
let _lbLastKey  = '';
let _lbLastRenderTime = 0;
const _LB_TTL   = 2 * 60 * 1000; // re-render after 2 min even if session unchanged
let _coordPicCache = null;   // { ts, data: { teamName → profilePic } }
const _COORD_PIC_TTL = 10 * 60 * 1000; // 10 min — photos rarely change

async function _getCoordPics() {
  if (_coordPicCache && Date.now() - _coordPicCache.ts < _COORD_PIC_TTL) {
    return _coordPicCache.data;
  }
  const snap = await fdb.collection('users').where('role', '==', 'teamAdmin').get();
  const data = {};
  snap.docs.forEach(d => { const u = d.data(); if (u.teamName && u.profilePic) data[u.teamName] = u.profilePic; });
  _coordPicCache = { ts: Date.now(), data };
  return data;
}
async function renderHomeLeaderboard() {
  if (_lbInFlight) return;
  const filterSession = (typeof getFilterSessionId === 'function') ? getFilterSessionId() : '';
  const renderKey = filterSession || 'latest';
  const now = Date.now();
  // Skip only when same session AND rendered recently (within TTL)
  if (renderKey === _lbLastKey && now - _lbLastRenderTime < _LB_TTL) return;
  _lbInFlight = true;
  _lbLastKey  = renderKey;
  _lbLastRenderTime = now;
  try {
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
    // teamFilter intentionally not used — leaderboard always shows all teams

    // ── Which session is the "anchor" for the podium? ──
    // If the user has selected a session in the master filter chip, use that
    // as the latest session for the podium ranking. Otherwise default to the
    // last completed Sunday before today.
    // Example: today = Thu 4 Jun 2026
    //   → no filter: anchor = 31 May 2026 (last completed Sunday)
    //   → filter = 17 May: anchor = 17 May 2026
    const filterSession = (typeof getFilterSessionId === 'function') ? getFilterSessionId() : null;
    const anchorDate = filterSession || todayStr;

    // ── Fetch last 4 sessions up to the anchor date ──
    const sessSnap = await fdb.collection('sessions')
      .where('sessionDate', '<=', anchorDate)
      .orderBy('sessionDate', 'desc').limit(4).get();
    const sessions = sessSnap.docs.map(d => ({ id: d.id, date: d.data().sessionDate })).reverse();

    if (!sessions.length) {
      document.getElementById('lb-podium').innerHTML = '<div class="empty-state"><i class="fas fa-calendar-times"></i><p>No sessions yet</p></div>';
      const lbt = document.getElementById('lb-table');
      if (lbt) lbt.innerHTML = '';
      return;
    }

    // ── Fetch attendance for all 4 sessions in one pass ──
    const [allDevotees, coordinatorPic] = await Promise.all([
      DevoteeCache.all(),
      _getCoordPics(),
    ]);
    const devTeamMap  = {};
    allDevotees.forEach(d => { devTeamMap[d.id] = d.teamName || ''; });

    const sessIds = sessions.map(s => s.id);
    // Firestore 'in' supports up to 10
    const attSnap = await fdb.collection('attendanceRecords').where('sessionId', 'in', sessIds).get();

    // attMap: sessionId → Set of devoteeIds present
    const attMap = {};
    sessIds.forEach(id => { attMap[id] = new Set(); });
    attSnap.docs.forEach(d => {
      const { sessionId, devoteeId } = d.data();
      if (attMap[sessionId]) attMap[sessionId].add(devoteeId);
    });

    // ── All teams — leaderboard is never filtered by team ──
    const inCalling = allDevotees.filter(d =>
      d.isActive !== false && !d.isNotInterested &&
      d.callingMode !== 'not_interested' && d.callingMode !== 'online' &&
      d.callingBy && d.callingBy.trim()
    );
    const totalInCalling = inCalling.length;

    // ── Build per-team stats for the LATEST session ──
    const latestSess = sessions[sessions.length - 1];
    const latestPresent = attMap[latestSess.id] || new Set();

    const teamsSet = new Set(allDevotees.map(d => d.teamName).filter(Boolean));
    const teams = [...teamsSet].sort();
    const teamIdx = {};
    teams.forEach((t, i) => { teamIdx[t] = i; });

    // Per-team: came count in latest session
    const teamCame = {};
    teams.forEach(t => { teamCame[t] = 0; });
    latestPresent.forEach(devId => {
      const t = devTeamMap[devId];
      if (t && teamCame[t] !== undefined) teamCame[t]++;
    });
    const totalCame = [...latestPresent].length;

    // Update header label — shows "Sun, 31 May 2026" (the anchor session)
    const lbLabel = document.getElementById('lb-session-label');
    if (lbLabel) {
      const d = new Date(latestSess.date + 'T00:00:00');
      lbLabel.textContent = d.toLocaleDateString('en-IN',
        { weekday:'short', day:'numeric', month:'short', year:'numeric' });
    }
    const totalCameEl = document.getElementById('lb-total-came');
    const totalCallEl = document.getElementById('lb-total-calling');
    if (totalCameEl) totalCameEl.textContent = totalCame;
    if (totalCallEl) totalCallEl.textContent = totalInCalling;

    // ── Sort teams by came (latest session) → podium ──
    const sorted = teams.slice().sort((a, b) => (teamCame[b] || 0) - (teamCame[a] || 0));
    const top3 = sorted.slice(0, 3);

    // ── Render podium ──
    // Reference style: light fill + thick border + initials inside the circle.
    // DOM order: [2nd-left, 1st-center, 3rd-right]. Heights via margin-bottom.
    // Each circle has inline width/height/border-radius to beat any CSS conflict.
    const podiumOrder = [top3[1]||null, top3[0]||null, top3[2]||null];
    const podiumRanks = [2, 1, 3];
    const RANK_STYLE = {
      1: { border:'#f59e0b', bg:'#fffbeb', numColor:'#92400e', mb:'48px', size:'120px', numSize:'2rem'  },
      2: { border:'#94a3b8', bg:'#f8fafc', numColor:'#1e3a8a', mb:'20px', size:'96px',  numSize:'1.6rem' },
      3: { border:'#cd7f32', bg:'#fff7ed', numColor:'#7c2d12', mb:'0px',  size:'82px',  numSize:'1.35rem'},
    };
    const MEDALS = {1:'🥇', 2:'🥈', 3:'🥉'};

    const podiumEl = document.getElementById('lb-podium');
    if (podiumEl) {
      podiumEl.innerHTML = podiumOrder.map((team, pos) => {
        if (!team) return `<div style="flex:1"></div>`;
        const rank  = podiumRanks[pos];
        const rs    = RANK_STYLE[rank];
        const came  = teamCame[team] || 0;
        const delay = rank===1 ? 400 : rank===2 ? 150 : 80;
        const sName = team.replace(/'/g,"\\'");
        const pic   = coordinatorPic[team] || null;

        const baseCircStyle = [
          `width:${rs.size}`, `height:${rs.size}`, `border-radius:50%`,
          `border:4px solid ${rs.border}`,
          `cursor:pointer`, `font-family:inherit`, `padding:0`,
          `box-shadow:0 6px 20px ${rs.border}55,0 2px 8px rgba(0,0,0,.12)`,
          `animation:lb-pop .65s cubic-bezier(.34,1.56,.64,1) both`,
          `animation-delay:${delay}ms`, `opacity:0`,
          `position:relative`, `overflow:hidden`,
        ];

        let circInner;
        if (pic) {
          // Photo fills the circle; count overlaid at bottom with gradient
          circInner = `
            <img src="${pic}" alt="${team}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:50%">
            <div style="position:absolute;inset:0;border-radius:50%;background:linear-gradient(transparent 40%,rgba(0,0,0,.62) 100%)"></div>
            <span style="position:absolute;top:6px;right:6px;font-size:.7rem;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))">${MEDALS[rank]}</span>
            <div style="position:absolute;bottom:10%;left:0;right:0;display:flex;flex-direction:column;align-items:center;gap:1px">
              <span style="font-family:'Cinzel',serif;font-weight:900;font-size:${rs.numSize};color:#fff;line-height:1;text-shadow:0 1px 4px rgba(0,0,0,.7)">${came}</span>
              <span style="font-size:.55rem;font-weight:700;color:rgba(255,255,255,.85);text-shadow:0 1px 3px rgba(0,0,0,.6)">came</span>
            </div>`;
          baseCircStyle.push(`background:${rs.bg}`, `display:flex`, `flex-direction:column`, `align-items:center`, `justify-content:center`);
        } else {
          circInner = `
            <span style="font-size:.75rem;line-height:1">${MEDALS[rank]}</span>
            <span style="font-family:'Cinzel',serif;font-weight:900;font-size:${rs.numSize};color:${rs.numColor};line-height:1">${came}</span>
            <span style="font-size:.6rem;font-weight:700;color:${rs.numColor};opacity:.7">came</span>`;
          baseCircStyle.push(`background:${rs.bg}`, `display:flex`, `flex-direction:column`, `align-items:center`, `justify-content:center`, `gap:2px`);
        }

        return `<div style="display:flex;flex-direction:column;align-items:center;gap:6px;margin-bottom:${rs.mb}">
          <button style="${baseCircStyle.join(';')}" onclick="_lbOpenTeam('${sName}')">
            ${circInner}
          </button>
          <div style="text-align:center">
            <div style="font-weight:800;font-size:.82rem;color:#1a1a1a;line-height:1.2">${team}</div>
          </div>
        </div>`;
      }).join('');
      setTimeout(() => _lbConfetti(podiumEl), 700);
    }

    // ── Per-team counts ──
    // teamInCalling: used for cell colour (shows coverage of active calling list)
    // teamSize: used for Avg% denominator (all active devotees in team)
    const teamInCalling = {};
    const teamSize = {};
    teams.forEach(t => {
      teamInCalling[t] = allDevotees.filter(d =>
        d.teamName === t && d.isActive !== false && !d.isNotInterested &&
        d.callingMode !== 'not_interested' && d.callingMode !== 'online' &&
        d.callingBy && d.callingBy.trim()
      ).length || 1;
      teamSize[t] = allDevotees.filter(d =>
        d.teamName === t && d.isActive !== false
      ).length || 1;
    });

    // ── ONE TABLE: teams × sessions ──
    // Rows sorted by latest-session came (desc) — matches the podium ranking.
    // Columns = sessions oldest → newest. Each cell: came count + colour dot.
    const tableEl = document.getElementById('lb-table');
    if (tableEl) {
      const colHdrs = sessions.map(s => {
        const d = new Date(s.date + 'T00:00:00');
        return `<th>${d.toLocaleDateString('en-IN',{day:'numeric',month:'short'})}</th>`;
      }).join('');

      const tableRows = sorted.map((team, rank) => {
        const color = _teamColor(teamIdx[team] || 0);
        const sName = team.replace(/'/g, "\\'");
        let totalCame = 0;
        const cells = sessions.map(sess => {
          const presentSet = attMap[sess.id] || new Set();
          const came = [...presentSet].filter(id => devTeamMap[id] === team).length;
          totalCame += came;
          const numColor = came >= 13 ? '#16a34a' : came >= 10 ? '#d97706' : '#dc2626';
          return `<td class="lb-td" style="color:${numColor};font-weight:700">${came}</td>`;
        }).join('');

        // Avg = total came across sessions ÷ number of sessions
        const avg = sessions.length ? Math.round(totalCame / sessions.length) : 0;
        const avgColor = avg >= 15 ? '#16a34a' : avg >= 8 ? '#b45309' : '#dc2626';

        const medal = rank === 0 ? '🥇' : rank === 1 ? '🥈' : rank === 2 ? '🥉' : '';
        return `<tr class="lb-tr" onclick="_lbOpenTeam('${sName}')">
          <td class="lb-sno-cell">${rank + 1}</td>
          <td class="lb-team-cell" style="border-left:3px solid ${color}">
            ${medal} ${team}
          </td>
          ${cells}
          <td class="lb-td lb-avg-td" style="color:${avgColor};font-weight:800;background:#f9f6ee">${avg}</td>
        </tr>`;
      }).join('');

      // Total row
      const totalCells = sessions.map(sess => {
        const n = attMap[sess.id]?.size || 0;
        return `<td class="lb-td lb-total-td"><strong>${n}</strong></td>`;
      }).join('');
      const overallTotal = sessions.reduce((s, sess) => s + (attMap[sess.id]?.size || 0), 0);
      const overallAvg = sessions.length ? Math.round(overallTotal / sessions.length) : 0;
      const overallAvgColor = overallAvg >= 15 ? '#16a34a' : overallAvg >= 8 ? '#b45309' : '#dc2626';

      tableEl.innerHTML = `
        <div class="table-scroll">
          <table class="lb-table">
            <thead><tr>
              <th class="lb-sno-hdr">#</th>
              <th class="lb-team-hdr">Team</th>${colHdrs}
              <th style="font-style:italic">Avg</th>
            </tr></thead>
            <tbody>${tableRows}</tbody>
            <tfoot><tr>
              <td class="lb-sno-cell"></td>
              <td class="lb-team-cell lb-total-td">Total</td>${totalCells}
              <td class="lb-td lb-total-td lb-avg-td" style="color:${overallAvgColor};font-weight:800">${overallAvg}</td>
            </tr></tfoot>
          </table>
        </div>`;
    }
  } catch (e) {
    console.error('renderHomeLeaderboard', e);
    ['lb-podium','lb-table'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load</p></div>';
    });
  } finally {
    _lbInFlight = false;
  }
}

// Clicking a team bubble → open Coordinator Performance filtered to that team.
function _lbOpenTeam(team) {
  if (team) dispatchFilters({ team });
  navTabView('attendance', 'coordinator');
}
window._lbOpenTeam = _lbOpenTeam;

// Confetti burst — pure CSS particles injected around the podium.
function _lbConfetti(container) {
  const colors = ['#f59e0b','#ef4444','#3b82f6','#22c55e','#a855f7','#ec4899','#f97316'];
  const shapes = ['●', '■', '▲', '◆'];
  const rect = container.getBoundingClientRect();
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 36; i++) {
    const p = document.createElement('span');
    p.className = 'lb-confetti';
    p.textContent = shapes[i % shapes.length];
    const x = 20 + Math.random() * 60;              // % across the container
    const dur = 700 + Math.random() * 600;
    const delay = Math.random() * 300;
    const drift = (Math.random() - 0.5) * 120;
    p.style.cssText = `left:${x}%;animation-duration:${dur}ms;animation-delay:${delay}ms;
      color:${colors[i % colors.length]};--drift:${drift}px`;
    frag.appendChild(p);
  }
  container.style.position = 'relative';
  container.appendChild(frag);
  setTimeout(() => container.querySelectorAll('.lb-confetti').forEach(p => p.remove()), 1500);
}

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
// Sunday   → 4 stat tiles (In calling | Coming | Came | Said-coming Absent)
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
          <button class="snap__stat snap__stat--noshow" onclick="openHomeSnapList('saidComing')"><span class="snap__stat-num">${noShowList.length}</span><span class="snap__stat-lbl">Absent</span></button>
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
    came: 'Attended (Came)', saidComing: 'Said Coming · Absent',
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
