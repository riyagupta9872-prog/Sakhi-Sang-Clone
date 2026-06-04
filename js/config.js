/* ══ CONFIG.JS – Firebase, AppState, constants, utilities ══ */

// ── FIREBASE INIT ─────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyCxxLIiOy0bGus2NkkSod7_LBVHah5-sz0",
  authDomain: "sakhi-sang-attendence-tracker.firebaseapp.com",
  projectId: "sakhi-sang-attendence-tracker",
  storageBucket: "sakhi-sang-attendence-tracker.firebasestorage.app",
  messagingSenderId: "975645795932",
  appId: "1:975645795932:web:10123086717198940b2899"
};
firebase.initializeApp(firebaseConfig);
const fdb = firebase.firestore();
const TS  = () => firebase.firestore.FieldValue.serverTimestamp();
const INC = (n) => firebase.firestore.FieldValue.increment(n);
fdb.enablePersistence({ synchronizeTabs: true }).catch(err => {
  if (err.code === 'failed-precondition') {
    console.warn('[Sakhi Sang] Offline persistence disabled (multiple tabs open)');
  } else if (err.code === 'unimplemented') {
    console.warn('[Sakhi Sang] Offline persistence not supported in this browser');
  }
});

// Recover from Firestore SDK internal assertion errors (known bug with multi-tab persistence).
// When this happens the SDK is in an unrecoverable state — a reload is the only fix.
function _isFirestoreAssertionError(msg) {
  return typeof msg === 'string' && msg.includes('INTERNAL ASSERTION FAILED');
}
window.addEventListener('unhandledrejection', e => {
  if (_isFirestoreAssertionError(e.reason?.message)) {
    console.warn('[Sakhi Sang] Firestore internal error — reloading to recover');
    setTimeout(() => location.reload(), 600);
  }
});
window.addEventListener('error', e => {
  if (_isFirestoreAssertionError(e.message)) {
    console.warn('[Sakhi Sang] Firestore internal error — reloading to recover');
    setTimeout(() => location.reload(), 600);
  }
});

// ── APP STATE ─────────────────────────────────────────
const AppState = {
  currentTab: 'devotees',
  // Legacy single-session ids — kept as live aliases so existing code paths
  // (DB.getSessionStats, markPresent, etc.) keep working unchanged. They mirror
  // AppState.filters.sessionId via the derived getters defined below.
  // _currentSessionId / _currentReportSessionId hold the actual storage; the
  // public names redirect through Object.defineProperty further down.
  _currentSessionId: null,
  _currentReportSessionId: null,
  currentDevoteeId: null,
  currentEventId: null,
  trendsChart: null,
  callingData: [],
  fromAttendance: false,
  attendanceCandidates: {},
  sessionsCache: {},     // sessionId → session object
  isAttSevaDev: false,  // extra flag: can access live attendance of all teams (set by superAdmin per user)
  // ── DELEGATION FLAGS ── per-user "super-admin lite" powers (set by superAdmin per user)
  canAllTeamCalling: false,  // can submit/edit calling on behalf of any team
  canAllTeamReports: false,  // can view reports across all teams
  canManageAllTeams: false,  // full write access app-wide (lite super admin)
  // Auth
  userRole: null,       // 'superAdmin' | 'teamAdmin' | 'serviceDevotee'
  userTeam: null,       // team name for coordinators
  userPosition: null,   // free-text position from user profile (e.g. 'Facilitator')
  userName: '',
  userId: null,
  profilePic: null,            // base64 string or null

  // ── MASTER FILTER STATE ─────────────────────────────────
  // Single source of truth for context filters (Session / Team / Calling By).
  // Every tab's load* function reads from here. Per-tab content filters
  // (search boxes, status dropdowns) stay local.
  filters: {
    sessionId:     null,    // canonical session date 'YYYY-MM-DD'
    team:          '',       // '' = All teams
    callingBy:     '',       // '' = All callers
    period:        'session',// 'session'|'month'|'quarter'|'fy' (Reports-only)
    periodAnchor:  null,    // 'YYYY-MM-DD' anchor for period aggregation
  },
};

