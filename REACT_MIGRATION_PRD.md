# Sakhi Sang React Migration — Product Requirements Document

**Status:** Planning
**Source app:** `Sakhi-Sang-Clone/` (vanilla JS + Firebase)
**Target app:** `sakhi-sang-react/` (new repo, new Firebase project)
**Owner:** Riya Gupta
**Purpose:** Complete rewrite of the existing Sakhi Sang Devotee Management System in React, preserving all functionality and visual design while solving the chronic data-flow tangles that plague the vanilla codebase.

---

## 0. Why we are doing this

The current vanilla JS app works but has a tangled data flow that makes incremental changes risky. Specifically:

- 5+ places can call `loadDashboard`; race conditions cause stuck spinners and stale displays
- Filter chip and rendered data can drift apart (chip says Champaklata, table shows Lalita)
- Adding any feature requires understanding ~10 global state fields and 3-4 lifecycle paths
- Each "small fix" tends to break something unrelated because dependencies are implicit

This PRD describes a fresh React rewrite where:
- State coordination is automatic (one source of truth, components subscribe)
- Filter changes refetch + re-render via React Query, no manual orchestration
- Components are isolated; changing one tab can't accidentally break another
- The visual identity is **100% preserved** — same colors, fonts, layouts, card styles, icons

---

## 1. Goals & Non-Goals

### Goals
1. **Functional parity** with the current vanilla app — every feature, role, tab, modal, report
2. **Visual parity** — same look, same fonts, same colors, same icons, same card design
3. **Solve the data-flow problem** — filter changes always refresh affected views, no stuck spinners, no stale displays
4. **Maintainability** — adding a new tab or feature should not require touching unrelated code
5. **PWA capability** — installable, offline-capable shell, fresh data from Firebase
6. **Faster perceived interactions** — cached data renders instantly on filter changes that don't require new data

### Non-Goals (explicitly excluded)
1. **New features.** This is a rewrite, not a redesign. Feature requests go in a separate backlog.
2. **Visual redesign.** No theme changes, no layout changes, no font changes.
3. **Data migration tooling.** New Firebase = empty start. Import via existing Excel flows after launch.
4. **Mobile native app.** PWA only.
5. **Server-side rendering / Next.js.** Static SPA is sufficient.
6. **Internationalization.** English only (same as today).
7. **Replacing Firebase.** Stays on Firebase Firestore + Auth.

---

## 2. Tech Stack

| Concern | Choice | Why |
|---|---|---|
| Build tool | **Vite 5+** | Fast dev server, native ESM, zero config for React |
| Framework | **React 18** | Industry standard, huge ecosystem, hooks model fits this app |
| Language | **TypeScript** | Catches the camelCase ↔ snake_case bugs and field-name typos that plague the vanilla app. Worth the small learning curve. |
| Styling | **Plain CSS** (port [css/style.css](css/style.css) verbatim) + CSS modules where component-scoped | Preserves existing visual identity exactly. No Tailwind, no styled-components — keep it simple and match the source. |
| Global state | **Zustand** | Tiny (~1KB), simple API, no boilerplate. Replaces `AppState` in [config.js](js/config.js). |
| Server state | **TanStack Query (React Query) v5** | THE answer to the chronic filter/refetch/cache problems. Handles deduplication, stale-while-revalidate, automatic refetch on filter change, optimistic updates. |
| Firestore SDK | **Firebase v10 modular SDK** (not compat) + **react-firebase-hooks** for auth | Modern, tree-shakeable. Existing code uses v8-style `firebase.firestore()` compat API — that gets rewritten. |
| Routing | **React Router v6** | Replaces show/hide tab logic. Each tab becomes a route. |
| Forms | **React Hook Form** | For the 5-tab devotee form, calling form, session config, etc. Tiny, fast, uncontrolled by default. |
| Charts | **Chart.js + react-chartjs-2** | Same Chart.js used today, with React wrapper. |
| Excel | **xlsx-js-style** | Same library. Logic ports unchanged. |
| PWA | **vite-plugin-pwa** | Auto-generates service worker, manifest, workbox config. Replaces hand-written [sw.js](sw.js). |
| Toast notifications | **react-hot-toast** | Tiny, replaces `showToast()`. |
| Icon set | **Font Awesome 6.5.1** (via CDN, same as today) | Preserve all `fa-*` icons used in current markup. |
| AI Chat | Existing **Cloudflare Worker** at `_AI_PROXY_BASE` | No change. Just a fetch from React. |

**Excluded explicitly:**
- ❌ Tailwind / Bootstrap / Material UI — would force visual changes
- ❌ Redux / Redux Toolkit — overkill, Zustand wins for this size
- ❌ tRPC / GraphQL — Firestore SDK is already the API
- ❌ Server-side anything — pure client app

---

## 3. Repository Structure

