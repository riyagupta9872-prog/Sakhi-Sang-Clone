# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> This is the **Sakhi-Sang** variant of a family of spiritual-practice tracker apps. See [`../CLAUDE.md`](../CLAUDE.md) for patterns shared with sibling apps (Congregation-Forum, Youth-Forum).

## Top 5 Footguns (read first)

1. **Bump the SW version on every deploy.** Edit `sakhi-sang-vXX` in [sw.js](sw.js). Forgetting this means users get stale JS/CSS until they hard-refresh.
2. **Never rearrange `<script>` tags in [index.html](index.html).** Everything is global scope and the load order is a dependency chain (see Architecture below).
3. **Saturday vs Sunday dates are different keys.** `sessionId` is always a Sunday; `callingStatus.weekDate` and `callingSubmissions.weekDate` are typically a Saturday (whatever `settings/callingWeek.callingDate` says, which is usually Sunday − 1). **Always derive weekDate through `resolveCallingDate(sessionDate)`** ([js/ui-core.js:717](js/ui-core.js#L717)) — never pass the Sunday session date directly to a `weekDate` query. Doing so silently returns zero rows.
4. **Heavy `load*()` functions need a single-flight guard.** `loadDashboard`, `loadDevotees`, `loadCallingStatus`, `loadCareData`, `loadCallingMgmtTab`, `loadAttendanceTab`, `renderHomeLeaderboard` are called from multiple places during the same tick (switchTab + `_mfbOnFiltersChanged` + init). Each uses an `_xxxInFlight` boolean/promise to collapse overlapping calls. **When you add a new `load*()`, copy the same pattern** — otherwise overlapping callers will flicker the UI or leave it stuck on a loading spinner.
5. **UI permission gates and `firestore.rules` can drift — check both.** As of the current (uncommitted) `firestore.rules`, `attendanceRecords` create/update is restricted to `isSuperAdmin() || canManageAllTeams() || isAttSeva()` — but [js/ui-attendance.js](js/ui-attendance.js) still renders the PRESENT/mark button for any `teamAdmin`/`serviceDevotee` regardless of `isAttSevaDev`. If these rules are deployed as-is, ordinary coordinators marking their own team's attendance will get a silent Firestore permission-denied error. Don't assume a visible button means the write will succeed — check `firestore.rules` when touching any write path.

## Development Server

```bash
START_WEB.bat          # Windows shortcut — just runs python's http.server on :8080
python -m http.server 8080
```

No build step, no npm. Open `http://localhost:8080` after starting.

## Tech Stack

- **Vanilla JS + HTML + CSS** — no framework, no bundler
- **Firebase** Firestore + Email/Password auth
- **Chart.js** (Reports tab), **xlsx-js-style** (Excel with cell styling)
- **PWA** via [sw.js](sw.js) — app shell cached, Firebase always live

## Architecture

All logic lives in [js/](js/), loaded as `<script>` tags in [index.html](index.html). **Load order is a dependency chain — do not rearrange:**

1. Firebase SDK (app, firestore, auth)
2. xlsx-js-style, Chart.js
3. `config.js` → `db.js` → `excel.js` → `ui-core.js`
4. Feature UI: `ui-devotees.js`, `ui-calling.js`, `ui-attendance.js`, `ui-analytics.js`, `ui-activities.js`, `ui-home.js`
5. `ui-ai-chat.js` (last)

| File | Role |
|---|---|
| [js/config.js](js/config.js) | Firebase init, `AppState`, `TEAMS`, `DateUtils`, `DevoteeCache`, `TS()`/`INC()` helpers |
| [js/db.js](js/db.js) | The `DB` object — all Firestore reads/writes, with `toCamel()`/`toSnake()` conversion |
| [js/excel.js](js/excel.js) | Export/import; `IMPORT_FIELDS` defines column mapping |
| [js/ui-core.js](js/ui-core.js) | Auth, role gating, admin panel, tab switching, master filter bar, pickers, modals, toasts |
| [js/ui-devotees.js](js/ui-devotees.js) | Devotee list, 5-tab form modal, profile modal |
| [js/ui-calling.js](js/ui-calling.js) | Weekly calling list, calling reports, late-submission tracker |
| [js/ui-attendance.js](js/ui-attendance.js) | Attendance sheet, Sunday config, live marking |
| [js/ui-analytics.js](js/ui-analytics.js) | Reports + Care tabs |
| [js/ui-activities.js](js/ui-activities.js) | **Empty stub** — activity tabs were removed; file kept only for SW cache compatibility |
| [js/ui-home.js](js/ui-home.js) | Home tab + quick-entry drawers; reuses `_initDevoteePicker(prefix)` for `bd`/`reg`/`srv` |
| [js/ui-ai-chat.js](js/ui-ai-chat.js) | AI chat FAB; proxied via Cloudflare Worker `_AI_PROXY_BASE` to hide the Gemini key |

### Global state (`AppState` in config.js)

- `userRole` / `userTeam` / `userId` / `userPosition` — set at login, drive permission checks
- `isAttSevaDev` — special one-session attendance grant (see Roles)
- `filters` — **single context shared across every tab**:
  - `sessionId` (Sunday string, e.g. `'2026-04-26'`)
  - `team` (`''` = All)
  - `callingBy` (`''` = All)
  - `period` + `periodAnchor` (Reports only)
- `currentSessionId` and `currentReportSessionId` are derived getters/setters off `filters.sessionId` for legacy compatibility — don't write them directly.

### Master Filter Bar (THE central pattern)

Three controls — Session, Team, Calling By — sit below the tab nav and drive every tab. Wired in `initMasterFilterBar()` in [js/ui-core.js](js/ui-core.js).

- **Read** filters via `getFilterTeam()` / `getFilterCallingBy()` / `getFilterSessionId()`
- **Write** filters via `dispatchFilters({...})` — never assign to `AppState.filters` directly. It validates (e.g. team-locked roles) and fires a `filtersChanged` CustomEvent on `window`.
- Each tab adds `window.addEventListener('filtersChanged', ...)` and re-runs its own `load*()` function. **All `load*()` are async and idempotent** — they can be called any number of times and always re-render from current filters. Never cache query results across filter changes.
- Legacy per-tab `<select>` elements stay synced via `_mfbAttachLegacyMirror()`. **Don't add new per-tab filter selects** — route through the master bar.

**Filter taxonomy:**
- *Context* (master bar): Session, Team, Calling By — pick the dataset
- *Content* (each tab's own controls): search box, status dropdown, reason filter — narrow within it

**Per-tab semantics:**
| Tab (HTML key) | UI Label | Respects |
|---|---|---|
| `devotees` | Devotees | Team + CallingBy (Session ignored) |
| `calling` | Calling | All three; if Session ≠ configured calling week → read-only historical view (purple banner) |
| `attendance` | Attendance | Session (drives live vs past view) + Team |
| `meetings` | Connecting | Session + Team (superAdmin only; implemented in `ui-analytics.js`) |
| `care` | Care | Session + Team |
| `calling-mgmt` | Calling Mgmt | All three |

The Calling tab's **Submit window** (`isCallingWindowOpen()` in `config.js`) has two layers — master Session changes which week you VIEW, never which week you can submit for:
1. **Automatic** — the configured `callingDate` opens the window for a 24-hour span starting at midnight of that date. No admin action needed.
2. **Manual override** — the Session Config "Calling Window Open" toggle forces the window open or closed regardless of the calling date. The override wins for exactly 24 hours from `callingWindowOverrideAt`, then expires and control reverts to the automatic driver.

### Roles

| Role | Access |
|---|---|
| `superAdmin` | All tabs, all teams |
| `teamAdmin` | All tabs, scoped to `AppState.userTeam` |
| `serviceDevotee` (labeled "Facilitator" in UI) | Same tabs as `teamAdmin` (dashboard, devotees, calling, attendance, care), scoped to their team — **not** Attendance-only. No access to Meetings / Calling Mgmt (super-admin tools). |

**Special flag** — `AppState.isAttSevaDev` is a persistent per-user delegation (set in User Management, `users/{uid}.isAttSevaDev`) granting cross-team attendance marking without promoting the role. Check this flag (not just `userRole`) wherever Attendance is team-scoped.

**Login-time role override** (separate from the flag above) — the login screen's "Login as Attendance Service Devotee (only Attendance tab)" checkbox sets `sessionStorage.loginAsService` and overrides `AppState.userRole` to `serviceDevotee` for that session only ([js/ui-core.js:150-163](js/ui-core.js#L150)). **The "(only Attendance tab)" label is aspirational, not enforced** — `applyRoleUI()` grants `serviceDevotee` the same full team-tab set as any Facilitator (see Roles table above). Don't assume this checkbox restricts anything beyond the normal `serviceDevotee` tab set.

**Delegation flags** — superAdmin can grant extra powers per-user without making them a full superAdmin. All live on `AppState` and on the `users/{uid}` doc:
| Flag | Effect |
|---|---|
| `canAllTeamCalling` | Submit/edit calling on behalf of any team |
| `canAllTeamReports` | View reports across all teams (read-only) |
| `canManageAllTeams` | Both above + full write access app-wide ("lite super admin") |
| `canBackDateAttendance` | Mark/undo attendance on past sessions |

Use the helper functions `canCrossTeamCalling()`, `canCrossTeamReports()`, `canCrossTeamManage()` from `config.js` instead of checking flags directly — they fold in `isSuperAdmin()`.

**First-user bootstrap** — if the `users` collection is empty at signup, the new user gets `superAdmin`. Otherwise signups default to `serviceDevotee` until upgraded.

**Signup approval** — new signups go to `signupRequests` (pending). `subscribePendingSignups()` shows a badge to super admins. `approveSignupRequest(id)` creates the `users/{uid}` doc that `onAuthStateChanged` needs; without that doc, no login.

### Teams

`TEAMS` in [js/config.js](js/config.js) is the **single source of truth**. Use the spelling from that array exactly — `Visakha` was renamed to `Vishakha` and a one-time migration in `ui-core.js` handles legacy docs.

### Firestore Collections

| Collection | Purpose |
|---|---|
| `users` | Auth profiles (role + team) |
| `devotees` | Devotee profiles (soft-deleted via `isActive: false`) |
| `sessions` | Sunday class sessions (on-demand via `DB.getOrCreateSession(sunday)`) |
| `attendanceRecords` | Per-session per-devotee attendance |
| `callingStatus` | Weekly calling outcome (keyed by Saturday `weekDate`) |
| `callingSubmissions` | Submission timestamps per coordinator per week |
| `callingStatusChanges` | Audit trail for calling status edits (keyed by Saturday `weekDate`) |
| `events` / `eventDevotees` | **Legacy** — the Events tab/UI was removed; historical data is untouched but nothing in the app reads/writes these anymore |
| `profileChanges` | Audit trail for devotee profile edits |
| `signupRequests` | Pending signup approvals (see Signup approval above) |
| `supportRequests` | In-app "Devotee Support Helpline" tickets — message + optional photo/voice note, `status: 'open'\|'resolved'` (see Devotee Support below) |
| `settings/callingWeek` | Single doc: configured session date + calling date for the current week |
| `settings/attendanceTargets` | Single doc: per-team or global attendance targets |
| `settings/migrations` | Single doc: one-time migration flags (e.g. `visakhaToVishakha`) |

Sessions are created lazily — there's no pre-population step. Cancelled sessions carry `is_cancelled: true`; attendance is still allowed on them. `loadSessionByDate(dateStr)` snaps to the nearest Sunday first.

### Home Tab (dashboard)

The Home tab (`ui-home.js`) renders differently by day of week:
- **Sunday** — hides the leaderboard, shows the full Coordinator Performance panel (calls `loadCoordinatorPerformance()` from `ui-analytics.js`).
- **Mon–Sat** — hides Coordinator Performance, shows the Team Leaderboard (`renderHomeLeaderboard()`).

`renderHomeLeaderboard()` is always all-teams regardless of the master Team filter — this is intentional. It uses `_lbInFlight` + `_lbLastKey` to deduplicate calls within the same session. Clicking a team bubble opens the Coordinator Performance sub-view scoped to that team.

The Team Leaderboard is also available as a sub-view under the Attendance tab dropdown (`key: 'teams'`) via `loadTeamLeaderboard()` in `ui-analytics.js`.

### Care Tab

Anchored on master Session, computes four lists:
- **Absent** — active devotees with no `attendanceRecords` for the session
- **Said Coming Didn't Come** — `callingStatus.comingStatus == 'Yes'` but absent
- **Inactive** — `inactivityFlag: true` after repeated absence
- **Returning Newcomers** — newly created devotees attending after an initial gap

### AI Chat (ui-ai-chat.js)

Natural-language queries over Firestore data. Calls the Gemini API via a Cloudflare Worker (`_AI_PROXY_BASE`) so the key stays server-side. Tries models in order from `_GEMINI_MODELS` (gemini-2.5-flash → flash-lite → 2.0-flash-lite → …) — if quota is hit on one, it falls back to the next automatically.

### Devotee Support (ui-home.js)

A "Devotee Support Helpline" banner on the Dashboard tab lets any user log an issue (text + optional photo/voice note via `MediaRecorder`) to `supportRequests`. `openSupportModal()` / `submitSupportIssue()` write it; `DB.submitSupportRequest/getSupportRequests/markSupportResolved` are the DB-layer calls. Super admins get an inbox badge (`loadSupportBadge()`) and a resolve action inside the same modal — there's no separate admin tab.

### Calling Reminders (ui-calling.js)

`openReminderModal()` reads the already-loaded late-submission report (`_lateReportWeeks`/`_lateReportRows`) and generates `wa.me` deep links (looked up from `users/{uid}.mobile`) so a super admin can nudge coordinators who haven't submitted calling for the current week — no server-side messaging, just prefilled WhatsApp links.

### Caching

- `DevoteeCache` — 90 s TTL in-memory cache, **team-scoped at the query level**: users without cross-team access (`canCrossTeamManage/Reports/Calling` all false, and not `isAttSevaDev`) only fetch `devotees` where `teamName == AppState.userTeam`. **Call `DevoteeCache.bust()` after any devotee create/update/delete.**
- `sessionsCache` on `AppState` — session metadata by ID
- **Service worker** ([sw.js](sw.js)): Firebase URLs bypass cache; `/js/*.js` is network-first; static assets are cache-first. **Bump `sakhi-sang-vXX` on every deploy** to invalidate caches.
- Firestore offline persistence is on with `synchronizeTabs: true`. Global `unhandledrejection` and `error` handlers in `config.js` catch Firestore `INTERNAL ASSERTION FAILED` errors (a known SDK bug with multi-tab persistence) and reload the page automatically. **Don't remove those handlers.**

### UI Utilities (globals from ui-core.js)

- `openModal(id)` / `closeModal(id)` — toggles `.hidden` on `.modal-overlay`. Modal IDs end with `-modal`. A `popstate` listener gives back-button support via `history.pushState()` on open.
- `showToast(msg, type)` — type is `''` | `'success'` | `'error'`. 3 s auto-dismiss.
- `showFieldError(fieldId, msg)` / `clearFieldError(fieldId)` — use before any DB write.
- `openNumberPicker(...)` + `makePrimaryNumber()` — swap primary/alt mobile atomically.

### Picker Control Pattern

Autocomplete fields (Facilitator, Reference By, Calling By) use `.picker-wrap` → `.picker-input` + `.picker-menu`. Input `.value` holds the selection; `.has-value` class controls styling; `clearPicker(wrapperId, inputId)` resets. **Don't hand-roll new pickers** — reuse this.

### Function Naming

| Prefix | Meaning |
|---|---|
| `load*()` / `load*Tab()` | Async, idempotent — refetch + re-render from current filters |
| `open*Modal()` / `open*()` | Show an overlay (may populate first) |
| `close*()` / `hide*()` | Remove overlay or hide element |
| `_mfbOn*()` | Master filter bar internal handlers |
| `_frPick*()` | Filter-related picker handlers |

### CSS Tokens ([css/style.css](css/style.css))

Use `:root` custom properties — don't hardcode values:
- Colors: `--color-primary` (#1a5c3a forest green), `--color-success`, `--color-danger`, `--color-warning`
- Layout: `--header-h: 64px`, `--nav-h: 52px`
- Radius: `--radius-xs` → `--radius-lg`; Shadows: `--shadow-xs` → `--shadow-lg`
- Type: Cinzel (headings), Nunito (body)

## Reference Docs

- [USER_GUIDE.md](USER_GUIDE.md) — end-user documentation for coordinators (also exported as `USER_GUIDE.docx` via `generate_user_guide.py`)

## Firebase Setup (new project)

Replace `firebaseConfig` in [js/config.js](js/config.js), then:
1. Enable Email/Password auth
2. Firestore rules: `allow read, write: if request.auth != null;`
3. First signup → manually set `role: 'superAdmin'` in the `users` doc

## Important Conventions

- **No modules** — everything is global. New functions go in the `js/` file matching their feature.
- **camelCase ↔ snake_case** — Firestore stores camelCase; UI receives snake_case via `toSnake()`. Writes go through `toCamel()`. **Don't bypass the converters.**
- **Soft-delete only** — set `isActive: false`. A separate `isNotInterested: true` (with `notInterestedAt`) moves a devotee to the "Not Interested" list without deactivating.
- **`callingMode` ≠ `isNotInterested`** — `callingMode: 'not_interested' | 'online'` excludes a devotee from dashboard aggregates. `isNotInterested` is a status flag. They are not interchangeable.
- **Team scoping** — `teamAdmin` queries must include `.where('team', '==', AppState.userTeam)`.
- **Fiscal year** — April–March (used in calling list export date filtering).
- **Dates** — use `DateUtils` for Sunday snapping and display. Never raw `Date` math.
- **Firestore helpers** — `TS()` for server timestamps, `INC(n)` for atomic increments. Never fetch-modify-write a counter.
- **Dual timestamps on `callingStatus`** — write both `updatedAt` (`TS()`) and `updatedAtClient` (ISO string). Late-submission report compares `updatedAtClient` hours to a 21:00 threshold.
- **Attendance lateness color** — call `attTimeStyle(markedAtISO)` from `config.js` (12:30–12:45 pink → 12:45–13:00 salmon → after 13:00 red). Don't hardcode the thresholds.
- **Import batching** — `importDevotees()` chunks writes at 400/batch (Firestore limit is 500). Duplicate key is `name (case-insensitive) + mobile`.
- **Admin data clearing** — `clearDataForDate`, `clearDataForTeamDate`, `clearAllData` are super-admin-only and decrement `lifetimeAttendance`. `clearAllData` requires double confirmation.