// ── FILTER ALIASES ─────────────────────────────────────
// Existing DB.* calls reference AppState.currentSessionId and
// AppState.currentReportSessionId. We keep both as derived aliases off the
// new master filter so nothing else needs touching during scaffolding.
Object.defineProperty(AppState, 'currentSessionId', {
  get() { return this._currentSessionId; },
  set(v) {
    // Only stores the Firestore doc ID. filters.sessionId (the date string) is
    // managed exclusively by dispatchFilters — never write the doc ID there.
    this._currentSessionId = v;
  },
  configurable: true,
});
Object.defineProperty(AppState, 'currentReportSessionId', {
  get() { return this._currentReportSessionId || this._currentSessionId; },
  set(v) {
    this._currentReportSessionId = v;
  },
  configurable: true,
});

// ── FILTER DISPATCHER ──────────────────────────────────
// Single mutator for the master filter. Validates, derives, fires the
// 'filtersChanged' event. Tabs subscribe with one listener and re-render only
// when they're the visible tab.
//
// Patch shape: { sessionId, team, callingBy, period, periodAnchor }
function dispatchFilters(patch) {
  const f = AppState.filters;
  if (!f) return;
  const before = { ...f };

  if (patch.sessionId !== undefined) {
    f.sessionId = patch.sessionId || null;
    if (f.sessionId && !f.periodAnchor) f.periodAnchor = f.sessionId;
    // _currentSessionId holds the Firestore doc ID for DB calls (attendance, etc.)
    // filters.sessionId holds the canonical date string for display and calling/care queries.
    const docId = patch._sessionDocId || f.sessionId;
    AppState._currentSessionId       = docId;
    AppState._currentReportSessionId = docId;
    if (patch._sessionDocId && f.sessionId && !AppState.sessionsCache[patch._sessionDocId]) {
      AppState.sessionsCache[patch._sessionDocId] = {
        id: patch._sessionDocId, session_date: f.sessionId, topic: '', is_cancelled: false
      };
    }
  }
  if (patch.team !== undefined) {
    // Team-locked roles cannot change away from their assigned team — EXCEPT on
    // the Devotees tab, where every admin browses all teams' data. Reports and
    // logging tabs stay team-scoped for teamAdmin.
    //
    // Derive "are we on Devotees?" from the visible DOM panel (not from
    // AppState.currentTab) — that variable drifts when the user navigates via
    // browser back, history restore, or any path that toggles .tab-panel.active
    // without going through switchTab. The drift was the root cause of
    // coordinators seeing other teams' data on the dashboard.
    let onDevoteesTab;
    if (typeof document !== 'undefined') {
      const activePanel = document.querySelector('.tab-panel.active');
      onDevoteesTab = activePanel
        ? activePanel.id === 'tab-devotees'
        : AppState.currentTab === 'devotees';
    } else {
      onDevoteesTab = AppState.currentTab === 'devotees';
    }
    // Team-locked unless: super admin, has a cross-team permission flag, or
    // currently on the Devotees tab (where every admin browses all teams).
    const unlocked = isSuperAdmin() || canChangeTeamFilter() || onDevoteesTab;
    if (AppState.userRole && AppState.userTeam && !unlocked) {
      f.team = AppState.userTeam;
    } else {
      f.team = patch.team || '';
    }
  }
  if (patch.callingBy !== undefined) {
    f.callingBy = patch.callingBy || '';
  }
  if (patch.period !== undefined) {
    f.period = patch.period || 'session';
  }
  if (patch.periodAnchor !== undefined) {
    f.periodAnchor = patch.periodAnchor || null;
  }

  // Skip the event if nothing actually changed (mirrors from legacy widgets
  // can fire spuriously).
  const changed = ['sessionId','team','callingBy','period','periodAnchor']
    .some(k => before[k] !== f[k]);
  if (!changed) return;

  try {
    window.dispatchEvent(new CustomEvent('filtersChanged', { detail: { ...f, before } }));
  } catch (_) {}
}

// Convenience read helpers — used by tab code.
function getFilterTeam()      { return AppState.filters?.team      || ''; }
function getFilterCallingBy() { return AppState.filters?.callingBy || ''; }
function getFilterSessionId() { return AppState.filters?.sessionId || null; }