```
sakhi-sang-react/
├── public/
│   ├── icon-192.png                 # COPY from current app
│   ├── icon-512.png                 # COPY from current app
│   └── icons/icon.svg               # COPY from current app
├── src/
│   ├── main.tsx                     # Entry point
│   ├── App.tsx                      # Router + layout
│   ├── styles/
│   │   ├── index.css                # PORT verbatim from css/style.css
│   │   └── tokens.css               # Extract :root CSS variables (no logic change)
│   ├── lib/
│   │   ├── firebase.ts              # Firebase init + exports
│   │   ├── teams.ts                 # TEAMS constant — COPY from config.js
│   │   ├── dates.ts                 # DateUtils, toLocalDateStr, parseLocalDate, snapToSunday — COPY
│   │   ├── format.ts                # contactIcons, teamBadge, initials, isBirthdayWeek, attTimeStyle — PORT
│   │   ├── validate.ts              # validateMobile, etc. — COPY
│   │   └── excel.ts                 # Import/export logic — PORT (data flow unchanged, called from hooks)
│   ├── store/
│   │   ├── authStore.ts             # User, role, team, position — REBUILD on Zustand
│   │   └── filterStore.ts           # sessionId, team, callingBy, period — REBUILD on Zustand
│   ├── api/                         # React Query hooks wrapping Firestore reads + writes
│   │   ├── devotees.ts              # useDevotees, useDevotee, useAddDevotee, useUpdateDevotee, etc.
│   │   ├── sessions.ts              # useSession, useSessions, useGetOrCreateSession
│   │   ├── attendance.ts            # useAttendance, useMarkPresent, useUndoPresent
│   │   ├── calling.ts               # useCallingStatus, useSaveCallingStatus, useCallingHistory
│   │   ├── events.ts
│   │   ├── activities.ts            # books/donations/registrations/service
│   │   ├── care.ts                  # absent/returning/inactive lists
│   │   └── settings.ts              # callingWeek, attendanceTargets, migrations
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Header.tsx           # Logo, date pill, user badge, Sign Out
│   │   │   ├── Sidebar.tsx          # Hamburger menu (admin panel, session mgmt, etc.)
│   │   │   ├── TopNav.tsx           # Desktop tab nav
│   │   │   ├── BottomNav.tsx        # Mobile bottom nav
│   │   │   ├── Breadcrumb.tsx
│   │   │   └── MasterFilterBar.tsx  # Session + Team + CallingBy chips
│   │   ├── ui/
│   │   │   ├── Modal.tsx            # Reusable modal overlay
│   │   │   ├── Toast.tsx            # Wrapper around react-hot-toast
│   │   │   ├── DevoteeAvatar.tsx    # Initials avatar
│   │   │   ├── TeamBadge.tsx
│   │   │   ├── ContactIcons.tsx     # Phone + WhatsApp links
│   │   │   ├── Picker.tsx           # Autocomplete picker (Facilitator, Reference By, Calling By)
│   │   │   ├── StatusChip.tsx       # Coming/reason/Not-called chip
│   │   │   ├── KpiTile.tsx
│   │   │   └── EmptyState.tsx
│   │   └── modals/
│   │       ├── DevoteeFormModal.tsx       # 5-tab devotee add/edit
│   │       ├── DevoteeProfileModal.tsx
│   │       ├── CallingHistoryModal.tsx
│   │       ├── SessionConfigModal.tsx
│   │       ├── AdminPanelModal.tsx
│   │       ├── TargetMgmtModal.tsx
│   │       ├── NumberPickerModal.tsx
│   │       └── ClearDataModal.tsx
│   ├── pages/
│   │   ├── Login.tsx
│   │   ├── PendingApproval.tsx
│   │   ├── Home.tsx                 # Dashboard tab
│   │   ├── Devotees.tsx
│   │   ├── Calling/
│   │   │   ├── index.tsx            # Tab wrapper with sub-tabs
│   │   │   ├── Calls.tsx
│   │   │   ├── TeamCalling.tsx
│   │   │   ├── WeeklyReport.tsx
│   │   │   ├── SubmissionReports.tsx
│   │   │   └── History.tsx
│   │   ├── Attendance/
│   │   │   ├── index.tsx
│   │   │   ├── Live.tsx
│   │   │   ├── Sheet.tsx
│   │   │   ├── LateComers.tsx
│   │   │   ├── NewComers.tsx
│   │   │   ├── SeriousAnalysis.tsx
│   │   │   ├── TeamLeaderboard.tsx
│   │   │   ├── Trends.tsx
│   │   │   └── Accuracy.tsx
│   │   ├── Care.tsx
│   │   ├── Events.tsx
│   │   ├── CallingMgmt/
│   │   │   ├── index.tsx
│   │   │   ├── CallingList.tsx
│   │   │   ├── NewComers.tsx
│   │   │   ├── OnlineClass.tsx
│   │   │   ├── NotInterested.tsx
│   │   │   └── Festival.tsx
│   │   ├── Activities/
│   │   │   ├── index.tsx
│   │   │   ├── LogEntry.tsx
│   │   │   └── Reports.tsx
│   │   └── Reports.tsx              # Combined reports across categories
│   ├── ai-chat/
│   │   ├── ChatFab.tsx
│   │   ├── ChatDrawer.tsx
│   │   └── geminiClient.ts          # PORT _AI_PROXY_BASE + _GEMINI_MODELS waterfall
│   └── types/
│       ├── firestore.ts             # All Firestore document types
│       └── domain.ts                # Devotee, CallingStatus, Session, etc.
├── index.html
├── vite.config.ts
├── tsconfig.json
├── package.json
└── README.md
```

---

## 4. Visual Design Preservation

### CSS Strategy
**Direct port.** Copy [css/style.css](css/style.css) into `src/styles/index.css`. The vast majority of classes (`.calling-card`, `.cc-header`, `.dashboard-table`, `.fr-chip-wrap`, etc.) become regular CSS classes used in JSX.

**No CSS-in-JS, no Tailwind.** Keep the design tokens exactly as they are:
- `--color-primary: #1a5c3a` (forest green)
- `--color-success`, `--color-danger`, `--color-warning`
- `--header-h: 64px`, `--nav-h: 52px`
- Radius scale: `--radius-xs` → `--radius-lg`
- Shadow scale: `--shadow-xs` → `--shadow-lg`
- Fonts: **Cinzel** (headings), **Nunito** / **DM Sans** (body)

Add the Google Fonts `<link>` to `index.html` (same as current).

### Component class mapping
Where the current code uses `class="cc-card cc-confirmed"`, the React component does `<div className={\`calling-card \${isYes ? 'cc-confirmed' : ''}\`}>`. Same DOM, same CSS rules apply.

### Icons
Continue using Font Awesome 6.5.1 via CDN `<link>` in `index.html`. JSX uses `<i className="fas fa-phone-alt" />`.