// ── ROLE / PERMISSION HELPERS ──────────────────────────
// These are the canonical checks. Use them everywhere instead of raw role
// equality so the new delegation flags (canAllTeamCalling / canAllTeamReports
// / canManageAllTeams) automatically apply.
function isSuperAdmin()         { return AppState.userRole === 'superAdmin'; }
function isCoordinator()        { return AppState.userRole === 'teamAdmin'; }
function isFacilitator()        { return AppState.userRole === 'serviceDevotee'; }
function isAdminOrCoord()       { return isSuperAdmin() || isCoordinator(); }
// canCrossTeamCalling = can submit calling for ANY team (not just their own).
// True for super admin, anyone with canAllTeamCalling, or canManageAllTeams.
function canCrossTeamCalling()  { return isSuperAdmin() || !!AppState.canAllTeamCalling || !!AppState.canManageAllTeams; }
function canCrossTeamReports()  { return isSuperAdmin() || !!AppState.canAllTeamReports || !!AppState.canManageAllTeams; }
function canCrossTeamManage()   { return isSuperAdmin() || !!AppState.canManageAllTeams; }
// "Can the user freely change the Team filter chip?" — yes if they can see
// reports for all teams OR manage all teams OR are super admin.
function canChangeTeamFilter()  { return canCrossTeamReports() || canCrossTeamManage() || canCrossTeamCalling(); }

// ── TEAMS LIST (single source of truth) ───────────────
const TEAMS = ['Champaklata','Chitralekha','Indulekha','Lalita','Nilachal','Other','Rangadevi','Sudevi','Tungavidya','Vishakha'];

// ── ATTENDANCE TIME COLOUR ─────────────────────────────
function attTimeStyle(markedAtISO) {
  if (!markedAtISO) return { card: '', badge: '' };
  const d = new Date(markedAtISO);
  const mins = d.getHours() * 60 + d.getMinutes();
  const t1230 = 12 * 60 + 30, t1245 = 12 * 60 + 45, t1300 = 13 * 60;
  if (mins >= t1300) return { card: 'background:#c62828;color:#fff', badge: 'color:#fff' };
  if (mins >= t1245) return { card: 'background:#ef9a9a', badge: '' };
  if (mins >= t1230) return { card: 'background:#ffcdd2', badge: '' };
  return { card: '', badge: '' };
}

// ── DATE UTILITIES ─────────────────────────────────────
function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function getToday() { return localDateStr(new Date()); }
function getCurrentSunday() {
  const now = new Date(), day = now.getDay();
  const sun = new Date(now); sun.setDate(now.getDate() - day);
  return localDateStr(sun);
}
function getUpcomingSunday() {
  const now = new Date(), day = now.getDay();
  const daysUntilSunday = day === 0 ? 0 : 7 - day;
  const sun = new Date(now); sun.setDate(now.getDate() + daysUntilSunday);
  return localDateStr(sun);
}
function getCallingWeekDefault() {
  return getUpcomingSunday();
}
function snapToSunday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const day = dt.getDay();
  if (day === 0) return dateStr;
  dt.setDate(dt.getDate() + (7 - day));
  return localDateStr(dt);
}
function initials(name = '') { return name.split(' ').slice(0, 2).map(w => w[0]?.toUpperCase() || '').join(''); }
function formatDate(iso) {
  if (!iso || typeof iso !== 'string') return '—';
  // Accept either YYYY-MM-DD or full ISO; reject anything else cleanly so we
  // never render "Invalid Date" to the user.
  const isYmd = /^\d{4}-\d{2}-\d{2}/.test(iso);
  const d = isYmd ? new Date(iso.slice(0, 10) + 'T00:00:00') : new Date(iso);
  if (!d || isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}
function formatBirthday(dob) {
  if (!dob || typeof dob !== 'string') return '';
  const m = dob.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  const mi = parseInt(m[2], 10);
  const di = parseInt(m[3], 10);
  if (!mi || !di || mi < 1 || mi > 12) return '';
  return `${di} ${'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')[mi - 1]}`;
}
function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!d || isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function isBirthdayWeek(dob) {
  if (!dob) return false;
  const now = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(now); d.setDate(now.getDate() + i);
    if (dob.slice(5) === `${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`) return true;
  }
  return false;
}

// ── FORMAT HELPERS ─────────────────────────────────────
// "Expected to be Serious" is stored verbatim in Firestore for backward
// compatibility, but we always render it as the short label "ETS".
function shortStatus(s) {
  if (!s || s === 'Expected to be Serious') return 'ETS';
  return s;
}
function statusBadge(s) {
  const label = shortStatus(s);
  if (s === 'Most Serious') return `<span class="badge badge-most-serious">${label}</span>`;
  if (s === 'Serious')      return `<span class="badge badge-serious">${label}</span>`;
  if (s === 'New Devotee')  return `<span class="badge badge-new-devotee">${label}</span>`;
  if (s === 'Inactive')     return `<span class="badge badge-inactive">${label}</span>`;
  return `<span class="badge badge-expected">${label}</span>`;
}
function teamBadge(t) { return t ? `<span class="badge badge-team">${t}</span>` : ''; }

// Inline tags shown right after a devotee's name across the app:
//   © circle → has had a completed personal meeting with Prabhuji
//   "New"    → devotee_status is "New Devotee"
// Accepts either snake_case (from DevoteeCache) or camelCase (form/state) shapes.
function nameTags(d) {
  if (!d) return '';
  const met    = (d.met_prabhuji === true) || (d.metPrabhuji === true);
  const status = d.devotee_status || d.devoteeStatus || '';
  const isNew  = /new/i.test(status);
  let html = '';
  if (met)   html += '<span class="met-badge" title="Met Prabhuji">C</span>';
  if (isNew) html += '<span class="new-tag" title="New devotee">New</span>';
  return html;
}

// Calling submission window state. OPEN is MANUAL (Session Config toggle), but
// it AUTO-CLOSES at 11:59 PM on the calling date (Saturday night). An admin can
// also close it early by turning the toggle off. Returns true only while the
// window is effectively open.
function isCallingWindowOpen(cfg) {
  if (!cfg || cfg.callingWindowOpen !== true) return false;
  const cd = cfg.callingDate;
  if (!cd) return true;                       // manually open, no date to gate against
  const deadline = new Date(cd + 'T23:59:59'); // Saturday 11:59 PM local
  return new Date() <= deadline;
}
// contactIcons(mobile) → direct call/whatsapp links (single number).
// contactIcons(mobile, { altMobile, devoteeId, name }) → if altMobile is also
// present, the icons instead open the number-picker modal so the user can
// choose which number (and can promote the alt to primary).
function contactIcons(mobile, opts) {
  const altMobile = (opts && opts.altMobile) || '';
  const devoteeId = (opts && opts.devoteeId) || '';
  const name      = (opts && opts.name)      || '';
  const primary   = (mobile || '').replace(/\D/g, '');
  const alt       = (altMobile || '').replace(/\D/g, '');
  if (!primary && !alt) return '';

  // Only one number available → direct links (original behaviour)
  if (!primary || !alt) {
    const c  = primary || alt;
    const wa = c.length === 10 ? '91' + c : c;
    return `<div class="contact-icons">
      <a href="tel:${c}" class="contact-icon icon-phone" onclick="event.stopPropagation()" title="Call"><i class="fas fa-phone-alt"></i></a>
      <a href="https://wa.me/${wa}" target="_blank" rel="noopener" class="contact-icon icon-whatsapp" onclick="event.stopPropagation()" title="WhatsApp"><i class="fab fa-whatsapp"></i></a>
    </div>`;
  }

  // Both numbers present → open the chooser modal
  const sName = name.replace(/'/g, "\\'");
  return `<div class="contact-icons">
    <button class="contact-icon icon-phone" onclick="event.stopPropagation(); openNumberPicker('${devoteeId}','${sName}','${primary}','${alt}')" title="Call"><i class="fas fa-phone-alt"></i><span class="contact-dual">2</span></button>
    <button class="contact-icon icon-whatsapp" onclick="event.stopPropagation(); openNumberPicker('${devoteeId}','${sName}','${primary}','${alt}')" title="WhatsApp"><i class="fab fa-whatsapp"></i><span class="contact-dual">2</span></button>
  </div>`;
}

// Number-picker modal — lets user call/WhatsApp either number AND optionally
// promote the alt to primary. Anyone (caller / coordinator / super admin) can
// swap if they have edit rights; the swap just toggles the two fields in Firestore.
function openNumberPicker(devoteeId, name, mobile, altMobile) {
  const c = document.getElementById('np-content');
  if (!c) return;
  document.getElementById('np-devotee-id').value = devoteeId || '';
  document.getElementById('np-name').textContent = name || 'Devotee';

  function rowHtml(num, isPrimary) {
    if (!num) return '';
    const wa = num.length === 10 ? '91' + num : num;
    const tag = isPrimary
      ? '<span class="np-tag np-primary"><i class="fas fa-star"></i> Primary</span>'
      : '<span class="np-tag np-alt">Alternate</span>';
    const promote = isPrimary
      ? ''
      : `<button class="btn btn-secondary np-promote" onclick="makePrimaryNumber()"><i class="fas fa-star"></i> Make Primary</button>`;
    return `<div class="np-row">
      <div class="np-head">${tag} <strong class="np-num">${num}</strong></div>
      <div class="np-actions">
        <a href="tel:${num}" class="btn btn-primary np-call"><i class="fas fa-phone-alt"></i> Call</a>
        <a href="https://wa.me/${wa}" target="_blank" rel="noopener" class="btn np-wa"><i class="fab fa-whatsapp"></i> WhatsApp</a>
        ${promote}
      </div>
    </div>`;
  }
  c.innerHTML = rowHtml(mobile, true) + rowHtml(altMobile, false);
  openModal('number-picker-modal');
}

async function makePrimaryNumber() {
  const id = document.getElementById('np-devotee-id').value;
  if (!id) return;
  try {
    const d = await DB.getDevotee(id);
    const oldPrimary = d.mobile;
    const oldAlt     = d.mobile_alt;
    await DB.updateDevotee(id, {
      ...d,
      mobile:     oldAlt || '',
      mobile_alt: oldPrimary || '',
    });
    DevoteeCache.bust();
    closeModal('number-picker-modal');
    showToast('Primary number updated!', 'success');
    // Refresh whichever view is current
    if (typeof loadDevotees === 'function'        && AppState.currentTab === 'devotees')     loadDevotees();
    if (typeof loadCallingStatus === 'function'   && AppState.currentTab === 'calling')      loadCallingStatus();
    if (typeof loadCallingMgmtTab === 'function'  && AppState.currentTab === 'calling-mgmt') loadCallingMgmtTab();
    if (typeof loadCareData === 'function'        && AppState.currentTab === 'care')         loadCareData();
  } catch (e) {
    showToast('Failed: ' + (e.message || 'Error'), 'error');
  }
}

// ── UI HELPERS ─────────────────────────────────────────
let _toastTimer;
function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast' + (type ? ' ' + type : '');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.add('hidden'), 3000);
}
function debounce(fn, ms) {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
// Back-button support: keep one history entry while any overlay is open.
// When the user taps Back, close every open overlay at once.
let _overlayHistoryPushed = false;
function _ensureOverlayHistory() {
  if (!_overlayHistoryPushed) {
    try { history.pushState({ overlay: true }, '', location.href); } catch (_) {}
    _overlayHistoryPushed = true;
  }
}

function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('hidden');
  _ensureOverlayHistory();
}
function closeModal(id) {
  document.getElementById(id)?.classList.add('hidden');
}
function openImportModal() { openModal('import-modal'); }