### Calling card design (recently redesigned)
The collapsible card pattern (whole card clickable, expand to show body, hide phone/WhatsApp from click toggle) is current state of art. **Preserve as-is.** See [js/ui-calling.js:458](js/ui-calling.js#L458) `renderCallingCard` for current markup — port directly to a `CallingCard.tsx` component.

---

## 5. Architecture Overview

### Data flow (the heart of the solution)

```
┌─────────────────┐
│ Firestore       │
│ (cloud)         │
└────────┬────────┘
         │ queries
         ▼
┌─────────────────────────────────┐
│ React Query cache               │
│ keyed by [collection, filters]  │
└────────┬────────────────────────┘
         │ useQuery hooks
         ▼
┌─────────────────┐     ┌──────────────────┐
│ Zustand stores  │     │ Page components  │
│ • auth          │────►│ • Home           │
│ • filters       │     │ • Devotees       │
└─────────────────┘     │ • Calling        │
                        │ • etc.           │
                        └──────────────────┘
```

**Critical principle:** A filter change updates the filterStore. Any `useQuery` whose key includes that filter automatically refetches. Any component reading that query re-renders. **There is no manual orchestration.** The race conditions, gen guards, stuck spinners, chip/data mismatch — all disappear by construction.

### State separation

| Type | Stored where | Examples |
|---|---|---|
| Server data | React Query cache | Devotees, attendance records, calling status, sessions |
| UI state (global) | Zustand | Current filter (session/team/callingBy), auth (user/role/team), active tab |
| UI state (local) | `useState` in component | Modal open/closed, search input value, form field values |

### The filter problem, solved

In the vanilla app, changing a team filter requires:
1. Update `AppState.filters.team`
2. Fire `filtersChanged` event
3. Listener `_mfbOnFiltersChanged` calls `loadDashboard()`
4. Update legacy widgets
5. Update chip text via `_frRefreshChips()`
6. Pray nothing races

In React:
```ts
const { team } = useFilterStore();
const { data } = useQuery({ queryKey: ['dashboard', team, sessionId], queryFn: fetchDashboard });
return <DashboardView data={data} team={team} />;
```
Setting `team` automatically invalidates the query, refetches if needed, and re-renders the view. **One line of state mutation, the rest is automatic.**

---

## 6. Phased Implementation Plan

Each phase is **independently testable**. Don't start phase N+1 until phase N passes acceptance.

### Phase 0 — Setup & Infrastructure (1-2 days)

**Scope:**
- Create new GitHub repo `sakhi-sang-react`
- `npm create vite@latest sakhi-sang-react -- --template react-ts`
- Install dependencies: `firebase`, `react-firebase-hooks`, `@tanstack/react-query`, `zustand`, `react-router-dom`, `react-hook-form`, `react-hot-toast`, `chart.js`, `react-chartjs-2`, `xlsx-js-style`, `vite-plugin-pwa`
- Set up new Firebase project (Firestore + Auth + Hosting)
- Configure Firebase security rules: `allow read, write: if request.auth != null;`
- Port `style.css` to `src/styles/index.css`
- Add Cinzel + Nunito + Font Awesome via CDN in `index.html`
- Set up vite-plugin-pwa with auto-update strategy
- Configure TypeScript strict mode
- Configure ESLint + Prettier
- Set up basic folder structure (per Section 3)
- Deploy "Hello World" to Firebase Hosting to verify pipeline

**Copy-paste candidates from old code:**
- `css/style.css` → `src/styles/index.css` (verbatim port)
- `icon-192.png`, `icon-512.png`, `icons/icon.svg` → `public/`

**Build new:**
- Everything else

**Acceptance:**
- ☐ Repo created, Vite app runs locally
- ☐ Firebase project created, can read/write a test doc
- ☐ Deployed to Firebase Hosting, accessible at URL
- ☐ Service worker registers
- ☐ Fonts and Font Awesome load
- ☐ TypeScript compiles with zero errors

---

### Phase 1 — Foundation: Auth, Layout, Filter Bar (3-5 days)

**Scope:**
1. **Auth flow**
   - Login page (email + password, "Login as Attendance Service Devotee" checkbox)
   - Pending Approval screen
   - Signup → writes to `signupRequests` collection
   - First user gets `superAdmin`
   - `onAuthStateChanged` → load user profile → set authStore
   - Sign out

2. **App shell**
   - `Header` with logo, current date, user badge (name + role), Sign Out
   - `Sidebar` (hamburger menu) with admin/super-admin links
   - `TopNav` (desktop) with tab buttons
   - `BottomNav` (mobile) with tab icons
   - `Breadcrumb` showing current location
   - `Layout.tsx` wrapping all authenticated pages

3. **Master Filter Bar** (THE central component)
   - Session chip (date picker dropdown)
   - Team chip (dropdown, hidden when team-locked)
   - Calling By chip
   - Clear-all button
   - Caption banner: "Showing [team] team, for [date]"
   - Uses `filterStore` for state
   - Snaps team to user's team on non-Devotees tabs for team-locked roles
   - Snaps session to most recent past Sunday on dashboard if future was picked

4. **Routing**
   - `/login` (public)
   - `/pending-approval` (public)
   - All other routes wrapped in `RequireAuth`
   - `/` → redirects to `/home`
   - `/home`, `/devotees`, `/calling/*`, `/attendance/*`, `/care`, `/events`, `/calling-mgmt/*`, `/activities/*`
   - Routes preserve master filter state in URL search params (optional, nice-to-have)

5. **Modal infrastructure**
   - `<Modal>` component with backdrop, close on Escape/backdrop click
   - History pushState for back-button support (port from current `popstate` handler)

6. **Toast notifications**
   - Wrapper around `react-hot-toast` matching current `showToast(msg, type)` API

**Copy-paste from old code:**
- TEAMS array → `src/lib/teams.ts`
- DateUtils, getToday, snapToSunday, formatDate, toLocalDateStr, parseLocalDate → `src/lib/dates.ts`
- contactIcons logic → `src/components/ui/ContactIcons.tsx` (rewrite as JSX, preserve `tel:`/`wa.me/` URLs)
- teamBadge logic → `src/components/ui/TeamBadge.tsx`
- initials, isBirthdayWeek → `src/lib/format.ts`
- validateMobile → `src/lib/validate.ts`
- attTimeStyle → `src/lib/format.ts`
- All role-gating logic from `applyRoleUI` — port as helpers in `src/lib/permissions.ts`
- HTML structure of header, sidebar, modals — translate `<section>` markup from [index.html](index.html) into JSX

**Build new:**
- All React components
- Zustand stores (`authStore`, `filterStore`)
- React Router setup
- React Query provider setup
- Login/Signup forms (use React Hook Form)
- Master filter bar interaction logic (each chip is a controlled dropdown component)

**Acceptance:**
- ☐ User can sign up, see "pending approval" screen
- ☐ Super admin (manually set in Firestore) can log in
- ☐ Login persists across reload
- ☐ Sign out clears state and redirects
- ☐ Master filter bar shows all 3 chips, clicking opens dropdown, picking updates store
- ☐ Team chip hidden for teamAdmin on non-Devotees routes
- ☐ Caption banner reflects current filter state
- ☐ Breadcrumb updates with route
- ☐ Mobile bottom nav highlights active route
- ☐ Modal opens/closes, Escape closes, back-button closes

---

### Phase 2 — Devotees Tab (3-4 days)

**Scope:**
1. **Devotee list page**
   - Search box
   - Status filter (Active/Inactive)
   - Team filter (from master bar)
   - Calling By filter (from master bar)
   - Devotee cards (avatar, name, team, status, contact icons)
   - Pagination or virtualized list if >500 devotees
   - "Add Devotee" FAB

2. **Devotee form modal (5-tab)**
   - Tab 1: Personal (name, mobile, alt mobile, DOB, gender)
   - Tab 2: Devotee info (chanting rounds, devotee status, instrument)
   - Tab 3: Calling (callingBy picker, reference picker, facilitator picker)
   - Tab 4: Team & Status (team, callingMode, isNotInterested)
   - Tab 5: Notes & Address
   - Save → write to Firestore via mutation
   - On success: toast, close modal, refetch list

3. **Devotee profile modal**
   - View-only details
   - Edit history (from `profileChanges` subcollection)
   - Action buttons: Edit, Mark Present, Make Not-Interested, Soft-Delete, Restore

4. **Picker autocomplete component** (`Picker.tsx`)
   - Used in: Facilitator, Reference By, Calling By
   - Type to filter, click to select, clear button
   - Source: list of users with appropriate role
   - Debounced input

5. **Excel import/export**
   - Export: button → generates `.xlsx` with all visible devotees, styled
   - Import: file picker → parse → fuzzy duplicate check (Levenshtein on name+mobile) → confirm dialog → batched writes (400/batch)

**Copy-paste from old code:**
- Devotee form field structure from [index.html](index.html) `<section id="tab-devotees">` and form modal markup
- Devotee CRUD logic from [js/db.js](js/db.js) `addDevotee`, `updateDevotee`, `softDeleteDevotee`, `restoreDevotee` — port as React Query mutations
- Devotee filtering logic from [js/ui-devotees.js](js/ui-devotees.js) `loadDevotees`
- Excel import/export logic from [js/excel.js](js/excel.js) `_xls`, `_xlsSheet`, `IMPORT_FIELDS`, duplicate detection
- Form validation (mobile, required fields)

**Build new:**
- All JSX
- React Query hooks: `useDevotees`, `useDevotee(id)`, `useAddDevotee`, `useUpdateDevotee`, etc.
- 5-tab form with React Hook Form
- Picker component (replaces all `_initDevoteePicker` patterns)
- Devotee card component
- Profile modal with edit history

**Acceptance:**
- ☐ Devotee list loads, search/filter works instantly
- ☐ Adding a devotee → appears in list immediately (optimistic update or refetch)
- ☐ Editing → changes persist + audit trail in `profileChanges`
- ☐ Soft-delete → moves to Inactive, can restore
- ☐ Excel export downloads correctly-styled .xlsx
- ☐ Excel import detects duplicates, asks for confirmation
- ☐ Pickers (Calling By, Facilitator) autocomplete from users

---

### Phase 3 — Home / Dashboard Tab (2-3 days)

**Scope:**
1. **Greeting card**
   - "Hare Krishna, [First Name]!"
   - Subline: "Reports for [Sun, DD MMM YYYY] · [Team] · Activities: DD MMM – DD MMM"
   - Live cycle indicator (if auto-snap happened)
   - Refresh button (manual refetch trigger)

2. **KPI tiles**
   - Attended: "X/Y" or "X"
   - Calling Accuracy: "X%"

3. **Coordinator Performance table**
   - Columns: Team | Called | Yes | Came | Target | %
   - One row per team (or one row for filtered team)
   - Grand Total row
   - Numbers are clickable → opens detail modal with list of devotees

4. **Quick Actions tiles**
   - Mark Attendance → navigates to Attendance Live
   - Log Calls → navigates to Calling
   - Add Book Distribution → opens drawer
   - Log Donation → opens drawer
   - Log Registration → opens drawer
   - Log Service → opens drawer

5. **Quick-entry drawers** (slide-in panels from bottom on mobile)
   - Devotee picker + amount/quantity/notes
   - Save → mutation → toast

**Copy-paste from old code:**
- Session resolution logic from [js/ui-analytics.js](js/ui-analytics.js#L62) (the if/else if chain for sessionDate)
- Calling date derivation (`resolveCallingDate` from [js/ui-core.js:622](js/ui-core.js#L622))
- Activity window calculation (lines 122-148 of `loadDashboard`)
- Per-team aggregation logic (lines 158-193 of `loadDashboard`) — this is pure business logic, port as a function
- KPI formulas (totalPct, callAccPct)
- Greeting subline composition
- Quick-entry drawer field structure from [index.html](index.html) `home-*-drawer` sections

**Build new:**
- `useDashboardData(sessionId, callingDate)` React Query hook — fetch is automatic + cached
- All JSX components
- DashboardTable, KpiTile, GreetingCard, QuickActionsGrid
- Quick-entry drawer components
- "Detail" modal opened by clicking a number (called/coming/attended devotee list)

**Key React Query magic for this tab:**
```ts
const { sessionId, team, callingBy } = useFilterStore();
const { data } = useDashboardData(sessionId);  // Refetch only when session changes
const filteredRows = useMemo(() =>
  team ? data.rows.filter(r => r.team === team) : data.rows
, [data, team]);  // Team filter is pure re-render, no network
```

**This single pattern solves the entire "filter change not refreshing" class of bugs.**

**Acceptance:**
- ☐ Home tab loads dashboard in <2s on a warm cache
- ☐ Changing session → spinner → fresh data
- ☐ Changing team → INSTANT (no spinner, no network)
- ☐ Changing calling-by → INSTANT
- ☐ KPI tiles match table totals
- ☐ Clicking a number opens detail modal with correct list
- ☐ Quick-entry drawers save and toast
- ☐ Refresh button refetches
- ☐ Greeting subline correctly shows session date + activity window

---

### Phase 4 — Attendance Tab (4-5 days)

**Scope:**
1. **Live Attendance** sub-tab
   - List of devotees with "Mark Present" / "Unmark" buttons
   - Filter by team
   - Search by name
   - Newcomer "Register & Mark Present" flow
   - Late-arrival color coding (12:30-12:45 pink, 12:45-13:00 salmon, after 13:00 red) using `attTimeStyle`
   - Real-time count of present devotees
   - "Register" FAB for new devotees

2. **Attendance Sheet** sub-tab
   - Year selector
   - Grid: rows=devotees, columns=Sundays
   - Cells: ✓ for present, blank for absent
   - Per-team grouping
   - Export to Excel

3. **Late Comers** report
   - List of devotees who arrived after 12:45
   - Editable late remarks

4. **New Comers** report
   - List of devotees with `isNewDevotee: true` in attendance for this session

5. **Serious Analysis** report
   - High-attendance devotees, low-attendance flags

6. **Team Leaderboard**

7. **Trends** chart (Chart.js)
   - Per-team attendance over time

8. **Accuracy** report
   - Comparison: Yes coming vs actually came

9. **Session config** (super admin only, in sidebar)
   - Pick Sunday date
   - Mark as cancelled, set topic

**Copy-paste from old code:**
- Attendance fetch/write logic from [js/db.js](js/db.js) `markPresent`, `undoPresent`, `getSessionAttendance`, `getAttendanceCandidates`
- Live attendance render logic from [js/ui-attendance.js](js/ui-attendance.js) `loadAttendanceSession`
- Late color logic via `attTimeStyle` (already in [config.js](js/config.js))
- Year sheet grid generation logic
- Chart.js setup for trends

**Build new:**
- `useAttendance(sessionId)` query
- `useMarkPresent`, `useUndoPresent` mutations with optimistic updates
- `<LiveAttendance>` component
- `<AttendanceSheet>` component
- All sub-tab pages
- `<TrendChart>` using react-chartjs-2

**Acceptance:**
- ☐ Mark Present → button flips to "PRESENT ✓" instantly (optimistic)
- ☐ Late arrival rows show correct color
- ☐ Year sheet renders correctly for all teams
- ☐ Register & Mark Present in one flow works
- ☐ Trends chart renders without errors
- ☐ Session config saves to `sessions` collection
- ☐ Cancelled session shows banner but still allows marking

---

### Phase 5 — Calling Tab (5-6 days)

**Scope:**
1. **Calls** sub-tab (the main calling list)
   - Filter strip: Status (Yes/No/Not called/Reason), Reason, Search
   - **Collapsible calling cards** (per recent redesign)
     - Default state: avatar, name, team, caller, mobile number text, status chip, chevron
     - Click anywhere on card to expand (except phone/whatsapp icons and name)
     - Expanded: Yes / No Pick / Retry / More dropdown / Notes textarea / Updated time
     - Color states: green border for Coming, yellow border for Reason logged, white default
   - "Submit Week" button (locks the week)
   - Late-submission tracking
   - Locked banner if viewing a non-current week

2. **Team Calling** sub-tab
   - Cross-team view for super admins
   - Same card pattern

3. **Weekly Report**
   - Counts per team: Called, Yes, Reasons breakdown
   - Submission status per coordinator
   - Export to Excel

4. **Submission Reports**
   - Per-coordinator submission times (late if after 21:00)

5. **Calling History**
   - Per-devotee call history across weeks
   - From `callingStatus` + `callingStatusChanges`

6. **Calling form & submit window**
   - Window is gated by `settings/callingWeek.callingDate`
   - Master Session change = view different week (read-only if historical)
   - Submit only allowed for configured week

**Copy-paste from old code:**
- `CALLING_REASONS` constant
- `renderCallingCard` markup from [js/ui-calling.js:458](js/ui-calling.js#L458) — port as `<CallingCard>` JSX component, preserve all logic (color states, chevron, etc.)
- `toggleComing`, `quickReason`, `quickRetry`, `onReasonChange`, `updateCallingNotes` handlers — wire to mutations
- `loadCallingStatus` logic for fetching list
- `loadCallingHistory` for history modal
- `openCallingHistory` modal trigger
- Submit window logic (compare `settings/callingWeek` vs current week)
- Locked state banner logic (`_renderLockedBanner`)
- Late-submission report query

**Build new:**
- `useCallingStatus(weekDate, team, callingBy)` query
- `useSaveCallingStatus` mutation with optimistic update + `_bustDashboardCache` equivalent (React Query handles via `queryClient.invalidateQueries`)
- `<CallingCard>` component (the recently-redesigned one)
- `<CallingFilters>` component
- All sub-tab pages

**Acceptance:**
- ☐ Card design matches current Sakhi-Sang version exactly
- ☐ Card expands/collapses on click; phone/WhatsApp links don't toggle
- ☐ Yes / No Pick / Retry / More buttons all save to Firestore
- ☐ Color states (green/yellow/white) reflect Yes/Reason/None
- ☐ Submit Week locks the week
- ☐ Late submission (after 21:00) shows correctly in report
- ☐ Historical week view is read-only with purple banner
- ☐ Changing master Session changes the week being viewed
- ☐ Calling History modal shows full audit trail

---

### Phase 6 — Care Tab (2 days)

**Scope:**
Computed from session + filters:
- **Absent**: active devotees with no attendance record for the session
- **Said Coming Didn't Come**: callingStatus.comingStatus=='Yes' but absent
- **Inactive**: `inactivityFlag: true` after repeated absence
- **Returning Newcomers**: newly created devotees attending after a gap

Tabs for each list. Each item is a card with quick actions: Call, WhatsApp, View Profile, Mark As Followed-Up.

**Copy-paste from old code:**
- Care computation logic from [js/ui-analytics.js](js/ui-analytics.js) `loadCareData`, `loadAbsentDevotees`, `loadReturningNewcomers`, etc.
- The 4 list algorithms (pure business logic)

**Build new:**
- `useCareLists(sessionId, team)` React Query hook
- 4 list components
- Follow-up action handler

**Acceptance:**
- ☐ All 4 lists populate correctly for a known session
- ☐ Changing team filter narrows lists instantly (no network)
- ☐ Changing session triggers refetch
- ☐ Quick actions (Call/WhatsApp) work
- ☐ Profile modal opens from list

---

### Phase 7 — Calling Mgmt Tab (2-3 days)

**Scope:**
Sub-tabs:
- **Calling List**: devotees with calling assignments (filterable)
- **New Comers**: recently joined devotees
- **Online Class**: `callingMode: 'online'`
- **Not Interested**: `callingMode: 'not_interested'` OR `isNotInterested: true`
- **Festival Calling**: `callingMode: 'festival'`

For each devotee: change team, change calling-by, shift to Online/Festival/Not-Interested, restore to regular list.

**Copy-paste from old code:**
- Logic from [js/ui-analytics.js](js/ui-analytics.js) `loadCallingMgmtTab`, `_renderCMGrid`, `restoreMgmtDevotee`, etc.
- Shift action handlers (`setDevoteeCallingMode` from db.js)
- Team-change and calling-by-change modals

**Build new:**
- React Query hooks for each list
- Page components
- Action modals

**Acceptance:**
- ☐ Each sub-tab list populates correctly
- ☐ Shifting a devotee between modes updates correctly
- ☐ Calling list reflects callingMode filters

---

### Phase 8 — Events Tab (2 days)

**Scope:**
- List of events (e.g., Janmashtami, Gita Jayanti)
- Add new event
- Per-event devotee list with attendance + payment + transport tracking
- Export per event

**Copy-paste from old code:**
- Event CRUD from [js/db.js](js/db.js)
- Event UI from [js/ui-analytics.js](js/ui-analytics.js) `loadEvents`

**Build new:**
- React Query hooks
- Page + modals

**Acceptance:**
- ☐ Can create, view, edit events
- ☐ Can attach devotees to events with custom fields

---

### Phase 9 — Activities Tab (2-3 days)

**Scope:**
Driven by `ACTIVITY_CONFIG`. Four activity types: Books, Service, Registration, Donation.
- **Log Entry** sub-tab: form to add an entry
- **Reports** sub-tab: aggregated counts/amounts per devotee per period

**Copy-paste from old code:**
- `ACTIVITY_CONFIG` structure from [js/ui-activities.js](js/ui-activities.js) — preserves the auto-generation pattern
- Per-activity add/get methods from [js/db.js](js/db.js)
- Aggregation logic

**Build new:**
- Generic `<ActivityLogForm>` component driven by config
- Generic `<ActivityReport>` component
- React Query hooks for each activity type

**Acceptance:**
- ☐ All 4 activities can be logged
- ☐ Reports show correct aggregations
- ☐ Adding a new activity type requires only adding to `ACTIVITY_CONFIG`

---

### Phase 10 — Reports / Analytics Tab (3-4 days)

**Scope:**
- Period segment: Session / Month / Quarter / Fiscal Year
- Category switcher: Attendance / Calling / Activities / Care
- Chart.js visualizations
- Tables with export
- Date range derivation logic

**Copy-paste from old code:**
- Period date range logic (`_reportRange()` in [js/ui-analytics.js](js/ui-analytics.js))
- Chart Chart.js setup
- Report aggregation queries
- Excel export styling

**Build new:**
- `<ReportsLayout>` with period segment + category switcher
- Each report page component
- Chart components using react-chartjs-2

**Acceptance:**
- ☐ Period switcher correctly changes date range
- ☐ Category switcher swaps view
- ☐ Charts render without errors
- ☐ Excel exports match expected format

---

### Phase 11 — Admin Panel & Settings (2-3 days)

**Scope:**
- User management (approve signups, change roles, change teams)
- Session management
- Calling week configuration
- Attendance targets configuration
- Destructive operations: Clear Data for Date, Clear Data for Team+Date, Clear All (with double confirm)
- One-time migrations (team rename)

**Copy-paste from old code:**
- Admin panel logic from [js/ui-core.js](js/ui-core.js) (clearDataForDate, clearDataForTeamDate, clearAllData, etc.)
- Approval flow (`approveSignupRequest`, `rejectSignupRequest`)
- Migration logic
- Calling week config save/load
- **Important:** apply the Bug #1 fix — `clearDataForDate` must use `resolveCallingDate(date)` for `callingStatus`/`callingSubmissions` queries, NOT the raw Sunday date

**Build new:**
- Admin panel modal
- Subcomponents per setting

**Acceptance:**
- ☐ Super admin can approve signups
- ☐ Can change user roles + teams
- ☐ Can configure next calling week
- ☐ Can set attendance targets per team or global
- ☐ Destructive clears actually delete BOTH attendance AND calling records correctly
- ☐ Clear All requires double confirmation

---

### Phase 12 — AI Chat (1-2 days)

**Scope:**
- Floating Action Button (sparkle icon)
- Drawer that opens with chat history
- Input field, send button
- Calls Cloudflare Worker `_AI_PROXY_BASE` with model waterfall
- Renders responses (with simple Markdown support)
- Can query Firestore data based on user questions

**Copy-paste from old code:**
- `_AI_PROXY_BASE` URL constant
- `_GEMINI_MODELS` waterfall list
- Model retry logic
- Firestore-query-from-NL logic from [js/ui-ai-chat.js](js/ui-ai-chat.js)

**Build new:**
- `<ChatFab>`, `<ChatDrawer>` components
- `useChatSession()` hook
- Markdown renderer for responses

**Acceptance:**
- ☐ FAB visible on all authenticated pages
- ☐ Chat sends to worker, displays response
- ☐ Model waterfall works when first model is rate-limited

---

### Phase 13 — PWA, Polish, Deploy (2-3 days)

**Scope:**
- vite-plugin-pwa config: auto-update strategy, manifest, icons
- Offline fallback page
- "New version available" toast prompting reload
- Production build optimization
- Performance audit (Lighthouse)
- Final cross-browser testing (Chrome, Safari mobile, Firefox)
- Deploy to Firebase Hosting
- Set up GitHub Action for auto-deploy on push to main

**Copy-paste from old code:**
- App manifest icons
- SW cache strategy intent (vite-plugin-pwa handles implementation)

**Build new:**
- vite.config.ts PWA section
- Reload prompt UI
- GitHub Action YAML

**Acceptance:**
- ☐ PWA installable on Android Chrome
- ☐ PWA installable on iOS Safari
- ☐ Offline shell loads
- ☐ "New version available" prompts user
- ☐ Lighthouse PWA score ≥90
- ☐ Lighthouse Performance score ≥85 on mobile
- ☐ Deployed to Firebase Hosting
- ☐ GitHub Action auto-deploys on push

---

## 7. Reusability Index — What Ports vs What Rebuilds

### Direct port (copy with minimal changes)
| From | To | Notes |
|---|---|---|
| `css/style.css` | `src/styles/index.css` | Verbatim. Class names preserved. |
| TEAMS constant | `src/lib/teams.ts` | Single line of data |
| DateUtils helpers | `src/lib/dates.ts` | Pure functions |
| `validateMobile`, `validate*` | `src/lib/validate.ts` | Pure functions |
| `attTimeStyle` | `src/lib/format.ts` | Pure function |
| `initials`, `isBirthdayWeek` | `src/lib/format.ts` | Pure functions |
| `contactIcons` URLs (`tel:`, `wa.me/`) | `src/components/ui/ContactIcons.tsx` | URL logic copied, JSX rewritten |
| `CALLING_REASONS` constant | `src/lib/constants.ts` | Single array of data |
| `ACTIVITY_CONFIG` shape | `src/lib/activityConfig.ts` | Config-driven pattern preserved |
| `IMPORT_FIELDS` Excel mapping | `src/lib/excel.ts` | Same column → field mapping |
| All Firestore query bodies (what + where) | `src/api/*.ts` hooks | Logic preserved, wrapped in React Query |
| Per-team aggregation math in `loadDashboard` | `src/lib/aggregations/dashboard.ts` | Pure function, ports clean |
| Care list algorithms (absent, said-coming, etc.) | `src/lib/aggregations/care.ts` | Pure functions |
| AI chat proxy URL + Gemini model waterfall | `src/ai-chat/geminiClient.ts` | URL + retry logic |
| Late-submission threshold (21:00) | `src/lib/constants.ts` | Constant |
| Firestore security rules | New Firebase project | Same rules |

### Rewrite from scratch (React patterns)
| What | Why |
|---|---|
| All HTML templates in `index.html` `<section>` tags | Becomes JSX in page/component files |
| All `onclick="fn(...)"` handlers | Become React `onClick={() => fn(...)}` props |
| All `document.getElementById` DOM manipulation | Becomes React state + refs |
| All `innerHTML = '...'` rendering | Becomes JSX returned from components |
| Tab switching (show/hide via `.active` class) | Becomes React Router routes |
| Event listeners (`window.addEventListener('filtersChanged', ...)`) | Becomes Zustand subscriptions / React Query keys |
| Master filter bar with chip dropdowns | React component with controlled state |
| The picker autocomplete (`setupPicker`, `_initDevoteePicker`) | Single reusable `<Picker>` component |
| Modal management (`openModal`, `closeModal`, popstate) | React `<Modal>` component using portals |
| Toast system (`showToast`) | Wrapper around `react-hot-toast` |
| All gen-counter race guards (`_dashGen`, etc.) | DELETE — React Query handles this |
| All `_xxxInFlight` single-flight wrappers | DELETE — React Query handles this |
| `dispatchFilters` + `filtersChanged` event | DELETE — Zustand store subscription |
| `_mfbOnFiltersChanged` | DELETE — replaced by query key dependencies |
| `_frRefreshChips` | DELETE — chips re-render automatically when store changes |
| Manual `DevoteeCache` | DELETE — React Query's cache handles it |
| Hand-written `sw.js` | DELETE — vite-plugin-pwa generates it |

### Reference but don't copy
| Where | What for |
|---|---|
| [js/ui-core.js:1778](js/ui-core.js#L1778) `switchTab` | Reference for what each tab triggers on mount — translate to `useEffect` in each page |
| [js/ui-core.js:1145](js/ui-core.js#L1145) `initMasterFilterBar` | Reference for chip logic, but rebuild in React |
| [js/ui-analytics.js:62](js/ui-analytics.js#L62) session resolution | Reference for the session/date snap rules |
| Auto-snap logic for future sessions | Reference, port the rules into a `useResolveDashboardSession` hook |
| All `_mfb*`, `_fr*` internal helpers | Reference for what they do, rebuild idiomatically in React |

---

## 8. Critical Business Rules to Preserve

These are non-obvious rules embedded in the current code. They MUST be preserved in the React rewrite. Cross-reference with [CLAUDE.md](CLAUDE.md).

1. **Saturday vs Sunday date keys**
   - `sessionId` / `sessions.sessionDate` = Sunday string `YYYY-MM-DD`
   - `callingStatus.weekDate` / `callingSubmissions.weekDate` = Saturday string (one day before)
   - Always derive via `resolveCallingDate(sessionDate)` (looks up `settings/callingWeek.callingDate`, falls back to sessionDate - 1 day)
   - Test: clearing data for a date must clear both Sunday-keyed and Saturday-keyed records

2. **camelCase ↔ snake_case**
   - Firestore stores camelCase (`teamName`, `isActive`, `callingBy`)
   - Some old UI code expects snake_case (`team_name`, `is_active`, `calling_by`)
   - TypeScript types should pick ONE convention (recommend: camelCase everywhere in new code) and document the mapping explicitly. No `toSnake`/`toCamel` runtime conversions.

3. **Soft-delete only**
   - Devotees never hard-deleted; set `isActive: false`
   - Separate flag `isNotInterested: true` with `notInterestedAt` for "Not Interested" list
   - `callingMode: 'not_interested' | 'online' | 'festival'` is a DIFFERENT axis from `isNotInterested`

4. **Role hierarchy**
   - `superAdmin` — all access
   - `teamAdmin` — scoped to own team
   - `serviceDevotee` — Attendance tab only

5. **`isAttSevaDev` flag**
   - One-session attendance grant for service devotees logging in via the special checkbox
   - Stored in `sessionStorage` as `loginAsService`
   - Grants cross-team attendance marking without permanent role change

6. **First-user bootstrap**
   - If `users` collection is empty at signup, new user gets `superAdmin`
   - Otherwise → goes to `signupRequests` → pending approval

7. **Team filter behavior on non-Devotees tabs**
   - For `teamAdmin` / `serviceDevotee` on any tab except Devotees, team is locked to their own
   - The chip should be **hidden** (not just disabled — recent decision)
   - On Devotees tab, team-locked users can browse all teams

8. **Dashboard session auto-snap**
   - If filter session is FUTURE (and not explicitly picked), snap to most recent past Sunday for the dashboard view
   - Store snap origin in `AppState._autoSnap` so other tabs can restore the future date for live work

9. **Lifetime attendance counter**
   - `devotees.lifetimeAttendance` is incremented atomically on mark-present, decremented on undo
   - Use Firestore `FieldValue.increment(±1)` — never fetch-modify-write

10. **Dual timestamps on writes**
    - `updatedAt`: Firestore `serverTimestamp()`
    - `updatedAtClient`: `new Date().toISOString()`
    - Late-submission report compares `updatedAtClient` hours to 21:00 threshold

11. **Attendance lateness colors**
    - 12:30–12:45 → pink
    - 12:45–13:00 → salmon
    - After 13:00 → red
    - Encapsulated in `attTimeStyle` — preserve as-is

12. **Excel import batching**
    - Cap writes at 400 per batch (Firestore limit is 500, leave headroom)
    - Duplicate key: `name (case-insensitive) + mobile`

13. **Fiscal year boundary**
    - April–March (Indian fiscal year)
    - Used in calling list export date filtering

14. **`callingMode` semantics**
    - `'not_interested'` and `'online'` → exclude from dashboard aggregates
    - `'festival'` → include in festival calling list
    - Different from `isNotInterested` (which is a status flag)

15. **Cancelled sessions still allow attendance marking**
    - `sessions.is_cancelled: true` shows a banner but doesn't block marking

---

## 9. Firestore Schema (for new Firebase project)

Preserve the existing collection structure exactly so:
- Excel export from old → import to new works
- Future devs see the same shape

```ts
// users/{uid}
{
  email: string;
  name: string;
  role: 'superAdmin' | 'teamAdmin' | 'serviceDevotee';
  teamName: string | null;
  position?: string;
  profilePic?: string;
  isAttSevaDev?: boolean;
  status?: 'rejected';
  createdAt: Timestamp;
}

// signupRequests/{id}
{
  email: string;
  name: string;
  requestedAt: Timestamp;
  status: 'pending' | 'rejected';
}

// devotees/{id}
{
  name: string;
  mobile: string;
  altMobile?: string;
  dob?: string; // YYYY-MM-DD
  gender?: 'M' | 'F';
  teamName: string;
  callingBy?: string;
  facilitator?: string;
  referenceBy?: string;
  devoteeStatus?: string;
  chantingRounds?: number;
  instrument?: string;
  notes?: string;
  address?: string;
  isActive: boolean;          // soft-delete flag
  isNotInterested?: boolean;
  notInterestedAt?: Timestamp;
  callingMode?: 'online' | 'not_interested' | 'festival';
  inactivityFlag?: boolean;
  lifetimeAttendance: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// sessions/{id}
{
  sessionDate: string;  // YYYY-MM-DD (Sunday)
  topic?: string;
  is_cancelled?: boolean;
  createdAt: Timestamp;
}

// attendanceRecords/{id}
{
  sessionId: string;
  devoteeId: string;
  devoteeName: string;
  teamName: string | null;
  mobile: string | null;
  referenceBy: string | null;
  callingBy: string | null;
  chantingRounds: number;
  dob: string | null;
  devoteeStatus: string | null;
  isNewDevotee: boolean;
  markedAt: Timestamp;
}

// callingStatus/{id}
{
  devoteeId: string;
  weekDate: string;  // YYYY-MM-DD (Saturday, per resolveCallingDate)
  comingStatus: 'Yes' | '';
  callingNotes: string | null;
  callingReason: string | null;
  availableFrom: string | null;
  lateRemarks: string | null;
  createdAt?: Timestamp;
  createdAtClient?: string;
  updatedAt: Timestamp;
  updatedAtClient: string;
}

// callingSubmissions/{id}
{
  weekDate: string;  // Saturday
  userName: string;
  submittedAt: Timestamp;
  submittedAtClient: string;
}

// callingStatusChanges/{id}  (audit)
{
  devoteeId: string;
  weekDate: string;
  changedAt: Timestamp;
  changedAtClient: string;
  changedBy: string;
  changes: Record<string, { from: string; to: string }>;
}

// profileChanges/{id}  (audit)
{
  devoteeId: string;
  fieldName: string;
  oldValue: string;
  newValue: string;
  changedBy: string;
  changedAt: Timestamp;
}

// events/{id}
{
  name: string;
  date: string;
  // event-specific fields
}

// eventDevotees/{id}
{
  eventId: string;
  devoteeId: string;
  // attendance/payment/transport per event
}

// settings/callingWeek (single doc)
{
  sessionDate: string;  // Sunday
  callingDate: string;  // Saturday (typically Sunday - 1)
  configuredBy: string;
  configuredAt: Timestamp;
}

// settings/attendanceTargets (single doc)
{
  type: 'class';
  global?: number;
  teams: Record<string, number>;
}

// settings/migrations (single doc)
{
  visakhaToVishakha?: boolean;
  // future migration flags
}

// books, donations, registrations, services (activity collections)
// shape per ACTIVITY_CONFIG
```

**Indexes needed (composite):**
- `attendanceRecords`: `(sessionId, devoteeId)`
- `callingStatus`: `(weekDate, devoteeId)`
- `devotees`: `(teamName, isActive)`, `(callingBy, isActive)`
- `callingSubmissions`: `(weekDate, userName)`

---

## 10. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| TypeScript learning curve slows rewrite | Med | Med | If too painful, fall back to JSX (.jsx). Type safety is nice-to-have, not blocker. |
| React Query patterns unfamiliar | Low | High if misused | Use simple `useQuery` + `useMutation` patterns. Avoid Suspense/concurrent features. |
| Firestore quota during testing | Low | Low | Use new Firebase project's free tier. Throttle dev tests. |
| Visual regression vs current app | Med | High | Side-by-side compare each tab. Same browser, same screen. CSS port is verbatim. |
| Missing edge case from old code | High | Med | Read old code carefully per phase. Reference CLAUDE.md business rules section. |
| Firebase v10 modular SDK breaking changes from v8 | Med | Med | Migration guide is clear. Bulk changes are mechanical: `firebase.firestore()` → `getFirestore()`, `.collection().doc()` → `doc(db, 'collection', id)`. |
| PWA install flow differs across browsers | Med | Low | Test iOS Safari + Android Chrome explicitly. Accept "Add to Home Screen" UX differences. |
| Excel import duplicates bug | Low | High | Port Levenshtein algorithm directly. Test with known dataset. |
| User can't test intermediate phases | High | Med | Each phase is independently shippable. Don't rush to next phase until current is verified. |
| Data flow problems repeat in React | Low | High | React Query is THE proven solution for this class of problem. Use it correctly = problem doesn't exist. |
| AI session loses context mid-phase | High (with me) | Med | This PRD itself + phase-by-phase split = future session can pick up at any phase boundary. |

---

## 11. Acceptance Criteria for "Done"

The migration is "done" when:
1. ☐ Every phase's acceptance checklist is fully checked
2. ☐ Side-by-side visual comparison: every tab in new app matches old app pixel-perfect
3. ☐ Every role can complete their full workflow (super admin, team admin, service devotee)
4. ☐ Changing any filter on any tab updates the visible data within 100ms (cache hit) or shows spinner + correct fresh data (cache miss)
5. ☐ Excel exports from new app are byte-similar to old app exports
6. ☐ PWA installs and works offline on Android Chrome and iOS Safari
7. ☐ Lighthouse mobile Performance ≥85, PWA ≥90
8. ☐ Zero TypeScript errors in production build
9. ☐ Zero console errors on every page in production build
10. ☐ Old app's URL can be redirected to new app's URL (or run in parallel)

---

## 12. Suggested Execution Order

If working with AI assistance (e.g., Claude Code) across multiple sessions:

**Session 1:** Phase 0 (setup) + Phase 1 (foundation through auth)
**Session 2:** Phase 1 continued (filter bar + layout) + Phase 2 start
**Session 3:** Phase 2 finish (Devotees)
**Session 4:** Phase 3 (Home/Dashboard)
**Session 5:** Phase 4 part 1 (Live Attendance + Sheet)
**Session 6:** Phase 4 part 2 (sub-tab reports)
**Session 7:** Phase 5 part 1 (Calls + Team Calling)
**Session 8:** Phase 5 part 2 (reports + history)
**Session 9:** Phase 6 (Care) + Phase 7 part 1 (Calling Mgmt)
**Session 10:** Phase 7 finish + Phase 8 (Events)
**Session 11:** Phase 9 (Activities)
**Session 12:** Phase 10 (Reports)
**Session 13:** Phase 11 (Admin Panel)
**Session 14:** Phase 12 (AI Chat) + Phase 13 part 1 (PWA)
**Session 15:** Phase 13 finish (deploy + polish)

Total: ~15 focused sessions, ~30-45 hours of AI work + ~15-20 hours of your testing time = **4-6 weeks elapsed time** at a comfortable pace.

If using a human React developer: ~80-120 hours of focused work, **3-5 weeks elapsed** at full-time pace.

---

## 13. Hand-off Notes for Whoever Builds This

If you're an AI agent or developer picking this up:

1. **Read [CLAUDE.md](CLAUDE.md) first** — it has the business rules and the "Top 4 Footguns" that will save you days.
2. **Read this PRD second** — it has the migration-specific decisions.
3. **Reference the old code as a spec, not as a template to translate line-by-line.** The old code has accumulated patches. Implement the *intent*, not the implementation.
4. **Apply the Bug #1 fix** (clearDataForDate uses resolveCallingDate) — documented in Phase 11. Don't replicate the original bug.
5. **Do NOT replicate the gen-counter / single-flight / coalesce-rerun patterns.** React Query handles all of that. The presence of those patterns in the old code is exactly the smell that prompted this rewrite.
6. **Preserve all class names from `style.css`.** Visual fidelity depends on it.
7. **When in doubt, prefer simpler React patterns** (`useState`, `useEffect`, `useQuery`) over fancier ones (Suspense, RSC, etc.).
8. **Phase ordering matters.** Don't skip Phase 0 to "just try a tab." Foundation first.
9. **Each phase ships independently.** Deploy after every phase. Get user feedback early.
10. **If a phase takes longer than estimated, split it.** Better to ship a small piece than to half-finish a big one.

---

## 14. Appendix — File-by-File Quick Reference

### Files that have clean, reusable BUSINESS LOGIC
- [js/config.js](js/config.js): TEAMS, DateUtils, format helpers, contactIcons, attTimeStyle, DevoteeCache (last one DELETE), TS/INC helpers (replace with v10 SDK equivalents)
- [js/db.js](js/db.js): ALL Firestore query bodies — port the queries themselves, wrap each in a React Query hook
- [js/excel.js](js/excel.js): Export/import flows — preserve the column mapping and Levenshtein dedup
- [js/ui-analytics.js](js/ui-analytics.js): The aggregation math in loadDashboard, care list algorithms, report range derivation

### Files that are mostly UI orchestration (rebuild idiomatically)
- [js/ui-core.js](js/ui-core.js): Auth flow logic (port the *steps*), role gating (port the *rules*), modal/toast (replace entirely), master filter bar (rebuild in React), tab switching (replace with Router)
- [js/ui-devotees.js](js/ui-devotees.js): Form structure (port to React Hook Form), filter logic (delete, use React Query)
- [js/ui-calling.js](js/ui-calling.js): Card markup (port to JSX), filter logic (delete)
- [js/ui-attendance.js](js/ui-attendance.js): Live attendance UI (port to JSX), Sheet grid (port)
- [js/ui-home.js](js/ui-home.js): Greeting + drawers (port)
- [js/ui-activities.js](js/ui-activities.js): ACTIVITY_CONFIG (port), form/report (port driven by config)
- [js/ui-ai-chat.js](js/ui-ai-chat.js): Chat logic (port), URLs (preserve)

### Files that disappear in React
- [sw.js](sw.js): vite-plugin-pwa generates a better one
- [index.html](index.html): becomes a tiny shell + `<div id="root">`; all `<section>` panels become page components
- `START_WEB.bat`: replaced by `npm run dev`

---

**End of PRD.**

Questions, ambiguities, or scope changes → discuss with Riya before proceeding. This document is the source of truth for the rewrite.