window.addEventListener('popstate', () => {
  let closedAny = false;
  document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(m => {
    m.classList.add('hidden'); closedAny = true;
  });
  const sb = document.getElementById('app-sidebar');
  if (sb?.classList.contains('open')) {
    sb.classList.remove('open');
    document.getElementById('sidebar-overlay')?.classList.add('hidden');
    closedAny = true;
  }
  if (typeof _cmSelectMode !== 'undefined' && _cmSelectMode) {
    _exitCMSelectMode?.(); closedAny = true;
  }
  _overlayHistoryPushed = false;
  // If nothing was closed, let the browser actually navigate back next time
});

// ── DEVOTEE CACHE (5-minute TTL) ─────────────────────
// Writes call DevoteeCache.bust() so edits show up instantly. The TTL only
// controls passive refreshes, and the devotee list changes only a few times
// per day — 5 min avoids re-fetching on every casual tab switch.
//
// bust() ALSO invalidates dependent caches (dashboard, care, calling-mgmt)
// because all three derive their aggregates from devotee data. Without this
// chain, a devotee edit would leave the dashboard showing stale numbers
// until the user manually refreshed.
const DevoteeCache = {
  raw: [], stamp: 0, TTL: 300000,
  _inflight: null,   // deduplicates concurrent refresh calls → 1 Firestore read
  async refresh() {
    if (this._inflight) return this._inflight;
    this._inflight = (async () => {
      try {
        const snap = await fdb.collection('devotees').where('isActive', '==', true).get();
        this.raw = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        this.raw.sort((a, b) => a.name.localeCompare(b.name));
        this.stamp = Date.now();
        return this.raw;
      } finally {
        this._inflight = null;
      }
    })();
    return this._inflight;
  },
  async all(force = false) {
    if (force || Date.now() - this.stamp > this.TTL) return this.refresh();
    return this.raw;
  },
  bust() {
    this.stamp = 0;
    this._inflight = null;
    if (typeof _bustDashboardCache === 'function') _bustDashboardCache();
    if (typeof _bustCareCache      === 'function') _bustCareCache();
    if (typeof _bustCMCache        === 'function') _bustCMCache();
  }
};
