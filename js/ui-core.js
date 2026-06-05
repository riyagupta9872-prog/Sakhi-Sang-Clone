/* ══ UI-CORE.JS – Auth, role UI, admin, pickers, sessions, tabs ══ */

// ── AUTH ──────────────────────────────────────────────
const auth = firebase.auth();

auth.onAuthStateChanged(async (user) => {
  if (!user) {
    // ── Tear down live Firestore listeners so they don't fire for the next user
    if (_signupReqUnsub) { _signupReqUnsub(); _signupReqUnsub = null; }
    _signupReqCache = [];

    // ── Full AppState wipe — prevents role / team / session data leaking to the
    //    next account that logs in on the same browser tab.
    Object.assign(AppState, {
      userRole: null, userTeam: null, userPosition: null,
      userName: '', userId: null, profilePic: null,
      isAttSevaDev: false,
      canAllTeamCalling: false, canAllTeamReports: false, canManageAllTeams: false,
      canBackDateAttendance: false,
      _sessionExplicit: false,
      _dashboard: null, _autoSnap: null,
      callingData: [], attendanceCandidates: {}, sessionsCache: {},
      filters: { sessionId: null, team: '', callingBy: '', period: 'session', periodAnchor: null },
      // Reset currentTab so the next login resolves it fresh from the active
      // DOM panel — prevents a stale tab name from blocking loadDashboard
      // when the dashboard panel is actually visible.
      currentTab: null, _callingSubTab: null, _attSubTab: null,
    });

    // ── Bust the in-memory devotee cache so the next user re-fetches fresh
    DevoteeCache.bust();

    showAuthScreen();
    return;
  }
  AppState.userId = user.uid;
  try {
    let userDoc = await fdb.collection('users').doc(user.uid).get();
    if (!userDoc.exists) {
      // First user EVER bootstraps as superAdmin (so the system has someone
      // who can approve future requests). Everyone else must wait for approval.
      let isFirst = false;
      try {
        const allUsers = await fdb.collection('users').limit(1).get();
        isFirst = allUsers.empty;
      } catch (_) { isFirst = false; }
      if (isFirst) {
        const data = { email: user.email, name: user.displayName || user.email.split('@')[0], role: 'superAdmin', teamName: null, createdAt: TS() };
        await fdb.collection('users').doc(user.uid).set(data);
        userDoc = { data: () => data };
      } else {
        // ── SELF-HEAL ──────────────────────────────────────────────
        // The "Awaiting Approval — for no reason" bug: super admin sees the user
        // by name in user management, but `users/{currentUid}` doesn't exist
        // because the doc was created under an OLD UID (auth account was
        // deleted/recreated, or rejection was reversed). Look up by email and
        // re-link the existing approved row to the current UID.
        let healed = false;
        try {
          const byEmail = await fdb.collection('users')
            .where('email', '==', user.email).limit(3).get();
          const approved = byEmail.docs.find(d =>
            d.id !== user.uid &&
            d.data().status !== 'rejected' &&
            !d.data().migratedTo
          );
          if (approved) {
            const oldData = approved.data();
            // Copy role/team/permissions to the current UID
            await fdb.collection('users').doc(user.uid).set({
              ...oldData,
              email: user.email,
              name: oldData.name || user.displayName || user.email.split('@')[0],
              migratedFrom: approved.id,
              migratedAt: TS(),
            }, { merge: true });
            // Mark the old row as superseded so admin panel can filter it out
            await fdb.collection('users').doc(approved.id).update({
              migratedTo: user.uid,
              migratedAt: TS(),
            });
            userDoc = await fdb.collection('users').doc(user.uid).get();
            healed = true;
          } else {
            // If a REJECTED row exists for this email, mirror it under the new
            // UID so the existing rejection-block path takes over below.
            const rejected = byEmail.docs.find(d => d.data().status === 'rejected');
            if (rejected) {
              await fdb.collection('users').doc(user.uid).set(
                { ...rejected.data(), email: user.email, migratedFrom: rejected.id, migratedAt: TS() },
                { merge: true }
              );
              userDoc = await fdb.collection('users').doc(user.uid).get();
              healed = true;
            }
          }
        } catch (e) { console.warn('Self-heal lookup failed', e); }

        if (!healed) {
          // Genuinely new account with no docs. Make sure a pending request
          // exists so super admin sees it — covers password-reset / direct-login
          // paths that bypass the signup form.
          try {
            const reqRef = fdb.collection('signupRequests').doc(user.uid);
            const reqDoc = await reqRef.get();
            if (!reqDoc.exists || reqDoc.data().status !== 'pending') {
              await reqRef.set({
                uid: user.uid,
                email: user.email,
                name: user.displayName || user.email.split('@')[0],
                status: 'pending',
                createdAt: TS(),
                autoCreated: true,
              }, { merge: true });
            }
          } catch (_) {}
          showPendingApprovalScreen();
          return;
        }
      }
    }
    const ud = userDoc.data();
    if (ud.status === 'rejected') {
      // Their sign-up was explicitly rejected — block sign-in.
      await auth.signOut();
      showAuthScreen();
      const errEl = document.getElementById('login-error');
      if (errEl) {
        errEl.textContent = 'This account was not approved. Please contact your Super Admin.';
        errEl.classList.add('show');
      }
      return;
    }
    AppState.userRole      = ud.role;
    AppState.userTeam      = ud.teamName   || null;
    AppState.userPosition  = ud.position   || null;
    AppState.userName      = ud.name       || user.email;
    AppState.profilePic    = ud.profilePic || null;
    AppState.isAttSevaDev  = !!ud.isAttSevaDev;
    // ── DELEGATION FLAGS ── per-user powers granted by super admin without
    // promoting them to super admin. Each flag widens one specific gate:
    //   canAllTeamCalling  → submit/edit calling on behalf of any team
    //   canAllTeamReports  → view reports across all teams (read-only)
    //   canManageAllTeams  → both above + write access app-wide (lite super admin)
    AppState.canAllTeamCalling = !!ud.canAllTeamCalling || !!ud.canManageAllTeams;
    // Back-date attendance: super admins always; others need the explicit flag.
    AppState.canBackDateAttendance = ud.role === 'superAdmin' || !!ud.canBackDateAttendance || !!ud.canManageAllTeams;
    AppState.canAllTeamReports = !!ud.canAllTeamReports || !!ud.canManageAllTeams;
    AppState.canManageAllTeams = !!ud.canManageAllTeams;
    // "Login as Attendance Service Devotee" — when checked at login, override
    // role to serviceDevotee for THIS session only (the user's actual role in
    // Firestore is unchanged). They'll only see the Attendance tab. Stored in
    // sessionStorage so refresh keeps the mode until they log out.
    const loginAsService =
      sessionStorage.getItem('loginAsService') === 'true' ||
      document.getElementById('login-as-service')?.checked;
    if (loginAsService) {
      sessionStorage.setItem('loginAsService', 'true');
      AppState._actualRole = AppState.userRole;
      AppState.userRole = 'serviceDevotee';
    } else {
      sessionStorage.removeItem('loginAsService');
    }
    hideAuthScreen();
    hidePendingApprovalScreen();
    applyRoleUI();
    await initApp();
    // Super admin only: keep a live count of pending sign-up requests.
    if (AppState.userRole === 'superAdmin') {
      subscribePendingSignups();
      // One-time data migrations — bust cache after so UI updates immediately
      DB.migrateTeamNameOnce('Visakha', 'Vishakha').then(migrated => {
        if (migrated) { DevoteeCache.bust(); if (typeof loadDashboard === 'function') loadDashboard(); }
      }).catch(() => {});
      // Backfill the © "met Prabhuji" flag from existing completed meetings.
      DB.migrateMetPrabhujiOnce().then(migrated => {
        if (migrated) { DevoteeCache.bust(); if (typeof loadDevotees === 'function') loadDevotees(); }
      }).catch(() => {});
    }
  } catch (e) {
    if (e.code === 'permission-denied') {
      document.getElementById('auth-screen').classList.remove('hidden');
      const errEl = document.getElementById('login-error');
      errEl.innerHTML = '⚠️ Firestore rules not set. Go to <b>Firebase Console → Firestore → Rules</b> and paste the rules shown below, then refresh.<br><br><code style="font-size:.75rem;display:block;margin-top:.4rem;background:#f5f5f5;padding:.5rem;border-radius:4px;text-align:left">allow read, write: if request.auth != null;</code>';
      errEl.classList.add('show');
    } else {
      console.error('Auth init', e);
    }
  }
});

function showAuthScreen() { document.getElementById('auth-screen').classList.remove('hidden'); }
function hideAuthScreen() { document.getElementById('auth-screen').classList.add('hidden'); }
let _pendingApprovalUnsub = null;

function showPendingApprovalScreen() {
  document.getElementById('pending-approval-screen')?.classList.remove('hidden');
  document.getElementById('auth-screen').classList.add('hidden');
  // Surface the user's email + Auth UID so they can give it to super admin
  // if their request didn't show up (the "stuck for no reason" case).
  const user = auth.currentUser;
  const uidEl = document.getElementById('pending-uid');
  const emailEl = document.getElementById('pending-email');
  if (uidEl) uidEl.textContent = user?.uid || '—';
  if (emailEl) emailEl.textContent = user?.email || '—';
  // Watch users/{uid} in real-time — fires the moment super admin approves,
  // so the user doesn't have to manually refresh to get in.
  const uid = user?.uid;
  if (uid && !_pendingApprovalUnsub) {
    _pendingApprovalUnsub = fdb.collection('users').doc(uid).onSnapshot(doc => {
      if (doc.exists && doc.data()?.status !== 'rejected') {
        _pendingApprovalUnsub?.();
        _pendingApprovalUnsub = null;
        window.location.reload();
      }
    }, () => {});
  }
}
function hidePendingApprovalScreen() {
  document.getElementById('pending-approval-screen')?.classList.add('hidden');
  _pendingApprovalUnsub?.();
  _pendingApprovalUnsub = null;
}

function switchAuthTab(tab, btn) {
  document.querySelectorAll('.auth-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('login-form').classList.toggle('hidden', tab !== 'login');
  document.getElementById('signup-form').classList.toggle('hidden', tab !== 'signup');
}

document.addEventListener('DOMContentLoaded', () => {
  const roleSelect = document.getElementById('signup-role');
  if (roleSelect) {
    roleSelect.addEventListener('change', () => {
      document.getElementById('signup-team-field').style.display = 'flex';
    });
  }
  document.getElementById('login-form')?.addEventListener('submit', doLogin);
  document.getElementById('signup-form')?.addEventListener('submit', doSignup);
  document.getElementById('today-date').textContent = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
});

async function doLogin(e) {
  e.preventDefault();
  const err = document.getElementById('login-error');
  err.classList.remove('show');
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  try {
    await auth.signInWithEmailAndPassword(email, password);
  } catch (ex) {
    const badCred = ['auth/wrong-password','auth/user-not-found','auth/invalid-credential','auth/invalid-email'];
    err.textContent = badCred.includes(ex.code) ? 'Invalid email or password' : ex.message;
    err.classList.add('show');
  }
}

let _signupBusy = false;

async function doSignup(e) {
  e.preventDefault();
  if (_signupBusy) return;           // block double-tap
  _signupBusy = true;

  const err    = document.getElementById('signup-error');
  const btn    = document.querySelector('#signup-form button[type="submit"]');
  const origTxt = btn?.innerHTML;
  err.classList.remove('show');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending…'; }

  const name     = document.getElementById('signup-name').value.trim();
  const email    = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  const role     = document.getElementById('signup-role').value;
  const team     = document.getElementById('signup-team').value;

  const _resetBtn = () => {
    _signupBusy = false;
    if (btn) { btn.disabled = false; btn.innerHTML = origTxt; }
  };

  if (password.length < 6) {
    err.textContent = 'Password must be at least 6 characters';
    err.classList.add('show');
    _resetBtn(); return;
  }
  try {
    // Check if this email already has a pending signup request to avoid duplicates
    const dupCheck = await fdb.collection('signupRequests')
      .where('email', '==', email).where('status', '==', 'pending').limit(1).get();
    if (!dupCheck.empty) {
      showPendingApprovalScreen();
      _resetBtn(); return;
    }

    const cred = await auth.createUserWithEmailAndPassword(email, password);
    await cred.user.updateProfile({ displayName: name });
    // First user EVER bootstraps as approved superAdmin. Everyone else lands
    // in signupRequests for super admin to approve.
    const existing = await fdb.collection('users').limit(2).get();
    const isFirst = existing.docs.filter(d => d.id !== cred.user.uid).length === 0;
    if (isFirst) {
      await fdb.collection('users').doc(cred.user.uid).set({
        email, name, role: 'superAdmin', teamName: null, createdAt: TS()
      });
      _resetBtn(); return;  // onAuthStateChanged will pick them up as super admin
    }
    // Record the request — they'll see the "Awaiting approval" gate.
    await fdb.collection('signupRequests').doc(cred.user.uid).set({
      uid:           cred.user.uid,
      email, name,
      requestedRole: role,
      requestedTeam: team || null,
      status:        'pending',
      createdAt:     TS(),
    });
    showPendingApprovalScreen();
    _resetBtn();
  } catch (ex) {
    err.textContent = ex.code === 'auth/email-already-in-use' ? 'Email already registered' : ex.message;
    err.classList.add('show');
    _resetBtn();
  }
}

function togglePw(inputId, btn) {
  const inp = document.getElementById(inputId);
  const showing = inp.type === 'text';
  inp.type = showing ? 'password' : 'text';
  btn.querySelector('i').className = showing ? 'fas fa-eye' : 'fas fa-eye-slash';
}

async function doForgotPassword() {
  const email = document.getElementById('login-email').value.trim();
  if (!email) {
    const err = document.getElementById('login-error');
    err.textContent = 'Enter your email address above, then click Forgot password.';
    err.classList.add('show');
    document.getElementById('login-email').focus();
    return;
  }
  try {
    await auth.sendPasswordResetEmail(email);
    const err = document.getElementById('login-error');
    err.style.cssText = 'background:#e8f5e9;color:#2e7d32;border:1.5px solid #a5d6a7;display:block';
    err.textContent = `Password reset email sent to ${email}. Check your inbox.`;
    err.classList.add('show');
  } catch (ex) {
    const err = document.getElementById('login-error');
    err.style.cssText = '';
    err.textContent = ex.code === 'auth/user-not-found' ? 'No account found with this email.' : ex.message;
    err.classList.add('show');
  }
}

async function doLogout() {
  if (!confirm('Log out?')) return;
  sessionStorage.clear(); // wipe all session flags (loginAsService, etc.)
  await auth.signOut();   // triggers onAuthStateChanged(null) which resets AppState + cache
  // Hard reload after sign-out: the only guaranteed way to clear ALL module-level
  // JS state (cache vars in analytics, calling, devotees, etc. across 5 files).
  // onAuthStateChanged(null) already wiped AppState + DevoteeCache, so the page
  // that loads will start completely clean.
  location.reload();
}

// ── SIGN-UP REQUESTS (super admin) ─────────────────────
let _signupReqUnsub = null;
let _signupReqCache = [];

function subscribePendingSignups() {
  if (_signupReqUnsub) return;
  try {
    _signupReqUnsub = fdb.collection('signupRequests')
      .where('status', '==', 'pending')
      .onSnapshot(snap => {
        _signupReqCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        _updateSignupBadges(_signupReqCache.length);
        // If the modal is open, refresh its content
        const open = !document.getElementById('signup-requests-modal')?.classList.contains('hidden');
        if (open) renderSignupRequests();
      }, err => { console.error('signupRequests subscription', err); });
  } catch (e) { console.error('subscribePendingSignups', e); }
}

function _updateSignupBadges(count) {
  const navBadge = document.getElementById('sidebar-badge');
  const itemBadge = document.getElementById('signup-pending-badge');
  if (navBadge) {
    navBadge.classList.toggle('hidden', !count);
    navBadge.textContent = count > 9 ? '9+' : String(count);
  }
  if (itemBadge) {
    itemBadge.classList.toggle('hidden', !count);
    itemBadge.textContent = String(count);
  }
}

function openSignupRequests() {
  closeSidebar();
  openModal('signup-requests-modal');
  renderSignupRequests();
}

function renderSignupRequests() {
  const el = document.getElementById('signup-requests-list');
  if (!el) return;
  if (!_signupReqCache.length) {
    el.innerHTML = '<div class="empty-state" style="padding:2rem"><i class="fas fa-check-circle" style="color:var(--success)"></i><p>No pending sign-up requests.</p></div>';
    return;
  }
  // Sort newest first
  const rows = [..._signupReqCache].sort((a, b) => {
    const ta = a.createdAt?.toMillis?.() || 0;
    const tb = b.createdAt?.toMillis?.() || 0;
    return tb - ta;
  });
  const teamOptions = '<option value="">— No team —</option>' +
    TEAMS.map(t => `<option value="${t}">${t}</option>`).join('');
  el.innerHTML = rows.map(r => {
    const when = r.createdAt?.toDate
      ? r.createdAt.toDate().toLocaleString('en-IN', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' })
      : '—';
    const safeName = (r.name || '').replace(/"/g, '&quot;');
    return `<div class="signup-req-row">
      <div class="devotee-avatar" style="width:42px;height:42px;font-size:.85rem;flex-shrink:0">${initials(r.name || r.email)}</div>
      <div class="signup-req-info">
        <div class="signup-req-name">${r.name || '(unnamed)'}</div>
        <div class="signup-req-meta">
          <i class="fas fa-envelope"></i> ${r.email || '—'}
          &nbsp;·&nbsp; requested ${when}
          ${r.requestedRole ? '&nbsp;·&nbsp; wants <strong>' + (r.requestedRole === 'teamAdmin' ? 'Coordinator' : 'Facilitator') + '</strong>' : ''}
          ${r.requestedTeam ? ' for <strong>' + r.requestedTeam + '</strong>' : ''}
        </div>
      </div>
      <div class="signup-req-actions">
        <select id="srq-role-${r.id}" class="filter-select">
          <option value="serviceDevotee"${r.requestedRole==='serviceDevotee'?' selected':''}>Facilitator</option>
          <option value="teamAdmin"${r.requestedRole==='teamAdmin'?' selected':''}>Coordinator</option>
          <option value="superAdmin">Super Admin</option>
        </select>
        <select id="srq-team-${r.id}" class="filter-select">
          ${teamOptions.replace(`value="${(r.requestedTeam||'').replace(/"/g,'&quot;')}"`, `value="${(r.requestedTeam||'').replace(/"/g,'&quot;')}" selected`)}
        </select>
        <button class="btn btn-secondary" onclick="contactSignupRequest('${r.email||''}','${safeName}')" title="Email"><i class="fas fa-envelope"></i></button>
        <button class="btn btn-primary" onclick="approveSignupRequest('${r.id}')"><i class="fas fa-check"></i> Approve</button>
        <button class="btn btn-danger" onclick="rejectSignupRequest('${r.id}')"><i class="fas fa-times"></i> Reject</button>
      </div>
    </div>`;
  }).join('');
}

async function approveSignupRequest(id) {
  const r = _signupReqCache.find(x => x.id === id);
  if (!r) return;
  const role = document.getElementById('srq-role-' + id)?.value || 'serviceDevotee';
  const team = document.getElementById('srq-team-' + id)?.value || null;
  try {
    // Create the users/{uid} doc — this is what onAuthStateChanged looks for.
    await fdb.collection('users').doc(r.uid).set({
      email: r.email,
      name:  r.name,
      role,
      teamName: team || null,
      createdAt: TS(),
      approvedBy: AppState.userName,
      approvedAt: TS(),
    });
    await fdb.collection('signupRequests').doc(id).update({
      status: 'approved',
      decidedBy: AppState.userName,
      decidedAt: TS(),
      assignedRole: role,
      assignedTeam: team || null,
    });
    showToast(`Approved ${r.name || r.email}`, 'success');
  } catch (e) {
    showToast('Approval failed: ' + (e.message || 'Error'), 'error');
  }
}

async function rejectSignupRequest(id) {
  const r = _signupReqCache.find(x => x.id === id);
  if (!r) return;
  if (!confirm(`Reject sign-up request from ${r.name || r.email}?\n\nThey won't be able to access the app.`)) return;
  try {
    const now = TS();
    // Write a users doc with status:'rejected' so onAuthStateChanged can block sign-in.
    await fdb.collection('users').doc(r.uid).set({
      email: r.email || '', name: r.name || '', status: 'rejected',
      role: 'serviceDevotee', teamName: null,
      rejectedBy: AppState.userName, rejectedAt: now,
    });
    await fdb.collection('signupRequests').doc(id).update({
      status: 'rejected',
      decidedBy: AppState.userName,
      decidedAt: now,
    });
    showToast(`Rejected ${r.name || r.email}`, 'success');
  } catch (e) {
    showToast('Reject failed: ' + (e.message || 'Error'), 'error');
  }
}

// Open the super admin's mail client pre-filled to the requester. Client-side
// JavaScript can't reliably send email itself; mailto is the universal fallback.
function contactSignupRequest(email, name) {
  if (!email) { showToast('No email on this request', 'error'); return; }
  const subj = encodeURIComponent('Your Sakhi Sang account');
  const body = encodeURIComponent(`Hare Krishna ${name || ''},\n\nRegarding your Sakhi Sang sign-up request — `);
  window.location.href = `mailto:${email}?subject=${subj}&body=${body}`;
}

// ── EDIT PROFILE ─────────────────────────────────────
let _pendingProfilePic = undefined;

function openEditProfile() {
  _pendingProfilePic = undefined;
  document.getElementById('edit-profile-name').value     = AppState.userName || '';
  document.getElementById('edit-profile-position').value = AppState.userPosition || '';
  document.getElementById('edit-profile-error').style.display = 'none';
  document.getElementById('profile-pic-input').value = '';
  _renderProfilePicPreview(AppState.profilePic || null);

  const isSuperAdmin = AppState.userRole === 'superAdmin';
  const teamSelect   = document.getElementById('edit-profile-team');
  const teamReadonly = document.getElementById('edit-profile-team-readonly');
  const teamNote     = document.getElementById('edit-profile-team-note');

  if (isSuperAdmin) {
    teamSelect.style.display   = '';
    teamReadonly.style.display = 'none';
    teamNote.style.display     = 'none';
    teamSelect.value           = AppState.userTeam || '';
  } else {
    teamSelect.style.display   = 'none';
    teamReadonly.style.display = '';
    teamReadonly.textContent   = AppState.userTeam || '— Not assigned —';
    teamNote.style.display     = '';
  }

  openModal('edit-profile-modal');
}

function _renderProfilePicPreview(src) {
  const img   = document.getElementById('profile-pic-img');
  const inits = document.getElementById('profile-pic-initials');
  const rmBtn = document.getElementById('remove-pic-btn');
  if (src) {
    img.src = src; img.style.display = 'block';
    inits.style.display = 'none';
    rmBtn.style.display = '';
  } else {
    img.style.display = 'none';
    inits.textContent = initials(AppState.userName || '?');
    inits.style.display = '';
    rmBtn.style.display = 'none';
  }
}

function handleProfilePicSelect(e) {
  const file = e.target.files[0];
  if (!file) return;
  const errEl = document.getElementById('edit-profile-error');
  errEl.style.display = 'none';
  if (file.size > 300 * 1024) {
    errEl.textContent = `Image is too large (${(file.size / 1024).toFixed(1)} KB). Please choose an image under 300 KB.`;
    errEl.style.display = 'block';
    e.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = ev => {
    _pendingProfilePic = ev.target.result;
    _renderProfilePicPreview(_pendingProfilePic);
  };
  reader.readAsDataURL(file);
}

function removeProfilePic() {
  _pendingProfilePic = null;
  _renderProfilePicPreview(null);
}

async function saveEditProfile() {
  const name     = document.getElementById('edit-profile-name').value.trim();
  const position = document.getElementById('edit-profile-position').value.trim() || null;
  const errEl    = document.getElementById('edit-profile-error');
  errEl.style.display = 'none';
  if (!name) { errEl.textContent = 'Name cannot be empty.'; errEl.style.display = 'block'; return; }

  const oldName = AppState.userName;
  const nameChanged = name !== oldName;

  const updates = { name, position, updatedAt: TS() };
  if (AppState.userRole === 'superAdmin') {
    updates.teamName = document.getElementById('edit-profile-team').value || null;
  }
  if (_pendingProfilePic !== undefined) updates.profilePic = _pendingProfilePic;

  try {
    await fdb.collection('users').doc(AppState.userId).update(updates);
    // Propagate new name to all devotees whose callingBy still holds the old name
    if (nameChanged && oldName) {
      DB.updateCallingByName(oldName, name).then(() => DevoteeCache.bust()).catch(() => {});
    }
    AppState.userName     = name;
    AppState.userPosition = position;
    if (AppState.userRole === 'superAdmin') AppState.userTeam = updates.teamName;
    if (_pendingProfilePic !== undefined) AppState.profilePic = _pendingProfilePic || null;
    document.getElementById('header-user-name').textContent = name;
    _applyHeaderAvatar();
    applyRoleUI();
    closeModal('edit-profile-modal');
    showToast('Profile updated! Hare Krishna 🙏', 'success');
  } catch (ex) {
    errEl.textContent = 'Save failed: ' + ex.message;
    errEl.style.display = 'block';
  }
}

function _applyHeaderAvatar() {
  _applySidebarInfo();
}

function _applySidebarInfo() {
  const img   = document.getElementById('sidebar-avatar-img');
  const inits = document.getElementById('sidebar-avatar-initials');
  const name  = document.getElementById('sidebar-user-name');
  const role  = document.getElementById('sidebar-user-role');
  if (name) name.textContent = AppState.userName || '';
  if (role) {
    const r = AppState.userRole;
    const t = AppState.userTeam;
    const p = AppState.userPosition;
    role.textContent = r === 'superAdmin' ? 'Super Admin'
      : r === 'teamAdmin' ? (t ? `${t} · Coordinator` : 'Coordinator')
      : (t ? `${t} · ${p || 'Facilitator'}` : (p || 'Facilitator'));
  }
  const pic = AppState.profilePic;
  if (img && inits) {
    if (pic) {
      img.src = pic; img.style.display = 'block';
      inits.style.display = 'none';
    } else {
      img.style.display = 'none';
      inits.textContent = initials(AppState.userName || '?');
      inits.style.display = '';
    }
  }
}

// ── SIDEBAR ────────────────────────────────────────────
// ── APP STORAGE TRACKER ───────────────────────────────
// Estimates Firestore storage by reading document JSON sizes.
// Firestore free tier limit: 1 GB. Estimate = raw JSON size × 1.5 (index overhead).
let _storageCache = null;      // { ts, totalBytes, rows }
const _STORAGE_TTL = 5 * 60 * 1000; // 5 min
const _STORAGE_LIMIT_GB = 1;

const _STORAGE_COLS = [
  { label: 'Devotees',    col: 'devotees'          },
  { label: 'Attendance',  col: 'attendanceRecords'  },
  { label: 'Calling',     col: 'callingStatus'      },
  { label: 'Submissions', col: 'callingSubmissions' },
  { label: 'Sessions',    col: 'sessions'           },
  { label: 'Users',       col: 'users'              },
  { label: 'Events',      col: 'events'             },
  { label: 'Evt Members', col: 'eventDevotees'      },
  { label: 'Profile Log', col: 'profileChanges'     },
  { label: 'Signups',     col: 'signupRequests'     },
];

function _fmtBytes(b) {
  if (b < 1024)           return b + ' B';
  if (b < 1024 * 1024)    return (b / 1024).toFixed(1) + ' KB';
  return (b / (1024 * 1024)).toFixed(2) + ' MB';
}

async function _calcStorage() {
  // Fetch all collections in parallel — ~10x faster than sequential awaits
  const rows = await Promise.all(_STORAGE_COLS.map(async ({ label, col }) => {
    try {
      const snap = await fdb.collection(col).get();
      let bytes = 0;
      snap.docs.forEach(doc => {
        bytes += col.length + doc.id.length + 2;
        bytes += JSON.stringify(doc.data()).length;
      });
      return { label, count: snap.size, bytes };
    } catch (_) {
      return { label, count: 0, bytes: 0 };
    }
  }));
  const totalRaw = rows.reduce((sum, r) => sum + r.bytes, 0);
  return { totalBytes: Math.round(totalRaw * 1.5), rows };
}

const _STORAGE_ROW_COLORS = ['#6366f1','#f59e0b','#10b981','#ef4444','#8b5cf6'];

function _renderStorageWidget(data) {
  const body = document.getElementById('sidebar-storage-body');
  if (!body) return;
  body.className = ''; // clear sidebar-storage-idle flex layout
  const { totalBytes, rows } = data;
  const limitBytes = _STORAGE_LIMIT_GB * 1024 * 1024 * 1024;
  const pct        = Math.min(100, (totalBytes / limitBytes) * 100);
  const barColor   = pct < 50 ? '#16a34a' : pct < 80 ? '#d97706' : '#dc2626';
  const topRows    = [...rows].filter(r => r.bytes > 0)
                              .sort((a, b) => b.bytes - a.bytes)
                              .slice(0, 5);

  const rowsHtml = topRows.map((r, i) => `
    <div class="ss-row">
      <span class="ss-row-dot" style="background:${_STORAGE_ROW_COLORS[i % _STORAGE_ROW_COLORS.length]}"></span>
      <span class="ss-row-label">${r.label}</span>
      <span class="ss-row-count">${r.count.toLocaleString()}</span>
      <span class="ss-row-size" style="color:${_STORAGE_ROW_COLORS[i % _STORAGE_ROW_COLORS.length]}">${_fmtBytes(Math.round(r.bytes * 1.5))}</span>
    </div>`).join('');

  body.innerHTML = `
    <div class="ss-bar-section">
      <div class="ss-bar-track">
        <div class="ss-bar-fill" style="width:${Math.max(pct, 0.4).toFixed(2)}%;background:${barColor}"></div>
      </div>
      <div class="ss-bar-meta">
        <span class="ss-bar-pct" style="color:${barColor}">${pct < 0.1 ? '&lt;0.1' : pct.toFixed(1)}%</span>
        <span class="ss-used-line"><strong>${_fmtBytes(totalBytes)}</strong> of 1 GB</span>
      </div>
    </div>
    <div class="ss-rows">${rowsHtml}</div>
    <div class="ss-note">~ includes index overhead</div>`;
}

async function refreshStorageStats(force = true) {
  if (AppState.userRole !== 'superAdmin') return;
  if (!force && _storageCache && Date.now() - _storageCache.ts < _STORAGE_TTL) {
    _renderStorageWidget(_storageCache);
    return;
  }
  const body   = document.getElementById('sidebar-storage-body');
  const icon   = document.getElementById('storage-refresh-icon');
  const btn    = document.getElementById('storage-refresh-btn');
  if (body) { body.className = ''; body.innerHTML = '<div class="ss-loading"><i class="fas fa-circle-notch fa-spin"></i> Calculating…</div>'; }
  if (icon) icon.classList.add('fa-spin');
  if (btn)  btn.disabled = true;
  try {
    const data = await _calcStorage();
    _storageCache = { ts: Date.now(), ...data };
    _renderStorageWidget(_storageCache);
  } catch (e) {
    if (body) body.innerHTML = '<div class="ss-loading" style="color:var(--danger)"><i class="fas fa-exclamation-circle"></i> Failed</div>';
  } finally {
    if (icon) icon.classList.remove('fa-spin');
    if (btn)  btn.disabled = false;
  }
}
window.refreshStorageStats = refreshStorageStats;
// ── END APP STORAGE TRACKER ───────────────────────────

function openSidebar() {
  const sb = document.getElementById('app-sidebar');
  if (!sb || sb.classList.contains('open')) return;
  _applySidebarInfo();
  sb.classList.add('open');
  document.getElementById('sidebar-overlay')?.classList.remove('hidden');
  _ensureOverlayHistory?.();
  // Refresh storage stats quietly (uses cache if fresh)
  if (AppState.userRole === 'superAdmin') refreshStorageStats(false);
}
function closeSidebar() {
  const sb = document.getElementById('app-sidebar');
  if (!sb) return;
  sb.classList.remove('open');
  document.getElementById('sidebar-overlay')?.classList.add('hidden');
}

// Collapsible group inside the sidebar (Management / Reports).
// Click the header → toggles the .expanded class on the .sidebar-group parent.
function toggleSidebarGroup(headerEl) {
  const group = headerEl.closest('.sidebar-group');
  if (!group) return;
  group.classList.toggle('expanded');
}

// ── SESSION CONFIGURATION ──────────────────────────────
async function openSessionConfig() {
  closeSidebar();
  try {
    const cfg = await DB.getCallingWeekConfig();
    document.getElementById('sc-topic').value           = cfg?.topic        || '';
    document.getElementById('sc-speaker').value         = cfg?.speakerName  || '';
    document.getElementById('sc-session-type').value    = cfg?.sessionType  || 'regular';
    document.getElementById('sc-calling-date').value    = cfg?.callingDate  || '';
    document.getElementById('sc-attendance-date').value = cfg?.sessionDate  || '';
    document.getElementById('sc-calling-window').checked = cfg?.callingWindowOpen === true;
  } catch (_) {}
  openModal('session-config-modal');
}

async function saveSessionConfig() {
  const topic       = document.getElementById('sc-topic').value.trim();
  const speakerName = document.getElementById('sc-speaker').value.trim();
  const sessionType = document.getElementById('sc-session-type').value;
  const callingDate = document.getElementById('sc-calling-date').value;
  const sessionDate = document.getElementById('sc-attendance-date').value;
  const callingWindowOpen = document.getElementById('sc-calling-window').checked;
  if (!callingDate) { showToast('Calling date is required', 'error'); return; }
  if (!sessionDate) { showToast('Attendance date is required', 'error'); return; }
  try {
    await DB.setCallingWeekConfig(callingDate, sessionDate, { topic, speakerName, sessionType, callingWindowOpen });
    closeModal('session-config-modal');
    showToast('Session configured! Hare Krishna 🙏', 'success');
    if (AppState.currentTab === 'calling') loadCallingStatus?.();
    if (AppState.currentTab === 'attendance') loadAttendanceTab?.();
  } catch (e) {
    showToast('Save failed: ' + (e.message || 'Check connection'), 'error');
  }
}

// ── CALLING DATE RESOLVER ──────────────────────────────
// callingStatus docs store Saturday's date as weekDate, not the Sunday session date.
// All callingStatus queries must use the calling date, not the session date.
async function resolveCallingDate(sessionDate) {
  if (!sessionDate) return null;
  try {
    const cfg = await DB.getCallingWeekConfig();
    if (cfg?.sessionDate === sessionDate && cfg?.callingDate) return cfg.callingDate;
  } catch (_) {}
  const d = new Date(sessionDate + 'T00:00:00');
  d.setDate(d.getDate() - 1);
  return localDateStr(d);
}

// ── SESSION MANAGEMENT ─────────────────────────────────
async function openSessionManagement() {
  closeSidebar();
  openModal('session-mgmt-modal');
  await loadSessionManagementList();
}

async function loadSessionManagementList() {
  const body = document.getElementById('sess-mgmt-body');
  body.innerHTML = '<tr><td colspan="4" class="loading-cell"><i class="fas fa-spinner fa-spin"></i> Loading sessions…</td></tr>';
  try {
    const sessions = await DB.getSessionsWithPresent();
    if (!sessions.length) {
      body.innerHTML = '<tr><td colspan="4" class="empty-cell">No sessions found.</td></tr>';
      return;
    }
    const today = getToday();
    body.innerHTML = sessions.map(s => {
      const isPast    = s.session_date <= today;
      const dateLabel = new Date(s.session_date + 'T00:00:00')
        .toLocaleDateString('en-IN', { weekday:'short', day:'numeric', month:'short', year:'numeric' });
      const topicHtml = s.topic
        ? `<span style="font-size:.83rem">${s.topic}</span>`
        : `<span style="color:var(--text-muted);font-size:.8rem;font-style:italic">—</span>`;
      const cancelBadge = s.is_cancelled
        ? `<span style="background:#fce4ec;color:#c62828;font-size:.7rem;padding:.1rem .35rem;border-radius:4px;margin-left:.35rem">Cancelled</span>` : '';
      const presentBadge = isPast
        ? `<span class="smgr-present">${s.present}</span>`
        : `<span style="color:var(--text-muted);font-size:.8rem">—</span>`;
      const topicStr   = (s.topic || '').replace(/'/g, "\\'");
      const cancelVal  = s.is_cancelled ? 'true' : 'false';
      return `<tr>
        <td class="smgr-date">${dateLabel}${cancelBadge}</td>
        <td class="smgr-topic">${topicHtml}</td>
        <td class="smgr-cnt">${presentBadge}</td>
        <td class="smgr-act">
          <button class="btn-icon smgr-edit-btn" title="Edit"
            onclick="openEditSessionModal('${s.id}','${s.session_date}','${topicStr}',${cancelVal})">
            <i class="fas fa-pencil-alt"></i>
          </button>
        </td>
      </tr>`;
    }).join('');
  } catch (e) {
    body.innerHTML = `<tr><td colspan="4" class="empty-cell">Error: ${e.message}</td></tr>`;
  }
}

function openEditSessionModal(sessionId, sessionDate, topic, isCancelled) {
  document.getElementById('esm-session-id').value   = sessionId;
  document.getElementById('esm-session-date').value = sessionDate;
  document.getElementById('esm-topic').value        = topic || '';
  document.getElementById('esm-cancelled').checked  = !!isCancelled;
  const label = new Date(sessionDate + 'T00:00:00')
    .toLocaleDateString('en-IN', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  document.getElementById('esm-date-label').textContent = label;
  openModal('edit-session-modal');
}

async function saveEditSession() {
  const sessionId   = document.getElementById('esm-session-id').value;
  const topic       = document.getElementById('esm-topic').value.trim();
  const isCancelled = document.getElementById('esm-cancelled').checked;
  if (!sessionId) return;
  try {
    await DB.configureSunday(sessionId, { topic, isCancelled });
    closeModal('edit-session-modal');
    showToast('Session updated! Hare Krishna 🙏', 'success');
    await loadSessionManagementList();
    // Refresh session cache
    if (AppState.sessionsCache[sessionId]) {
      AppState.sessionsCache[sessionId].topic        = topic;
      AppState.sessionsCache[sessionId].is_cancelled = isCancelled;
    }
  } catch (e) {
    showToast('Save failed: ' + (e.message || 'Check connection'), 'error');
  }
}

// ── CHANGE PASSWORD ────────────────────────────────────
function openChangePassword() {
  closeSidebar();
  ['cp-current','cp-new','cp-confirm'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const err = document.getElementById('cp-error'); if (err) err.style.display = 'none';
  openModal('change-password-modal');
}

async function doChangePassword() {
  const cur = document.getElementById('cp-current').value;
  const nw  = document.getElementById('cp-new').value;
  const cf  = document.getElementById('cp-confirm').value;
  const err = document.getElementById('cp-error');
  err.style.display = 'none';
  if (!cur || !nw || !cf) { err.textContent = 'All fields are required.'; err.style.display = 'block'; return; }
  if (nw.length < 6)      { err.textContent = 'New password must be at least 6 characters.'; err.style.display = 'block'; return; }
  if (nw !== cf)          { err.textContent = 'New passwords do not match.'; err.style.display = 'block'; return; }
  const user = auth.currentUser;
  if (!user) { err.textContent = 'Not signed in.'; err.style.display = 'block'; return; }
  try {
    const cred = firebase.auth.EmailAuthProvider.credential(user.email, cur);
    await user.reauthenticateWithCredential(cred);
    await user.updatePassword(nw);
    closeModal('change-password-modal');
    showToast('Password updated! Hare Krishna 🙏', 'success');
  } catch (e) {
    err.textContent = e.code === 'auth/wrong-password' ? 'Current password is incorrect.'
      : e.code === 'auth/weak-password' ? 'Password is too weak.'
      : (e.message || 'Could not update password.');
    err.style.display = 'block';
  }
}

// ── USER MANAGEMENT (enhanced) ─────────────────────────
let _umUsers = [];

async function openUserManagement() {
  closeSidebar();
  openModal('user-mgmt-modal');
  const list = document.getElementById('um-list');
  list.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading users…</div>';
  try {
    const snap = await fdb.collection('users').get();
    _umUsers = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
    // Hide rows superseded by self-heal (their Auth UID was re-linked to a new doc).
    // The "Migrated" details section in renderUserMgmtList still lets super admin
    // see + purge these if they want.
    _umUsers = _umUsers.filter(u => !u.migratedTo);
    _umUsers.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
    renderUserMgmtList();
  } catch (_) {
    list.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load users</p></div>';
  }
}

function renderUserMgmtList() {
  const list = document.getElementById('um-list');
  if (!list) return;
  const q = (document.getElementById('um-search')?.value || '').toLowerCase().trim();
  const filtered = _umUsers.filter(u => {
    if (!q) return true;
    return (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q);
  });

  // Diagnostic banner at top — shortcut to find users stuck on "Awaiting Approval"
  const banner = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:.5rem;margin-bottom:.75rem;padding:.55rem .75rem;background:#fffbeb;border:1px solid #fde68a;border-radius:var(--radius)">
      <div style="font-size:.78rem;color:#92400e">
        <i class="fas fa-stethoscope"></i> User stuck on <strong>"Awaiting Approval"</strong>?
        <span style="color:var(--text-muted)"> Their Auth UID may not match their users-doc.</span>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="openStuckUserFinder()"><i class="fas fa-search"></i> Find by Email</button>
    </div>`;

  if (!filtered.length) {
    list.innerHTML = banner + '<div class="empty-state"><i class="fas fa-user-slash"></i><p>No users found</p></div>';
    return;
  }

  // Group by role for clear bifurcation: Super Admins → Coordinators → Facilitators.
  const groups = { superAdmin: [], teamAdmin: [], serviceDevotee: [], other: [] };
  filtered.forEach(u => {
    const k = u.role === 'superAdmin' || u.role === 'teamAdmin' || u.role === 'serviceDevotee' ? u.role : 'other';
    groups[k].push(u);
  });
  Object.values(groups).forEach(arr => arr.sort((a, b) => (a.name || '').localeCompare(b.name || '')));

  const sectionDef = [
    { key: 'superAdmin',     label: 'Super Admins',  icon: 'fa-user-shield' },
    { key: 'teamAdmin',      label: 'Coordinators',  icon: 'fa-user-tie' },
    { key: 'serviceDevotee', label: 'Facilitators',  icon: 'fa-headset' },
    { key: 'other',          label: 'Other',         icon: 'fa-user' },
  ];

  const sections = sectionDef.filter(s => groups[s.key].length).map(s => {
    const rows = groups[s.key].map(u => _umRowHtml(u)).join('');
    return `<section class="um-section">
      <h3 class="um-section-head"><i class="fas ${s.icon}"></i> ${s.label}
        <span class="um-section-count">${groups[s.key].length}</span></h3>
      <div class="um-section-body">${rows}</div>
    </section>`;
  }).join('');

  list.innerHTML = banner + sections;
}

function _umRowHtml(u) {
  const roleLabel = u.role === 'superAdmin' ? 'Super Admin'
    : u.role === 'teamAdmin' ? 'Coordinator' : 'Facilitator';
  const customTitle = u.position && u.position.toLowerCase() !== roleLabel.toLowerCase() ? u.position : '';
  const tags = [];
  if (u.teamName)   tags.push(`<span class="um-tag um-tag-team">${u.teamName}</span>`);
  if (customTitle)  tags.push(`<span class="um-tag um-tag-title">${customTitle}</span>`);
  if (u.isAttSevaDev)      tags.push('<span class="um-booster" title="Live attendance across teams">Att.Seva</span>');
  if (u.canBackDateAttendance) tags.push('<span class="um-booster" title="Can mark attendance on past sessions">Back-date</span>');
  if (u.canAllTeamCalling) tags.push('<span class="um-booster" title="Cross-team calling submit">All-Call</span>');
  if (u.canAllTeamReports) tags.push('<span class="um-booster" title="Reports across teams">All-Rpts</span>');
  if (u.canManageAllTeams) tags.push('<span class="um-booster um-booster-strong" title="Lite super admin">Mgr-All</span>');
  return `<button type="button" class="um-row" onclick="openUserAction('${u.uid}')">
    <span class="um-avatar">${initials(u.name || u.email)}</span>
    <span class="um-info">
      <span class="um-name">${u.name || u.email}</span>
      ${u.email ? `<span class="um-meta">${u.email}</span>` : ''}
      ${tags.length ? `<span class="um-tags">${tags.join('')}</span>` : ''}
    </span>
    <i class="fas fa-chevron-right um-chevron"></i>
  </button>`;
}

function openUserAction(uid) {
  const u = _umUsers.find(x => x.uid === uid);
  if (!u) return;
  document.getElementById('ua-user-name').textContent      = u.name || u.email || 'User';
  document.getElementById('ua-user-email').textContent     = u.email || '';
  const av = document.getElementById('ua-avatar');
  if (av) av.textContent = (typeof initials === 'function') ? initials(u.name || u.email) : (u.name || u.email || 'U').charAt(0).toUpperCase();
  document.getElementById('ua-user-id').value              = uid;
  document.getElementById('ua-position').value             = u.position || '';
  document.getElementById('ua-team').value                 = u.teamName || '';
  document.getElementById('ua-role').value                 = u.role     || 'serviceDevotee';
  document.getElementById('ua-att-seva').checked           = !!u.isAttSevaDev;
  document.getElementById('ua-can-backdate').checked       = !!u.canBackDateAttendance;
  document.getElementById('ua-can-all-calling').checked    = !!u.canAllTeamCalling;
  document.getElementById('ua-can-all-reports').checked    = !!u.canAllTeamReports;
  document.getElementById('ua-can-manage-all').checked     = !!u.canManageAllTeams;
  // Open the Special Powers section automatically if any booster is set
  const det = document.querySelector('#user-action-modal .ua-special-powers');
  if (det) det.open = !!(u.isAttSevaDev || u.canBackDateAttendance || u.canAllTeamCalling || u.canAllTeamReports || u.canManageAllTeams);
  // Auto-update summary on any change; re-render now for current values
  _uaWireSummary();
  _uaRefreshSummary();
  openModal('user-action-modal');
}

// One-click presets for the four common booster combinations.
function _uaApplyPreset(kind) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.checked = val; };
  if (kind === 'deputy') {        // Operations Deputy — almost super admin
    set('ua-can-all-calling', true);
    set('ua-can-all-reports', true);
    set('ua-can-manage-all',  true);
    set('ua-att-seva',        true);
    set('ua-can-backdate',    true);
  } else if (kind === 'reviewer') { // Cross-team Reviewer — read-only oversight
    set('ua-can-all-calling', false);
    set('ua-can-all-reports', true);
    set('ua-can-manage-all',  false);
    set('ua-att-seva',        false);
    set('ua-can-backdate',    false);
  } else if (kind === 'caller') {   // Cross-team Caller — submits on behalf of any team
    set('ua-can-all-calling', true);
    set('ua-can-all-reports', false);
    set('ua-can-manage-all',  false);
    set('ua-att-seva',        false);
    set('ua-can-backdate',    false);
  } else if (kind === 'clear') {
    set('ua-can-all-calling', false);
    set('ua-can-all-reports', false);
    set('ua-can-manage-all',  false);
    set('ua-att-seva',        false);
    set('ua-can-backdate',    false);
  }
  _uaRefreshSummary();
}
window._uaApplyPreset = _uaApplyPreset;

// Listen for toggles inside the user action modal so the summary stays live.
let _uaSummaryWired = false;
function _uaWireSummary() {
  if (_uaSummaryWired) return;
  _uaSummaryWired = true;
  ['ua-role','ua-team','ua-att-seva','ua-can-all-calling','ua-can-all-reports','ua-can-manage-all']
    .forEach(id => document.getElementById(id)?.addEventListener('change', _uaRefreshSummary));
}

// Computes a plain-English sentence describing what this user can do, given
// their current Role + Team + Boosters. Mirrors the rules in applyRoleUI().
function _uaRefreshSummary() {
  const role     = document.getElementById('ua-role').value;
  const team     = document.getElementById('ua-team').value;
  const attSeva  = document.getElementById('ua-att-seva').checked;
  const allCall  = document.getElementById('ua-can-all-calling').checked;
  const allRpt   = document.getElementById('ua-can-all-reports').checked;
  const mgrAll   = document.getElementById('ua-can-manage-all').checked;
  const roleLabel = role === 'superAdmin' ? 'Super Admin'
    : role === 'teamAdmin' ? 'Coordinator' : 'Facilitator';
  const parts = [];
  if (role === 'superAdmin') {
    parts.push('Full power — every tab, every team, manages users, can wipe data.');
  } else {
    parts.push(`<strong>${roleLabel}</strong>${team ? ' of <strong>' + team + '</strong>' : ''}`);
    const owns = role === 'teamAdmin' ? 'Manages their own team\'s devotees, calling, attendance.' : 'Marks calling + attendance for their own team.';
    parts.push(owns);
    if (mgrAll)      parts.push('Lite super admin: writes across <strong>all teams</strong> + Calling Mgmt + Meetings tabs.');
    else if (allCall) parts.push('Can submit calling on behalf of <strong>any team</strong> (Team Calling tab).');
    if (allRpt && !mgrAll)  parts.push('Sees reports across <strong>all teams</strong> (read-only).');
    if (attSeva)     parts.push('Live Attendance for <strong>all teams</strong>.');
  }
  const el = document.getElementById('ua-summary-text');
  if (el) el.innerHTML = parts.join(' ');
}

async function doSaveUserAction() {
  const uid               = document.getElementById('ua-user-id').value;
  const position          = document.getElementById('ua-position').value.trim() || null;
  const teamName          = document.getElementById('ua-team').value || null;
  const role              = document.getElementById('ua-role').value;
  const isAttSevaDev          = document.getElementById('ua-att-seva').checked;
  const canBackDateAttendance = document.getElementById('ua-can-backdate').checked;
  const canAllTeamCalling     = document.getElementById('ua-can-all-calling').checked;
  const canAllTeamReports     = document.getElementById('ua-can-all-reports').checked;
  const canManageAllTeams     = document.getElementById('ua-can-manage-all').checked;
  if (!uid) return;
  try {
    await fdb.collection('users').doc(uid).update({
      position, teamName, role,
      isAttSevaDev, canBackDateAttendance, canAllTeamCalling, canAllTeamReports, canManageAllTeams,
      updatedAt: TS(),
    });
    // reflect in local cache
    const u = _umUsers.find(x => x.uid === uid);
    if (u) {
      u.position = position; u.teamName = teamName; u.role = role;
      u.isAttSevaDev = isAttSevaDev;
      u.canBackDateAttendance = canBackDateAttendance;
      u.canAllTeamCalling = canAllTeamCalling;
      u.canAllTeamReports = canAllTeamReports;
      u.canManageAllTeams = canManageAllTeams;
    }
    renderUserMgmtList();
    closeModal('user-action-modal');
    showToast('User updated!', 'success');
  } catch (e) {
    showToast('Update failed: ' + (e.message || 'Unknown'), 'error');
  }
}

async function doRemoveUser() {
  const uid = document.getElementById('ua-user-id').value;
  if (!uid) return;
  if (uid === AppState.userId) { showToast('You cannot remove your own account here.', 'error'); return; }
  if (!confirm('Remove this user profile? Their Firestore record will be deleted. (Auth account must be deleted separately in Firebase Console.)')) return;
  try {
    await fdb.collection('users').doc(uid).delete();
    _umUsers = _umUsers.filter(u => u.uid !== uid);
    renderUserMgmtList();
    closeModal('user-action-modal');
    showToast('User removed', 'success');
  } catch (e) {
    showToast('Remove failed: ' + (e.message || 'Unknown'), 'error');
  }
}

// ── ROLE-BASED UI ─────────────────────────────────────
function applyRoleUI() {
  const role = AppState.userRole;
  const team = AppState.userTeam;

  document.getElementById('header-user-name').textContent = AppState.userName;
  _applyHeaderAvatar();
  const pill = document.getElementById('header-role-pill');
  const pos = AppState.userPosition;
  pill.textContent = role === 'superAdmin' ? 'Super Admin'
    : role === 'teamAdmin' ? (team ? `${team} - Coordinator` : 'Coordinator')
    : (team ? `${team} - ${pos || 'Facilitator'}` : (pos || 'Facilitator'));
  pill.style.background = role === 'superAdmin' ? '#fde68a' : role === 'teamAdmin' ? '#fef9c3' : '#fffbeb';

  // Always set both show AND hide — never rely on "was already hidden".
  // If this runs after an account switch, elements must be explicitly
  // shown or hidden for the NEW role, not left in the previous role's state.
  const isSuper = role === 'superAdmin';
  document.getElementById('admin-gear-btn')?.classList.toggle('hidden', !isSuper);
  document.getElementById('clear-data-btn')?.classList.toggle('hidden', !isSuper);
  document.querySelectorAll('.super-admin-only').forEach(el => {
    el.style.display = isSuper ? '' : 'none';
  });

  // serviceDevotee (Facilitator) gets same tab access as teamAdmin — all team tabs.
  // Meetings + calling-mgmt are super-admin tools; canManageAllTeams users
  // ALSO get them ("lite super admin" delegation).
  const tabs = {
    dashboard:      ['superAdmin', 'teamAdmin', 'serviceDevotee'],
    devotees:       ['superAdmin', 'teamAdmin', 'serviceDevotee'],
    calling:        ['superAdmin', 'teamAdmin', 'serviceDevotee'],
    attendance:     ['superAdmin', 'teamAdmin', 'serviceDevotee'],
    care:           ['superAdmin', 'teamAdmin', 'serviceDevotee'],
    events:         ['superAdmin', 'teamAdmin', 'serviceDevotee'],
    meetings:       ['superAdmin'],
    'calling-mgmt': ['superAdmin'],
  };
  const liteSuperAdmin = (typeof canCrossTeamManage === 'function' && canCrossTeamManage());
  const isAllowed = (tab) => {
    if (tabs[tab]?.includes(role)) return true;
    // Delegated "lite super admin" sees super-admin-only tabs too
    if (liteSuperAdmin && tabs[tab]?.includes('superAdmin')) return true;
    return false;
  };
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const tab = btn.dataset.tab;
    const allowed = isAllowed(tab);
    btn.style.display = allowed ? '' : 'none';
    const group = btn.closest('.tab-btn-group');
    if (group) group.style.display = allowed ? '' : 'none';
  });
  document.querySelectorAll('.bnav-btn').forEach(btn => {
    const tab = btn.dataset.tab;
    const allowed = isAllowed(tab);
    btn.style.display = allowed ? '' : 'none';
    const group = btn.closest('.bnav-btn-group');
    if (group) group.style.display = allowed ? '' : 'none';
  });

  const activePanel = document.querySelector('.tab-panel.active');
  const activeTab   = activePanel?.id?.replace('tab-', '');
  if (activeTab && !isAllowed(activeTab)) {
    const firstAllowed = Object.keys(tabs).find(t => isAllowed(t));
    const firstBtn = document.querySelector(`.tab-btn[data-tab="${firstAllowed}"]`);
    if (firstBtn && typeof switchTab === 'function') switchTab(firstAllowed, firstBtn);
  }

  // Calling sub-tab button visibility by role:
  // "Calls" = personal calling → teamAdmin + serviceDevotee only (superAdmin doesn't do personal calling)
  // "Team Calling" = oversight view → teamAdmin + superAdmin + delegated cross-team callers
  const canCrossCalling = (typeof canCrossTeamCalling === 'function') ? canCrossTeamCalling() : (role === 'superAdmin');
  document.getElementById('calling-calls-btn')?.classList.toggle('hidden', role === 'superAdmin');
  document.getElementById('calling-team-btn')?.classList.toggle('hidden', role === 'serviceDevotee' && !canCrossCalling);

  // Also update the dropdown menu items for the calling tab.
  // A delegated facilitator (canAllTeamCalling) gets Team Calling even though
  // their role is serviceDevotee.
  ['tab-menu-calling', 'bnav-menu-calling'].forEach(menuId => {
    const menu = document.getElementById(menuId);
    if (!menu) return;
    menu.querySelectorAll('.tab-menu-item').forEach(item => {
      const view = item.dataset.view;
      const entry = TAB_VIEWS.calling?.find(it => it.key === view);
      if (!entry?.roles) return;
      const allowed = entry.roles.includes(role)
        || (view === 'team-calling' && canCrossCalling);
      item.style.display = allowed ? '' : 'none';
    });
  });

  // superAdmin (and lite-super delegated users) opens Calling tab → land on Team Calling, not Calls
  if ((role === 'superAdmin' || (typeof canCrossTeamManage === 'function' && canCrossTeamManage())) && AppState.currentTab === 'calling') {
    applyTabView('calling', 'team-calling');
  }

  // Both directions: show for admin/coordinator/delegated, hide for plain Facilitator.
  // Without the explicit show branch, switching FROM serviceDevotee TO coordinator
  // leaves these elements permanently hidden.
  const isAdminOrCoord = ['superAdmin', 'teamAdmin'].includes(role)
    || (typeof canCrossTeamManage === 'function' && canCrossTeamManage());
  document.querySelectorAll('.admin-coordinator-only').forEach(el => {
    el.style.display = isAdminOrCoord ? '' : 'none';
  });

  // Lock the legacy team filter for users WITHOUT cross-team permission.
  // Super admin AND any delegated user (canAllTeam* / canManageAllTeams) keep it editable.
  const canCrossTeam = (typeof canChangeTeamFilter === 'function') ? canChangeTeamFilter() : (role === 'superAdmin');
  if (!canCrossTeam && team) {
    const ft = document.getElementById('filter-team');
    if (ft) { ft.value = team; ft.disabled = true; }
  } else {
    const ft = document.getElementById('filter-team');
    if (ft) ft.disabled = false;
  }

  // Live sub-tab: ONLY visible to users with Att. Seva flag.
  const canSeeLive = !!AppState.isAttSevaDev;
  const liveSubTabBtn = document.querySelector('#tab-attendance .att-sub-tab[onclick*="\'live\'"]');
  if (liveSubTabBtn) liveSubTabBtn.style.display = canSeeLive ? '' : 'none';
  // Only redirect to Reports if the Live panel is actually active right now —
  // avoid firing loadReports() on app boot when the user isn't even on Attendance.
  if (!canSeeLive) {
    const livePanel = document.getElementById('att-panel-live');
    if (livePanel?.classList.contains('active')) {
      const reportsBtn = document.querySelector('#tab-attendance .att-sub-tab[onclick*="\'reports\'"]');
      if (reportsBtn && typeof switchAttSubTab === 'function') switchAttSubTab(reportsBtn, 'reports');
    } else {
      // Still flip the panels so Reports is the default when user opens Attendance
      const reportsPanel = document.getElementById('att-panel-reports');
      const reportsBtn   = document.querySelector('#tab-attendance .att-sub-tab[onclick*="\'reports\'"]');
      livePanel?.classList.remove('active');
      reportsPanel?.classList.add('active');
      if (liveSubTabBtn) liveSubTabBtn.classList.remove('active');
      reportsBtn?.classList.add('active');
    }
  }
}

// ── STUCK USER FINDER ──────────────────────────────────────
// Diagnose the "Awaiting Approval — for no reason" case. The user's email is
// in `users` but under a stale Auth UID; their current Auth UID has no doc.
// Self-heal in onAuthStateChanged covers most cases. This tool is the manual
// fallback: super admin enters the user's email, sees every users-doc + pending
// signupRequest for that email, and can hand-link or delete orphans.
async function openStuckUserFinder() {
  const email = prompt('Enter the email of the user stuck on "Awaiting Approval":');
  if (!email) return;
  const e = email.trim().toLowerCase();
  if (!e) return;
  try {
    const [usersSnap, reqSnap] = await Promise.all([
      fdb.collection('users').where('email', '==', email.trim()).get(),
      fdb.collection('signupRequests').where('email', '==', email.trim()).get(),
    ]);
    const userRows = usersSnap.docs.map(d => ({ uid: d.id, ...d.data() }));
    const reqRows  = reqSnap.docs.map(d => ({ uid: d.id, ...d.data() }));
    let msg = `Diagnostic for ${email.trim()}:\n\n`;
    if (!userRows.length && !reqRows.length) {
      msg += '• No users-doc and no signupRequests found.\nAsk the user to sign up again — the auto-heal will create a fresh request.';
    } else {
      if (userRows.length) {
        msg += `Users-doc rows (${userRows.length}):\n`;
        userRows.forEach(u => {
          const tag = u.migratedTo ? ' [SUPERSEDED]' : u.status === 'rejected' ? ' [REJECTED]' : '';
          msg += `  • UID ${u.uid.slice(0,12)}… · role=${u.role||'-'} · team=${u.teamName||'-'}${tag}\n`;
        });
      } else {
        msg += '• No users-doc found.\n';
      }
      if (reqRows.length) {
        msg += `\nSignup requests (${reqRows.length}):\n`;
        reqRows.forEach(r => {
          msg += `  • UID ${r.uid.slice(0,12)}… · status=${r.status||'-'}\n`;
        });
      }
      msg += '\nNext steps:\n';
      msg += '• If a pending request exists → approve it from Sign-up Requests.\n';
      msg += '• If an old users-doc exists → ask the user to log in once; self-heal will re-link automatically.\n';
      msg += '• If multiple rows are competing → keep the row with the correct role + delete the others.';
    }
    alert(msg);
  } catch (e) {
    showToast('Lookup failed: ' + (e.message || 'Error'), 'error');
  }
}

async function purgeMigratedUserDoc(uid) {
  if (!confirm('Permanently delete this superseded users row?\n\nThis only removes the old (stale-UID) doc. The current account is untouched.')) return;
  try {
    await fdb.collection('users').doc(uid).delete();
    showToast('Old row removed', 'success');
    // Reload the (real) user-management list so the row disappears immediately.
    if (typeof openUserManagement === 'function') openUserManagement();
  } catch (e) {
    showToast('Delete failed: ' + (e.message || 'Error'), 'error');
  }
}

// ── CLEAR DATA ────────────────────────────────────────
async function openClearDataModal() {
  const sel = document.getElementById('clear-team-select');
  sel.innerHTML = '<option value="">-- Select Team --</option>';
  const teams = TEAMS;
  teams.forEach(t => { const o = document.createElement('option'); o.value = t; o.textContent = t; sel.appendChild(o); });
  try {
    const all = await DevoteeCache.all();
    const dbTeams = [...new Set(all.map(d => d.teamName).filter(Boolean))].sort();
    dbTeams.forEach(t => { if (!teams.includes(t)) { const o = document.createElement('option'); o.value = t; o.textContent = t; sel.appendChild(o); } });
  } catch (_) {}
  const sun = getUpcomingSunday();
  document.getElementById('clear-date-input').value = sun;
  document.getElementById('clear-team-date-input').value = sun;
  document.getElementById('clear-all-confirm').value = '';
  openModal('clear-data-modal');
}

async function clearDataForDate() {
  const date = document.getElementById('clear-date-input').value;
  if (!date) return showToast('Please select a date', 'error');
  if (!confirm(`Delete ALL attendance records for ${formatDate(date)}?\n\nThis cannot be undone.`)) return;
  try {
    showToast('Clearing…');
    const sessSnap = await fdb.collection('sessions').where('sessionDate', '==', date).get();
    if (sessSnap.empty) return showToast('No session found for this date', 'error');
    const sessionId = sessSnap.docs[0].id;
    const attSnap = await fdb.collection('attendanceRecords').where('sessionId', '==', sessionId).get();
    const batches = chunkArray(attSnap.docs, 400);
    for (const chunk of batches) {
      const b = fdb.batch();
      chunk.forEach(d => { b.delete(d.ref); });
      await b.commit();
    }
    // callingStatus.weekDate is the Saturday of the session week (not Sunday).
    // Resolve it through the same helper as the rest of the app — otherwise
    // this clear leaves orphan calling records behind.
    const callingDate = (typeof resolveCallingDate === 'function')
      ? (await resolveCallingDate(date)) || date
      : date;
    // Query both keys: current data uses Saturday, but legacy rows may still
    // sit under the Sunday session date. Deleting both is safe — no overlap.
    const csKeys = callingDate === date ? [date] : [callingDate, date];
    const csDocs = [];
    for (const k of csKeys) {
      const s = await fdb.collection('callingStatus').where('weekDate', '==', k).get();
      csDocs.push(...s.docs);
    }
    const csBatches = chunkArray(csDocs, 400);
    for (const chunk of csBatches) {
      const b = fdb.batch();
      chunk.forEach(d => { b.delete(d.ref); });
      await b.commit();
    }
    const submDocs = [];
    for (const k of csKeys) {
      const s = await fdb.collection('callingSubmissions').where('weekDate', '==', k).get();
      submDocs.push(...s.docs);
    }
    const submSnap = { docs: submDocs };
    const submBatches = chunkArray(submSnap.docs, 400);
    for (const chunk of submBatches) {
      const b = fdb.batch();
      chunk.forEach(d => { b.delete(d.ref); });
      await b.commit();
    }
    const devoteeIds = [...new Set(attSnap.docs.map(d => d.data().devoteeId))];
    const dbatches = chunkArray(devoteeIds, 400);
    for (const chunk of dbatches) {
      const b = fdb.batch();
      chunk.forEach(id => b.update(fdb.collection('devotees').doc(id), { lifetimeAttendance: INC(-1) }));
      await b.commit();
    }
    DevoteeCache.bust();
    if (typeof _bustDashboardCache === 'function') _bustDashboardCache();
    if (typeof _bustCareCache === 'function') _bustCareCache();
    showToast(`Cleared ${attSnap.size} records for ${formatDate(date)}`, 'success');
    loadAttendanceCandidates?.(); updateAttendanceStats?.();
  } catch (e) { showToast('Error: ' + e.message, 'error'); console.error(e); }
}

async function clearDataForTeamDate() {
  const date = document.getElementById('clear-team-date-input').value;
  const team = document.getElementById('clear-team-select').value;
  if (!date) return showToast('Please select a date', 'error');
  if (!team) return showToast('Please select a team', 'error');
  if (!confirm(`Delete attendance records for team "${team}" on ${formatDate(date)}?\n\nThis cannot be undone.`)) return;
  try {
    showToast('Clearing…');
    const sessSnap = await fdb.collection('sessions').where('sessionDate', '==', date).get();
    if (sessSnap.empty) return showToast('No session found for this date', 'error');
    const sessionId = sessSnap.docs[0].id;
    const attSnap = await fdb.collection('attendanceRecords')
      .where('sessionId', '==', sessionId)
      .where('teamName', '==', team).get();
    if (attSnap.empty) return showToast(`No records found for ${team} on ${formatDate(date)}`, 'error');
    const b = fdb.batch();
    attSnap.docs.forEach(d => b.delete(d.ref));
    await b.commit();
    const b2 = fdb.batch();
    attSnap.docs.forEach(d => b2.update(fdb.collection('devotees').doc(d.data().devoteeId), { lifetimeAttendance: INC(-1) }));
    await b2.commit();
    DevoteeCache.bust();
    if (typeof _bustDashboardCache === 'function') _bustDashboardCache();
    if (typeof _bustCareCache === 'function') _bustCareCache();
    showToast(`Cleared ${attSnap.size} records for ${team} on ${formatDate(date)}`, 'success');
    loadAttendanceCandidates?.(); updateAttendanceStats?.();
  } catch (e) { showToast('Error: ' + e.message, 'error'); console.error(e); }
}

async function clearAllData() {
  const confirm1 = document.getElementById('clear-all-confirm').value.trim();
  if (confirm1 !== 'DELETE ALL') return showToast('Type "DELETE ALL" exactly to confirm', 'error');
  if (!confirm('FINAL WARNING: This will permanently delete ALL devotees, sessions, attendance, and calling records.\n\nAre you absolutely sure?')) return;
  try {
    closeModal('clear-data-modal');
    showToast('Erasing all data…');
    const collections = ['devotees','sessions','attendanceRecords','callingStatus','callingSubmissions','callingWeekHistory','events','profileChanges'];
    for (const col of collections) {
      let snap = await fdb.collection(col).limit(400).get();
      while (!snap.empty) {
        const b = fdb.batch();
        snap.docs.forEach(d => b.delete(d.ref));
        await b.commit();
        snap = await fdb.collection(col).limit(400).get();
      }
    }
    DevoteeCache.bust();
    if (typeof _bustDashboardCache === 'function') _bustDashboardCache();
    if (typeof _bustCareCache === 'function') _bustCareCache();
    showToast('All data erased. Reloading…', 'success');
    setTimeout(() => location.reload(), 2000);
  } catch (e) { showToast('Error: ' + e.message, 'error'); console.error(e); }
}

// ── INIT ─────────────────────────────────────────────
async function initApp() {
  await initSession();
  await initMasterFilterBar();
  _buildTabMenus?.();
  // Anchor the back stack on Dashboard. Without this, the very first nav push
  // creates only one history entry — clicking back would exit the app instead
  // of returning to Dashboard.
  try {
    if (history.state == null) {
      history.replaceState({ nav: true, tab: 'dashboard', view: null }, '', location.href);
    }
  } catch (_) {}
  // Warm key caches in background so first tab-switch feels instant
  Promise.all([
    DevoteeCache.all(),
    DB.getCallingWeekConfig(),
  ]).catch(() => {});
  loadDevotees();
  loadCallingPersonsFilter();
  loadBirthdays();
  initReportsSessionFilter?.();
  initAllPickers();
  initSheetYearSelector();
  // ALWAYS sync currentTab to the active DOM panel at startup. The old code
  // only set this when currentTab was empty, which meant a stale value from a
  // previous session could survive logout (logout reset didn't clear it). If
  // currentTab said "devotees" but the dashboard panel was actually visible,
  // loadDashboard never fired and the dashboard sat on "Loading…" forever.
  const _activePanel = document.querySelector('.tab-panel.active');
  AppState.currentTab = _activePanel?.id?.replace('tab-', '') || 'dashboard';
  if (AppState.currentTab === 'dashboard') { loadHome?.(); loadDashboard?.(); }
  renderBreadcrumb?.();
}

// ── MASTER FILTER BAR ───────────────────────────────────
// Stage 2: bar is visible and editable, but tabs still also use their legacy
// widgets. The bar mirrors values in both directions through dispatchFilters
// + a 'filtersChanged' listener that syncs legacy <select> values back.
let _mfbInitDone = false;
async function initMasterFilterBar() {
  // Mark Team chip as locked for users without cross-team permission.
  // Super admin AND anyone with canAllTeamCalling / canAllTeamReports /
  // canManageAllTeams can change the team. Everyone else is locked to their own.
  const teamChip    = document.getElementById('mfb-team-chip');
  const teamChipBox = document.getElementById('fr-chip-team');
  const teamUnlocked = (typeof canChangeTeamFilter === 'function' && canChangeTeamFilter());
  if (AppState.userRole && AppState.userTeam && !teamUnlocked) {
    if (teamChipBox) teamChipBox.dataset.locked = 'true';
    if (teamChip) {
      teamChip.style.display = '';
      teamChip.innerHTML = `<i class="fas fa-lock" style="font-size:.7rem"></i> ${AppState.userTeam}`;
    }
    AppState.filters.team = AppState.userTeam;
  } else if (teamChipBox) {
    // Make sure delegated users get an UNLOCKED chip even though they aren't super admin
    delete teamChipBox.dataset.locked;
  }

  // Populate dropdown panels
  _mfbReloadTeamOptions();
  await _mfbReloadSessionOptions();
  _mfbReloadCallingByOptions();

  // Click outside any chip to close all open dropdowns
  _frInitOutsideClose();

  if (!_mfbInitDone) {
    _mfbInitDone = true;
    // Listen to dispatchFilters firing → keep widgets in sync (legacy + master)
    window.addEventListener('filtersChanged', _mfbOnFiltersChanged);
    // Mirror back: legacy per-tab <select>s push values into master state.
    _mfbAttachLegacyMirror();
  }

  _mfbUpdateCaption();
}

function _mfbAttachLegacyMirror() {
  const teamIds = ['filter-team','calling-filter-team','yearly-sheet-team','trend-team','cm-filter-team'];
  const byIds   = ['filter-calling-by','calling-filter-callingby','cm-filter-by'];
  teamIds.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => dispatchFilters({ team: el.value }));
  });
  byIds.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => dispatchFilters({ callingBy: el.value }));
  });
}

// ── Custom dropdown panels (replace native <select>) ──
// Each chip has a sibling <div class="fr-dropdown"> that holds clickable items.
// Toggling opens/closes the panel; clicking an item dispatches the filter.

function _frToggle(event, chip) {
  event?.stopPropagation();
  // Don't open dropdown when user clicked the chip's ✕ clear button
  if (event?.target?.closest('.fr-chip-clear')) return;
  // Locked team chip (non-superAdmin) is non-interactive
  if (chip === 'team') {
    // teamAdmin is locked everywhere EXCEPT the Devotees tab (where they can browse all teams).
  const isLocked = AppState.userRole && AppState.userRole !== 'superAdmin' && AppState.userTeam && AppState.currentTab !== 'devotees';
    if (isLocked) return;
  }
  const dd = document.getElementById('fr-dropdown-' + chip);
  if (!dd) return;
  const wasHidden = dd.classList.contains('hidden');
  document.querySelectorAll('.fr-dropdown').forEach(d => d.classList.add('hidden'));
  if (wasHidden) {
    dd.classList.remove('hidden');
    _positionFrDropdown(dd, event?.currentTarget);
  }
}

// Position the dropdown (which is position:fixed) relative to its chip,
// staying inside the viewport. Mirrors the .tab-menu pattern so dropdowns
// never get clipped by main-content's overflow or trapped under cards.
function _positionFrDropdown(dd, chipEl) {
  if (!dd) return;
  // Anchor: the chip the user clicked
  const anchor = chipEl?.closest('.fr-chip') || chipEl;
  if (!anchor) return;
  const r = anchor.getBoundingClientRect();
  // Measure dropdown after it's visible so we have real dimensions
  const ddW = dd.offsetWidth  || 240;
  const ddH = dd.offsetHeight || 280;
  const margin = 8;
  // Horizontal: left-aligned with the chip, clamped to viewport
  const maxLeft = window.innerWidth - ddW - margin;
  const left = Math.max(margin, Math.min(r.left, maxLeft));
  // Vertical: below the chip; flip above if no room below
  let top = r.bottom + 6;
  if (top + ddH > window.innerHeight - margin) {
    top = Math.max(margin, r.top - ddH - 6);
  }
  dd.style.left = left + 'px';
  dd.style.top  = top  + 'px';
}
// Close dropdowns on scroll/resize so they don't drift away from their chip
window.addEventListener('resize', () => document.querySelectorAll('.fr-dropdown').forEach(d => d.classList.add('hidden')));
window.addEventListener('scroll', () => document.querySelectorAll('.fr-dropdown').forEach(d => d.classList.add('hidden')), { passive: true });

function _frCloseAll() {
  document.querySelectorAll('.fr-dropdown').forEach(d => d.classList.add('hidden'));
}

// Bound once at startup — close any open dropdown when clicking outside.
let _frOutsideClickBound = false;
function _frInitOutsideClose() {
  if (_frOutsideClickBound) return;
  _frOutsideClickBound = true;
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.fr-chip-wrap')) _frCloseAll();
  });
}

// Item-click handlers — called inline from generated dropdown items.
function _frPickTeam(value) {
  dispatchFilters({ team: value || '' });
  _frCloseAll();
  _mfbReloadCallingByOptions?.();
}
function _frPickCallingBy(value) {
  dispatchFilters({ callingBy: value || '' });
  _frCloseAll();
}
function _frPickSession(dateStr, docId) {
  // User manually picked a session → discard any pending auto-snap-restore
  // (the auto-snap memory was for restoring the original future session on
  // Live views; user's explicit pick replaces that intent).
  AppState._autoSnap = null;
  // Mark this as an explicit user pick so the Dashboard does NOT auto-snap
  // to the latest past session even if this session is in the future.
  AppState._sessionExplicit = true;
  if (!dateStr) {
    dispatchFilters({ sessionId: null, _sessionDocId: null });
  } else {
    dispatchFilters({ sessionId: dateStr, _sessionDocId: docId || null });
  }
  _frCloseAll();
}

// Repopulate Team dropdown from TEAMS array (single source of truth).
function _mfbReloadTeamOptions() {
  const list = document.getElementById('fr-dropdown-list-team');
  if (!list) return;
  const current = AppState.filters?.team || '';
  const items = [{ value: '', label: 'All Teams' }, ...TEAMS.map(t => ({ value: t, label: t }))];
  list.innerHTML = items.map(it => {
    const safe = it.value.replace(/'/g, "\\'");
    return `<div class="fr-dropdown-item${it.value === current ? ' active' : ''}"
                 data-value="${it.value}"
                 onclick="_frPickTeam('${safe}')">
              <span class="fr-dropdown-item-label">${it.label}</span>
            </div>`;
  }).join('');
}

async function _mfbReloadSessionOptions() {
  const list = document.getElementById('fr-dropdown-list-session');
  if (!list) return;
  try {
    const today    = getToday();
    const sessions = await DB.getSessions();
    const upcoming = sessions.filter(s => s.session_date >  today)
                              .sort((a, b) => a.session_date.localeCompare(b.session_date));
    const past     = sessions.filter(s => s.session_date <= today);
    const current  = AppState.filters?.sessionId || '';
    let html = '';
    if (upcoming[0]) {
      const u = upcoming[0];
      const lbl = new Date(u.session_date + 'T00:00:00')
        .toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
      html += `<div class="fr-dropdown-item${u.session_date === current ? ' active' : ''}"
                    data-value="${u.session_date}"
                    onclick="_frPickSession('${u.session_date}','${u.id}')">
                 <span class="fr-dropdown-item-label">${lbl}</span>
                 <span class="fr-dropdown-item-sub">Upcoming</span>
               </div>
               <div class="fr-dropdown-divider"></div>`;
    }
    past.forEach(s => {
      const lbl = new Date(s.session_date + 'T00:00:00')
        .toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
      const topic = s.topic ? ` · ${s.topic.slice(0, 24)}` : '';
      html += `<div class="fr-dropdown-item${s.session_date === current ? ' active' : ''}"
                    data-value="${s.session_date}"
                    onclick="_frPickSession('${s.session_date}','${s.id}')">
                 <span class="fr-dropdown-item-label">${lbl}${topic}</span>
               </div>`;
    });
    list.innerHTML = html || '<div class="fr-dropdown-empty">No sessions yet</div>';

    // First-load auto-select: if no session is set yet, default to upcoming or most recent past.
    if (!AppState.filters.sessionId) {
      const fb = upcoming[0] || past[0];
      if (fb) dispatchFilters({ sessionId: fb.session_date, _sessionDocId: fb.id });
    }
  } catch (e) { console.error('mfbReloadSessionOptions', e); }
}

function _mfbReloadCallingByOptions() {
  const list = document.getElementById('fr-dropdown-list-by');
  const wrap = document.getElementById('fr-chip-by')?.closest('.fr-chip-wrap');
  if (!list) return;
  // Source from DevoteeCache so callers list stays consistent everywhere.
  DevoteeCache.all().then(all => {
    const team = AppState.filters.team || '';
    const pool = team ? all.filter(d => d.teamName === team) : all;
    const callers = [...new Set(pool.map(d => d.callingBy).filter(Boolean))].sort();
    const current = AppState.filters.callingBy || '';
    const items = [{ value: '', label: 'All Callers' }, ...callers.map(c => ({ value: c, label: c }))];
    list.innerHTML = items.map(it => {
      const safe = it.value.replace(/'/g, "\\'");
      return `<div class="fr-dropdown-item${it.value === current ? ' active' : ''}"
                   data-value="${it.value}"
                   onclick="_frPickCallingBy('${safe}')">
                <span class="fr-dropdown-item-label">${it.label}</span>
              </div>`;
    }).join('');
    // Hide entire chip if there are no callers in the chosen team
    if (wrap) wrap.style.display = callers.length ? '' : 'none';
    // If the current callingBy isn't in the new pool, clear it
    if (current && !callers.includes(current)) {
      dispatchFilters({ callingBy: '' });
    }
  }).catch(() => {});
}

// Legacy onchange shims — kept for any HTML still wired to them; no-ops now.
function _mfbOnSession() {}
function _mfbOnTeam(value)     { _frPickTeam(value); }
function _mfbOnCallingBy(value) { _frPickCallingBy(value); }

function _mfbUpdateCaption() {
  const cap = document.getElementById('mfb-caption');
  if (!cap) return;
  const f = AppState.filters || {};
  const parts = [];
  if (f.team)      parts.push(`<strong>${f.team}</strong> team`);
  else             parts.push('all teams');
  if (f.callingBy) parts.push(`called by <strong>${f.callingBy}</strong>`);
  if (f.sessionId) {
    const lbl = new Date(f.sessionId + 'T00:00:00')
      .toLocaleDateString('en-IN', { weekday:'short', day:'numeric', month:'short', year:'numeric' });
    parts.push(`for <strong>${lbl}</strong>`);
  }
  cap.innerHTML = 'Showing ' + parts.join(', ');
  _frRefreshChips();
}

// ── FILTER RIBBON CHIPS ───────────────────────────────
// Updates each chip's active/inactive style + visible value summary.
// Active chip: brand-green background, shows the picked value next to label.
// Inactive: grey outline, hides the ✕ button.
function _frRefreshChips() {
  const f = AppState.filters || {};
  // teamAdmin is locked everywhere EXCEPT the Devotees tab (where they can browse all teams).
  const isLocked = AppState.userRole && AppState.userRole !== 'superAdmin' && AppState.userTeam && AppState.currentTab !== 'devotees';

  // Session chip
  const sChip = document.getElementById('fr-chip-session');
  const sVal  = document.getElementById('fr-session-value');
  if (sChip && sVal) {
    if (f.sessionId) {
      const lbl = new Date(f.sessionId + 'T00:00:00')
        .toLocaleDateString('en-IN', { day:'numeric', month:'short' });
      sVal.textContent = lbl;
      sChip.dataset.active = 'true';
    } else {
      sVal.textContent = '';
      sChip.dataset.active = 'false';
    }
  }

  // Team chip — hidden entirely for team-locked users on non-Devotees tabs
  // (they can't change it, so showing a non-functional chip is just confusing).
  const tChip    = document.getElementById('fr-chip-team');
  const tVal     = document.getElementById('fr-team-value');
  const tClr     = document.getElementById('fr-team-clear');
  const tChipBox = tChip?.closest('.fr-chip-wrap') || tChip;
  if (tChip && tVal) {
    if (isLocked) {
      if (tChipBox) tChipBox.style.display = 'none';
    } else {
      if (tChipBox) tChipBox.style.display = '';
      if (f.team) {
        tVal.textContent = f.team;
        tChip.dataset.active = 'true';
        if (tClr) tClr.style.display = '';
      } else {
        tVal.textContent = '';
        tChip.dataset.active = 'false';
      }
    }
  }

  // Calling By chip
  const bChip = document.getElementById('fr-chip-by');
  const bVal  = document.getElementById('fr-by-value');
  if (bChip && bVal) {
    if (f.callingBy) {
      bVal.textContent = f.callingBy;
      bChip.dataset.active = 'true';
    } else {
      bVal.textContent = '';
      bChip.dataset.active = 'false';
    }
  }

  // "Clear all" visible only when at least one non-locked filter is active
  const clearAll = document.getElementById('fr-clear-all');
  if (clearAll) {
    const anyActive = !!f.sessionId || (!!f.team && !isLocked) || !!f.callingBy;
    clearAll.style.display = anyActive ? '' : 'none';
  }
}

function _frClearSession(e) {
  e?.stopPropagation();
  dispatchFilters({ sessionId: null, _sessionDocId: null });
}
function _frClearTeam(e) {
  e?.stopPropagation();
  if (AppState.userRole && AppState.userRole !== 'superAdmin') return;
  dispatchFilters({ team: '' });
  _mfbReloadCallingByOptions?.();
}
function _frClearBy(e) {
  e?.stopPropagation();
  dispatchFilters({ callingBy: '' });
}
function _frClearAll() {
  // teamAdmin is locked everywhere EXCEPT the Devotees tab (where they can browse all teams).
  const isLocked = AppState.userRole && AppState.userRole !== 'superAdmin' && AppState.userTeam && AppState.currentTab !== 'devotees';
  const patch = { callingBy: '' };
  if (!isLocked) patch.team = '';
  dispatchFilters(patch);
  _mfbReloadCallingByOptions?.();
}

// Walk the items in each dropdown panel and toggle .active to match current filters.
function _frRefreshActiveItems() {
  const f = AppState.filters || {};
  const apply = (sel, currentVal) => {
    document.querySelectorAll(sel + ' .fr-dropdown-item').forEach(it => {
      const v = it.getAttribute('data-value') || '';
      it.classList.toggle('active', v === (currentVal || ''));
    });
  };
  apply('#fr-dropdown-list-team',    f.team);
  apply('#fr-dropdown-list-session', f.sessionId);
  apply('#fr-dropdown-list-by',      f.callingBy);
}

// Sync between master bar + legacy widgets. Fires on every dispatchFilters call.
function _mfbOnFiltersChanged(e) {
  // When called from switchTab with { tabSwitch:true }, e is a plain object — not
  // a CustomEvent — so e?.detail is undefined. We use this to know the tab
  // switch already handled events/meetings above; all other tabs still need loading.
  const isTabSwitch = e?.tabSwitch === true;
  const f = AppState.filters;
  // Re-highlight the active item in each custom dropdown panel
  _frRefreshActiveItems();
  // Re-sync the chip text/state from AppState.filters. Without this, a
  // locked-role user who taps another team sees the chip stay at their
  // pick even though dispatchFilters silently forced it back. Result:
  // chip and data look mismatched until something else triggers a chip refresh.
  if (typeof _frRefreshChips === 'function') _frRefreshChips();
  // Legacy widgets (mirrors so both stay in sync until later stages drop them)
  const pairs = [
    ['filter-team',           f.team],
    ['calling-filter-team',   f.team],
    ['yearly-sheet-team',     f.team],
    ['trend-team',            f.team],
    ['cm-filter-team',        f.team],
    ['cs-modal-team',         f.team],
    ['filter-calling-by',     f.callingBy],
    ['calling-filter-callingby', f.callingBy],
    ['cm-filter-by',          f.callingBy],
    ['cs-modal-by',           f.callingBy],
  ];
  pairs.forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el && el.value !== (val || '')) {
      el.value = val || '';
    }
  });
  _mfbUpdateCaption();

  // Re-render the visible tab. Derive it from the DOM (not AppState.currentTab
  // which can drift after browser back-button).
  const _activePanel = document.querySelector('.tab-panel.active');
  const tab = _activePanel?.id?.replace('tab-', '') || AppState.currentTab;
  const _sessionChanged = !isTabSwitch && e?.detail?.before && e.detail.before.sessionId !== AppState.filters.sessionId;

  if (tab === 'dashboard') {
    // loadHome is called here on tab switch only; filter-change re-renders
    // are handled by the debounced filtersChanged listener in ui-home.js
    // to avoid calling it twice on the same filter change.
    if (isTabSwitch) loadHome?.();
    loadDashboard?.();
  } else if (tab === 'devotees') {
    if (typeof loadDevotees === 'function') loadDevotees();
  } else if (tab === 'calling') {
    if (AppState._callingSubTab === 'reports') {
      _reportsCategory = 'calling';
      if (typeof _refreshAfterFilter === 'function') _refreshAfterFilter();
    } else if (AppState._callingSubTab === 'history') {
      loadCallingHistory?.();
    } else if (AppState._callingSubTab === 'team-calling') {
      loadTeamCallingList?.();
    } else if (AppState._callingSubTab === 'said-coming') {
      loadSaidComingTab?.();          // re-run on session change — session determines calling week
    } else if (AppState._callingSubTab === 'not-coming-present') {
      loadNotComingPresentTab?.();
    } else if (isTabSwitch || _sessionChanged) {
      loadCallingStatus?.();
    } else if (typeof filterCallingList === 'function' && AppState.callingData?.length) {
      filterCallingList();
    }
  } else if (tab === 'attendance') {
    if (AppState._attSubTab === 'reports') {
      _reportsCategory = 'attendance';
      if (typeof _refreshAfterFilter === 'function') _refreshAfterFilter();
    } else {
      loadAttendanceTab?.();
    }
  } else if (tab === 'calling-mgmt') {
    if (typeof loadCallingMgmtTab === 'function') loadCallingMgmtTab();
  }
}

// ── MOBILE VALIDATION ─────────────────────────────────
function validateMobile(val) {
  const cleaned = (val || '').replace(/\D/g, '');
  if (cleaned.length === 0) return { valid: false, error: 'Mobile number is required' };
  if (cleaned.length !== 10) return { valid: false, error: 'Mobile must be exactly 10 digits' };
  return { valid: true, cleaned };
}

function showFieldError(id, msg) {
  const el = document.getElementById('err-' + id);
  const inp = document.getElementById('f-' + id);
  if (el) { el.textContent = msg; el.classList.add('show'); }
  if (inp) inp.classList.add('invalid');
}

function clearFieldError(id) {
  const el = document.getElementById('err-' + id);
  const inp = document.getElementById('f-' + id);
  if (el) el.classList.remove('show');
  if (inp) inp.classList.remove('invalid');
}

// ── DEVOTEE PICKER ────────────────────────────────────
function initAllPickers() {
  setupPicker('picker-reference',   'f-reference');
  setupUserPicker('picker-calling-by',  'f-calling-by',  () => document.getElementById('f-team')?.value || '');
  setupUserPicker('picker-facilitator', 'f-facilitator', () => '');
}

function setupPicker(containerId, hiddenId) {
  const container = document.getElementById(containerId);
  if (!container || container.dataset.pickerInit) return;
  container.dataset.pickerInit = '1';
  const input    = container.querySelector('.picker-input');
  const dropdown = container.querySelector('.picker-dropdown');
  const hidden   = document.getElementById(hiddenId);

  input.addEventListener('input', debounce(async () => {
    const q = input.value.trim();
    hidden.value = '';
    input.classList.remove('has-value');
    if (q.length < 2) { dropdown.classList.add('hidden'); dropdown.innerHTML = ''; return; }
    const results = await DB.getDevotees({ search: q });
    if (!results.length) {
      dropdown.innerHTML = '<div class="picker-no-result">No devotee found</div>';
      dropdown.classList.remove('hidden'); return;
    }
    dropdown.innerHTML = results.slice(0, 8).map(d => `
      <div class="picker-option" onclick="selectPicker('${containerId}','${hiddenId}','${d.name.replace(/'/g,"\\'")}','${d.id}')">
        <span>${d.name}</span>
        <span class="picker-team">${[d.team_name, d.mobile].filter(Boolean).join(' · ')}</span>
      </div>`).join('');
    dropdown.classList.remove('hidden');
  }, 280));

  document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) dropdown.classList.add('hidden');
  });
}

function selectPicker(containerId, hiddenId, name, id) {
  const container = document.getElementById(containerId);
  const input    = container.querySelector('.picker-input');
  const dropdown = container.querySelector('.picker-dropdown');
  const hidden   = document.getElementById(hiddenId);
  input.value  = name;
  hidden.value = name;
  input.classList.add('has-value');
  dropdown.classList.add('hidden');
  if (containerId === 'picker-reference') {
    const idEl = document.getElementById('f-reference-id');
    if (idEl) idEl.value = id || '';
    const linkBtn = document.getElementById('ref-profile-link');
    if (linkBtn) linkBtn.style.display = id ? '' : 'none';
  }
}

function openRefProfile() {
  const id = document.getElementById('f-reference-id')?.value;
  if (!id) return;
  closeModal('devotee-form-modal');
  setTimeout(() => openProfileModal(id), 200);
}

function setupUserPicker(containerId, hiddenId, getTeam) {
  const container = document.getElementById(containerId);
  if (!container || container.dataset.pickerInit) return;
  container.dataset.pickerInit = '1';
  const input    = container.querySelector('.picker-input');
  const dropdown = container.querySelector('.picker-dropdown');
  const hidden   = document.getElementById(hiddenId);

  async function showResults(q) {
    const team = getTeam();
    const results = await DB.getUsersForTeam(team, q);
    if (!results.length) {
      dropdown.innerHTML = `<div class="picker-no-result">No login found${team ? ' for ' + team + ' team' : ''}.${team ? '<br><small>Pick a different team or have an admin assign a login first.</small>' : ''}</div>`;
      dropdown.classList.remove('hidden'); return;
    }
    dropdown.innerHTML = results.slice(0, 12).map(u => {
      const display = (u.name || u.email || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
      const meta = `${u.teamName || ''}${u.teamName ? ' · ' : ''}${u.role === 'teamAdmin' ? 'Coordinator' : 'Calling Facilitator'}`;
      return `<div class="picker-option" onclick="selectPicker('${containerId}','${hiddenId}','${display}','${u.uid}')">
        <span>${u.name || u.email || '(no name)'}</span>
        <span class="picker-team">${meta}</span>
      </div>`;
    }).join('');
    dropdown.classList.remove('hidden');
  }

  // Show all candidates when the field gains focus (so the user sees options
  // immediately, without having to type 2+ characters first).
  input.addEventListener('focus', () => {
    const q = input.value.trim();
    showResults(q);
  });

  input.addEventListener('input', debounce(() => {
    hidden.value = '';
    input.classList.remove('has-value');
    showResults(input.value.trim());
  }, 200));

  document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) dropdown.classList.add('hidden');
  });
}

function clearPicker(containerId, hiddenId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.querySelector('.picker-input').value = '';
  container.querySelector('.picker-input').classList.remove('has-value');
  container.querySelector('.picker-dropdown').classList.add('hidden');
  document.getElementById(hiddenId).value = '';
  if (containerId === 'picker-reference') {
    const idEl = document.getElementById('f-reference-id');
    if (idEl) idEl.value = '';
    const linkBtn = document.getElementById('ref-profile-link');
    if (linkBtn) linkBtn.style.display = 'none';
  }
}

// ── SESSION MANAGEMENT ─────────────────────────────────
function _setSessionDateDisplay(dateStr) {
  const el = document.getElementById('session-date-text');
  if (el) el.textContent = dateStr ? formatDate(dateStr) : '';
}

async function initSession() {
  try {
    const session = await DB.getTodaySession();
    AppState.sessionsCache[session.id] = AppState.sessionsCache[session.id] || session;
    // Use dispatchFilters so filters.sessionId gets the date string, not the doc ID.
    dispatchFilters({ sessionId: session.session_date, _sessionDocId: session.id });
    _setSessionDateDisplay(session.session_date);
    await loadSessionSelector();
    loadAttendanceSession(session.id);
  } catch (e) { console.error('Session init', e); }
}

async function loadSessionSelector() {
  try {
    const sessions = await DB.getSessions();
    AppState.sessionsCache = {};
    sessions.forEach(s => { AppState.sessionsCache[s.id] = s; });
    const currentSession = AppState.sessionsCache[AppState.currentSessionId];
    if (currentSession) _setSessionDateDisplay(currentSession.session_date);
    if (AppState.currentSessionId) showSessionInfo(AppState.currentSessionId);
  } catch (_) {}
}

async function loadSessionByDate(dateStr) {
  if (!dateStr) return;
  const sunday = snapToSunday(dateStr);
  try {
    const session = await DB.getOrCreateSession(sunday);
    AppState.sessionsCache[session.id] = AppState.sessionsCache[session.id] || {
      id: session.id, session_date: sunday, topic: '', is_cancelled: false
    };
    dispatchFilters({ sessionId: sunday, _sessionDocId: session.id });
    _setSessionDateDisplay(sunday);
    showSessionInfo(session.id);
    loadAttendanceSession(session.id);
  } catch (e) { showToast('Could not load session', 'error'); console.error(e); }
}

function showSessionInfo(sessionId) {
  const s = AppState.sessionsCache?.[sessionId];
  const banner   = document.getElementById('session-cancelled-banner');
  const topicPil = document.getElementById('session-topic-inline');
  if (!banner || !topicPil) return;
  banner.classList.toggle('hidden', !s?.is_cancelled);
  if (s?.topic && !s.is_cancelled) {
    document.getElementById('session-topic-text').textContent = s.topic;
    topicPil.classList.remove('hidden');
  } else {
    topicPil.classList.add('hidden');
  }
}

async function loadCallingPersonsFilter() {
  await _repopulateCallingByFilter();
}

async function _repopulateCallingByFilter() {
  const sel = document.getElementById('filter-calling-by');
  if (!sel) return;
  const team = document.getElementById('filter-team')?.value || '';
  const prev = sel.value;
  try {
    // Pull all active devotees from cache, narrow by team if set, then
    // return unique callingBy values (users who actually call in that team).
    const all = await DevoteeCache.all();
    const pool = team ? all.filter(d => d.teamName === team) : all;
    const persons = [...new Set(pool.map(d => d.callingBy).filter(Boolean))].sort();
    sel.innerHTML = '<option value="">All Callers</option>' +
      persons.map(p => `<option value="${p.replace(/"/g,'&quot;')}"${p===prev?' selected':''}>${p}</option>`).join('');
  } catch (_) {}
}

// Called when the Team filter changes on the Devotees tab: re-scope callers, then reload.
function onDevoteeTeamFilterChange() {
  const by = document.getElementById('filter-calling-by');
  if (by) by.value = '';
  _repopulateCallingByFilter().then(() => loadDevotees());
}

async function loadBirthdays() {
  try {
    const bdays = await DB.getCareBirthdays();
    if (!bdays.length) return;
    document.getElementById('birthday-list').innerHTML = bdays.map(d => `
      <div class="birthday-item">
        <div class="devotee-avatar" style="width:38px;height:38px;font-size:.9rem">${initials(d.name)}</div>
        <div class="birthday-name-wrap">
          <span class="birthday-name">${d.name}</span>
          ${d.team_name ? `<span class="birthday-team">${d.team_name}</span>` : ''}
        </div>
        <span class="birthday-date">${formatBirthday(d.dob)}</span>
        ${contactIcons(d.mobile)}
      </div>`).join('');
    document.getElementById('birthday-popup').classList.remove('hidden');
  } catch (_) {}
}
function closeBirthdayPopup() { document.getElementById('birthday-popup').classList.add('hidden'); }

// ── BOTTOM NAV ARROWS (legacy — kept as no-ops since 5-tab nav has no scroll) ─
function _bnavScroll(dir) {
  const el = document.getElementById('bnav-scroll');
  if (el) el.scrollBy({ left: dir * el.clientWidth, behavior: 'smooth' });
}
function _bnavScrollActive() {
  const el = document.getElementById('bnav-scroll');
  const active = el && el.querySelector('.bnav-btn.active');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
}

// ── TAB SWITCHING ─────────────────────────────────────
function switchTab(tab, btn) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  // btn may be omitted when called programmatically (e.g. via breadcrumb).
  if (btn && btn.classList.contains('tab-btn')) btn.classList.add('active');
  else document.querySelector(`.tab-btn[data-tab="${tab}"]`)?.classList.add('active');
  // Mirror the active state on the mobile bottom nav so its highlight stays
  // in sync regardless of which surface (top nav, bottom nav, programmatic)
  // initiated the switch.
  document.querySelectorAll('.bnav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  _bnavScrollActive();
  AppState.currentTab = tab;
  // When teamAdmin leaves Devotees tab onto a team-scoped tab, snap the master
  // Team filter back to their own team (Devotees is the only place they roam).
  if (AppState.userRole === 'teamAdmin' && AppState.userTeam && tab !== 'devotees'
      && AppState.filters && AppState.filters.team !== AppState.userTeam) {
    AppState.filters.team = AppState.userTeam;
  }
  // Refresh the team-chip lock UI now that currentTab changed (lock toggles on Devotees tab).
  if (typeof _frRefreshChips === 'function') _frRefreshChips();
  // Session chip is shown on all active tabs.
  const sessionChipWrap = document.getElementById('fr-chip-session')?.closest('.fr-chip-wrap');
  if (sessionChipWrap) sessionChipWrap.style.display = '';
  renderBreadcrumb();
  document.getElementById('register-fab')?.classList.toggle('hidden', tab !== 'attendance');
  document.getElementById('add-devotee-fab')?.classList.toggle('hidden', tab !== 'devotees');
  if (tab === 'events')     loadEvents();
  if (tab === 'meetings')   loadMeetingsTab?.();

  // For tabs with TAB_VIEWS, restore the last-picked view (or default to first
  // non-divider entry). All the navigation through the tab now flows through
  // applyTabView, so the in-panel sub-tab strips are not needed.
  if (typeof TAB_VIEWS !== 'undefined' && TAB_VIEWS[tab]) {
    const lastView = AppState._tabView?.[tab];
    // All roles default to calls (Your Calling Sewa) — super admin sees the stats+progress there too
    const defaultView = TAB_VIEWS[tab].find(it => !it.divider && (!it.roles || it.roles.includes(AppState.userRole)))?.key;
    const view = lastView || defaultView;
    if (view) applyTabView(tab, view);
    _pushNavState?.(tab, view);
  } else {
    _pushNavState?.(tab, null);
  }
  // Sync legacy widgets + trigger load for this tab.
  // Pass tabSwitch:true so _mfbOnFiltersChanged skips tabs already
  // triggered above (events/meetings) but still fires the rest.
  if (typeof _mfbOnFiltersChanged === 'function') _mfbOnFiltersChanged({ tabSwitch: true });
}

// ── Tab dropdown navigation ──────────────────────────
// Each tab that has multiple views shows a dropdown menu when clicked
// (instead of stacked sub-tab strips inside the panel). Picking an item
// opens that view as its own screen and updates the breadcrumb path.
const TAB_VIEWS = {
  calling: [
    { key: 'calls',              label: 'Your Calling Sewa',    icon: 'fa-phone-alt' },
    { key: 'team-calling',       label: 'Your Team Calling',    icon: 'fa-users',     roles: ['teamAdmin','superAdmin'] },
    { divider: true, label: 'REPORTS' },
    { key: 'weekly',             label: 'Calling Reports',      icon: 'fa-chart-bar' },
    { key: 'submission',         label: 'Submission Reports',   icon: 'fa-chart-line' },
    { key: 'history',            label: 'Calling History',      icon: 'fa-history'   },
    { key: 'said-coming',        label: 'Said Coming',          icon: 'fa-user-times' },
    { key: 'not-coming-present', label: 'Surprise Present',     icon: 'fa-user-check' },
  ],
  attendance: [
    { key: 'live',          label: 'Live Attendance',        icon: 'fa-check-circle' },
    { key: 'coordinator',   label: 'Coordinator Performance', icon: 'fa-clipboard-list' },
    { divider: true, label: 'REPORTS' },
    { key: 'sheet',         label: 'Attendance Sheet',        icon: 'fa-table' },
    { key: 'late',          label: 'Late Comers',             icon: 'fa-clock' },
    { divider: true, label: 'CARE' },
    { key: 'care-newcomers',  label: 'New Comers',            icon: 'fa-user-plus' },
    { key: 'care-returning',  label: 'Returning Newcomers',   icon: 'fa-seedling' },
    { key: 'repeat-absent',   label: 'Repeat Absentees',      icon: 'fa-user-slash' },
    { key: 'care-absent',     label: 'Absent',                icon: 'fa-user-times' },
    { divider: true, label: 'MORE' },
    { key: 'serious',       label: 'Serious Analysis',        icon: 'fa-star' },
    { key: 'teams',         label: 'Team Leaderboard',        icon: 'fa-trophy' },
    { key: 'trends',        label: 'Trends',                  icon: 'fa-chart-line' },
    { key: 'accuracy',      label: 'Accuracy',                icon: 'fa-bullseye' },
  ],
  'calling-mgmt': [
    { key: 'calling',       label: 'Calling List',     icon: 'fa-phone-alt' },
    { key: 'newcomers',     label: 'New Comers',       icon: 'fa-user-plus' },
    { key: 'online',        label: 'Online Class',     icon: 'fa-laptop' },
    { key: 'notinterested', label: 'Not Interested',   icon: 'fa-times-circle' },
    { key: 'festival',      label: 'Festival Calling', icon: 'fa-star' },
  ],
  meetings: [
    { key: 'overdue',   label: 'Overdue',      icon: 'fa-exclamation-circle' },
    { key: 'scheduled', label: 'Scheduled',    icon: 'fa-calendar-alt' },
    { key: 'completed', label: 'Completed',    icon: 'fa-check-circle' },
    { key: 'recent',    label: 'Recently Met', icon: 'fa-history' },
    { key: 'ptm',       label: 'PTM',          icon: 'fa-users' },
    { key: 'my-log',    label: 'My Log',       icon: 'fa-clipboard-list' },
  ],
  // Note: "meetings" tab is labelled "Connecting" in the UI.
};

// Friendly labels for breadcrumb — derived from TAB_VIEWS for views that have one.
function _viewLabel(tab, view) {
  const items = TAB_VIEWS[tab] || [];
  const found = items.find(it => it.key === view);
  return found?.label || '';
}

function _closeAllTabMenus() {
  document.querySelectorAll('.tab-menu').forEach(m => m.classList.add('hidden'));
}

// ── SUBTAB CARD PICKER ───────────────────────────────────
// Per-view visual style: { bg, color } — used in the card grid.
const _SUBTAB_STYLES = {
  'calls':              { bg:'#eff6ff', color:'#1d4ed8' },
  'team-calling':       { bg:'#f0fdf4', color:'#15803d' },
  'said-coming':        { bg:'#fef2f2', color:'#b91c1c' },
  'not-coming-present': { bg:'#f0fdf4', color:'#15803d' },
  'weekly':        { bg:'#fff7ed', color:'#c2410c' },
  'submission':    { bg:'#fef3c7', color:'#92400e' },
  'history':       { bg:'#f5f3ff', color:'#6d28d9' },
  'live':          { bg:'#f0fdf4', color:'#15803d' },
  'coordinator':   { bg:'#eff6ff', color:'#1d4ed8' },
  'sheet':         { bg:'#fff7ed', color:'#c2410c' },
  'late':          { bg:'#fef2f2', color:'#b91c1c' },
  'newcomers':     { bg:'#fef3c7', color:'#92400e' },
  'serious':       { bg:'#f5f3ff', color:'#6d28d9' },
  'teams':         { bg:'#fffbeb', color:'#b45309' },
  'trends':        { bg:'#ecfdf5', color:'#065f46' },
  'accuracy':      { bg:'#eff6ff', color:'#1e40af' },
  'calling':       { bg:'#eff6ff', color:'#1d4ed8' },
  'online':        { bg:'#f0fdf4', color:'#15803d' },
  'notinterested': { bg:'#fef2f2', color:'#b91c1c' },
  'festival':      { bg:'#fffbeb', color:'#b45309' },
  'overdue':       { bg:'#fef2f2', color:'#b91c1c' },
  'scheduled':     { bg:'#eff6ff', color:'#1d4ed8' },
  'completed':     { bg:'#f0fdf4', color:'#15803d' },
  'recent':        { bg:'#f5f3ff', color:'#6d28d9' },
  'ptm':               { bg:'#fff7ed', color:'#c2410c' },
  'my-log':            { bg:'#eff6ff', color:'#0d2d5a' },
  'repeat-absent':     { bg:'#fef2f2', color:'#7f1d1d' },
  'care-newcomers':    { bg:'#fef3c7', color:'#92400e' },
  'care-returning':    { bg:'#f0fdf4', color:'#15803d' },
  'care-absent':       { bg:'#fef2f2', color:'#b91c1c' },
};

const _TAB_LABELS = {
  calling: 'Calling', attendance: 'Attendance',
  meetings: 'Connecting', 'calling-mgmt': 'Calling Mgmt',
};
const _TAB_ICONS = {
  calling: 'fa-phone-alt', attendance: 'fa-clipboard-check',
  meetings: 'fa-link', 'calling-mgmt': 'fa-headset',
};

let _subtabPickerCurrentTab = null;

function openSubtabPicker(tab) {
  const views = TAB_VIEWS[tab];
  if (!views) return;
  _subtabPickerCurrentTab = tab;

  const titleEl = document.getElementById('subtab-picker-title');
  const bodyEl  = document.getElementById('subtab-picker-body');
  if (!titleEl || !bodyEl) return;

  titleEl.innerHTML = `<i class="fas ${_TAB_ICONS[tab] || 'fa-th'}"></i> ${_TAB_LABELS[tab] || tab}`;

  // Flat 2-column grid — skip dividers, filter by role
  const filteredViews = views.filter(it => !it.divider && (!it.roles || it.roles.includes(AppState.userRole)));

  const cardHtml = filteredViews.map(it => {
    const s = _SUBTAB_STYLES[it.key] || { bg:'#f3f4f6', color:'#374151' };
    return `
      <button class="subtab-card" onclick="closeSubtabPicker();navTabView('${tab}','${it.key}')">
        <div class="subtab-card-icon" style="background:${s.bg};color:${s.color}">
          <i class="fas ${it.icon || 'fa-circle'}"></i>
        </div>
        <span class="subtab-card-label">${it.label}</span>
      </button>`;
  }).join('');

  const html = `<div class="subtab-card-grid">${cardHtml}</div>`;

  bodyEl.innerHTML = html;
  document.getElementById('subtab-picker').classList.remove('hidden');
}
window.openSubtabPicker = openSubtabPicker;

function closeSubtabPicker() {
  document.getElementById('subtab-picker')?.classList.add('hidden');
  _subtabPickerCurrentTab = null;
}
window.closeSubtabPicker = closeSubtabPicker;
// ── END SUBTAB CARD PICKER ────────────────────────────────

function onTabBtnClick(tab, btn, event) {
  event?.stopPropagation();
  _closeAllTabMenus();
  if (TAB_VIEWS[tab]) {
    openSubtabPicker(tab);
  } else {
    switchTab(tab, btn);
  }
}

// Position a fixed-position dropdown either UNDER (desktop top-nav) or ABOVE
// (mobile bottom-nav) its trigger button, keeping it inside the viewport.
function _positionTabMenu(menu, btn) {
  const r = btn.getBoundingClientRect();
  const isBnav = menu.classList.contains('tab-menu-bnav');
  const menuW = menu.offsetWidth || 240;
  const menuH = menu.offsetHeight || 280;
  const maxLeft = window.innerWidth - menuW - 8;
  const left = Math.max(8, Math.min(r.left, maxLeft));
  menu.style.left = left + 'px';
  if (isBnav) {
    // Anchor above the bottom-nav button.
    menu.style.top = Math.max(8, r.top - menuH - 6) + 'px';
  } else {
    menu.style.top = (r.bottom + 6) + 'px';
  }
}

function navTabView(tab, view) {
  _closeAllTabMenus();
  // Pre-store the view so switchTab picks it up instead of falling back to
  // the default — avoids a double-dispatch (once with default, once with user pick).
  AppState._tabView = AppState._tabView || {};
  AppState._tabView[tab] = view;
  // Suppress switchTab's own pushState; we record one nav step for the whole user action.
  _suppressNavPush = true;
  try {
    if (AppState.currentTab !== tab) {
      const tabBtn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
      switchTab(tab, tabBtn);
    } else {
      applyTabView(tab, view);
    }
  } finally {
    _suppressNavPush = false;
  }
  _pushNavState(tab, view);
}

// ── Browser back-button navigation ──────────────────
// Each tab-switch and view-switch pushes a history state so the device's
// back button (or browser back arrow) walks the user one step back through
// their navigation history before exiting the app.
let _suppressNavPush = false;

function _pushNavState(tab, view) {
  if (_suppressNavPush) return;
  try {
    const state = { nav: true, tab, view: view || null };
    // Skip if the topmost state already matches (avoids spurious dupes).
    const cur = history.state;
    if (cur && cur.nav && cur.tab === state.tab && cur.view === state.view) return;
    history.pushState(state, '', location.href);
  } catch (_) {}
}

// One popstate handler for navigation. The overlay/modal handler in config.js
// runs separately for `{ overlay: true }` states; this one handles `{ nav: true }`.
window.addEventListener('popstate', (e) => {
  const state = e.state;
  if (!state || !state.nav || !state.tab) return;
  const sameTab  = state.tab === AppState.currentTab;
  const sameView = state.view && state.view === AppState._tabView?.[state.tab];
  if (sameTab && sameView) return; // already where back wants us
  _suppressNavPush = true;
  try {
    if (!sameTab) {
      const tabBtn = document.querySelector(`.tab-btn[data-tab="${state.tab}"]`);
      if (tabBtn) switchTab(state.tab, tabBtn);
    }
    if (state.view && !sameView) applyTabView(state.tab, state.view);
  } finally {
    _suppressNavPush = false;
  }
});

// Reports can't show data for a session that hasn't happened yet — if the
// master Session is in the future, snap it to the most recent past session
// so the report has something to display. We remember the original future
// session in _autoSnap so we can restore it when the user leaves Reports for
// a Live view (so they don't get stuck on a past session for live work).
async function _ensureReportSession() {
  // Reports always reflect the most recent past completed session. If the
  // master Session is currently in the future (whether from initSession's
  // default or a user pick), snap it to the latest past session so the
  // report always has data. The auto-snap memory lets us restore the future
  // session when the user navigates to a Live view (Mark Attendance / Calls).
  const today   = getToday();
  const current = AppState.filters?.sessionId;
  const currentDocId = AppState._currentSessionId;
  if (!current || current <= today) return false;
  try {
    // Race against a 6s timeout so a stuck getSessions() can't hang reports.
    const sessions = await Promise.race([
      DB.getSessions().catch(() => []),
      new Promise(r => setTimeout(() => r([]), 6000)),
    ]);
    const past = sessions.filter(s => s.session_date <= today);
    if (!past.length) return false;
    const latest = past[0]; // DB.getSessions returns newest-first
    AppState._autoSnap = { from: current, fromDocId: currentDocId, to: latest.session_date };
    dispatchFilters({ sessionId: latest.session_date, _sessionDocId: latest.id });
    if (typeof showToast === 'function') {
      showToast('Showing last completed session for reports', 'info');
    }
    return true;
  } catch (e) {
    console.error('_ensureReportSession', e);
    return false;
  }
}

// When the user navigates to a Live view AND we previously auto-snapped from
// a future session for a Reports view, restore that future session. Manual
// session changes (where user picked something specific) clear the auto-snap
// and never get restored.
function _maybeRestoreLiveSession() {
  const snap = AppState._autoSnap;
  if (!snap) return;
  // Only restore if the current session is still the one we snapped to —
  // i.e. user hasn't manually changed it since.
  if (AppState.filters?.sessionId !== snap.to) {
    AppState._autoSnap = null;
    return;
  }
  AppState._autoSnap = null;
  dispatchFilters({ sessionId: snap.from, _sessionDocId: snap.fromDocId });
}

// "Session-anchored Reports" — only Attendance and Calling reports actually
// query against the session/calling-week. Activity tabs use their own From/To
// pickers, so auto-snapping the global Session for them does nothing useful
// (and would mislead users with a "Showing last completed session" toast).
function _isSessionAnchoredReportsView(tab, view) {
  const callingLiveViews = ['calls', 'said-coming', 'not-coming-present'];
  return (tab === 'attendance' && view !== 'live')
      || (tab === 'calling' && !callingLiveViews.includes(view));
}

// Live views that work against the upcoming/current session — used by the
// auto-restore logic when leaving Reports.
function _isLiveSessionView(tab, view) {
  return (tab === 'attendance' && view === 'live')
      || (tab === 'calling' && view === 'calls');
}

// Maps a TAB_VIEWS key to the underlying sub-tab + sub-panel for that tab.
async function applyTabView(tab, view) {
  AppState._tabView = AppState._tabView || {};
  AppState._tabView[tab] = view;

  // Reflect the active view in BOTH dropdowns (top-nav and bottom-nav)
  // so users see which one is current regardless of surface.
  ['tab-menu-' + tab, 'bnav-menu-' + tab].forEach(menuId => {
    const menu = document.getElementById(menuId);
    if (!menu) return;
    menu.querySelectorAll('.tab-menu-item').forEach(it => {
      it.classList.toggle('active', it.dataset.view === view);
    });
  });

  // Session-anchored Reports auto-snap to the most recent past session.
  if (_isSessionAnchoredReportsView(tab, view)) {
    await _ensureReportSession();
  } else if (_isLiveSessionView(tab, view)) {
    // Coming from Reports back to Live? Restore the user's original future session.
    _maybeRestoreLiveSession();
  }

  if (tab === 'calling') {
    if (view === 'calls') {
      const btn = document.getElementById('calling-calls-btn');
      if (btn) switchCallingSubTab(btn, 'calls');
    } else if (view === 'team-calling') {
      const btn = document.getElementById('calling-team-btn');
      if (btn) switchCallingSubTab(btn, 'team-calling');
    } else if (view === 'history') {
      const btn = document.getElementById('calling-history-btn');
      if (btn) switchCallingSubTab(btn, 'history');
    } else if (view === 'said-coming') {
      const btn = document.getElementById('calling-said-btn');
      if (btn) switchCallingSubTab(btn, 'said-coming');
    } else if (view === 'not-coming-present') {
      const btn = document.getElementById('calling-notcoming-btn');
      if (btn) switchCallingSubTab(btn, 'not-coming-present');
    } else {
      const btn = document.getElementById('calling-reports-btn');
      if (btn) switchCallingSubTab(btn, 'reports');
      const innerSel = view === 'weekly' ? '#calling-panel-reports .sub-tab:nth-child(1)'
                                          : '#calling-panel-reports .sub-tab:nth-child(2)';
      const innerBtn = document.querySelector(innerSel);
      const innerKey = view === 'weekly' ? 'weekly' : 'submission';
      if (innerBtn && typeof switchCallingRptSub === 'function') switchCallingRptSub(innerBtn, innerKey);
      // Override chip label to reflect the specific inner report tab
      const innerLabel = view === 'submission' ? 'Submission Reports' : 'Calling Reports';
      _updateSubtabChip?.('calling-active-subtab', 'calling-active-subtab-name', innerLabel);
    }
  } else if (tab === 'attendance') {
    const _careSubs = ['care-newcomers','care-returning','care-absent'];
    if (view === 'live') {
      const liveBtn = document.querySelector('#tab-attendance .att-sub-tab[onclick*="\'live\'"]');
      if (liveBtn) switchAttSubTab(liveBtn, 'live');
    } else if (view === 'coordinator') {
      const coordBtn = document.querySelector('#tab-attendance .att-sub-tab[onclick*="\'coordinator\'"]');
      if (coordBtn) switchAttSubTab(coordBtn, 'coordinator');
    } else if (view === 'repeat-absent') {
      switchAttSubTab(null, 'repeat-absent');
    } else if (_careSubs.includes(view)) {
      switchAttSubTab(null, view);
    } else {
      const reportsBtn = document.querySelector('#tab-attendance .att-sub-tab[onclick*="\'reports\'"]');
      if (reportsBtn) switchAttSubTab(reportsBtn, 'reports');
      const subId = ({
        sheet:      'attendance-detail',
        late:       'late-comers',
        individual: 'individual-reports',
        newcomers:  'newcomers-report',
        serious:    'serious-analysis',
        teams:      'team-leaderboard',
        trends:     'trends',
        accuracy:   'att-accuracy',
        // coordinator is handled above — not routed through the reports sub-tab
      })[view];
      if (subId) {
        const innerBtn = document.querySelector(`#att-panel-reports .sub-tab[onclick*="'${subId}'"]`);
        if (innerBtn) switchSubTab(innerBtn, subId);
        if (subId === 'attendance-detail'  && typeof loadYearlySheet       === 'function') loadYearlySheet();
        if (subId === 'late-comers'        && typeof loadLateComersReport  === 'function') loadLateComersReport();
        if (subId === 'individual-reports' && typeof _loadIndividualReports === 'function') _loadIndividualReports();
        if (subId === 'att-accuracy'       && typeof loadAttAccuracyReport  === 'function') loadAttAccuracyReport();
      }
    }
  } else if (tab === 'calling-mgmt') {
    // Map view key → existing calling-mgmt panel button
    const cmBtn = document.querySelector(`#tab-calling-mgmt .att-sub-tab[onclick*="'${view}'"]`);
    if (cmBtn && typeof switchCallingMgmtTab === 'function') switchCallingMgmtTab(view, cmBtn);
  } else if (tab === 'meetings') {
    // Sub-tabs now live in the top-nav dropdown — no inline button to click.
    if (typeof switchMeetingsSubTab === 'function') switchMeetingsSubTab(null, view);
  }

  if (typeof renderBreadcrumb === 'function') renderBreadcrumb();
}

// Dynamically wraps each tab button that has TAB_VIEWS in a .tab-btn-group +
// dropdown menu, and overrides its inline onclick. Called once at app init.
// Wires both the desktop top-nav (.tab-btn) and the mobile bottom-nav (.bnav-btn).
function _buildTabMenus() {
  Object.entries(TAB_VIEWS).forEach(([tab, items]) => {
    // Wire BOTH the top-nav button and the bottom-nav button if they exist
    [`.tab-btn[data-tab="${tab}"]`, `.bnav-btn[data-tab="${tab}"]`].forEach(sel => {
      const btn = document.querySelector(sel);
      if (!btn || btn.closest('.tab-btn-group')) return;
      const isBnav = btn.classList.contains('bnav-btn');

      // Wrap the button in a positioning container
      const group = document.createElement('div');
      group.className = 'tab-btn-group' + (isBnav ? ' bnav-btn-group' : '');
      btn.parentElement.insertBefore(group, btn);
      group.appendChild(btn);

      // Add chevron caret to the desktop button (bottom-nav buttons are
      // already cramped; the dropdown indicator there is implicit).
      if (!isBnav) {
        const caret = document.createElement('i');
        caret.className = 'fas fa-chevron-down tab-btn-caret';
        btn.appendChild(caret);
      }

      // Build dropdown menu (one per surface — IDs differ for top vs bottom)
      const menu = document.createElement('div');
      menu.className = 'tab-menu hidden' + (isBnav ? ' tab-menu-bnav' : '');
      menu.id = (isBnav ? 'bnav-menu-' : 'tab-menu-') + tab;
      const role = AppState?.userRole || '';
      menu.innerHTML = items.map(it => {
        if (it.divider) {
          return `<div class="tab-menu-divider">${it.label || ''}</div>`;
        }
        // items with a `roles` array are only shown to matching roles
        const hidden = it.roles && !it.roles.includes(role) ? ' style="display:none"' : '';
        return `<button class="tab-menu-item" data-view="${it.key}" onclick="navTabView('${tab}','${it.key}')"${hidden}>
          <i class="fas ${it.icon}"></i><span>${it.label}</span>
        </button>`;
      }).join('');
      group.appendChild(menu);

      // Replace inline onclick with our toggle handler
      btn.removeAttribute('onclick');
      btn.addEventListener('click', (e) => onTabBtnClick(tab, btn, e));
    });
  });

  // Click outside any tab group closes all menus
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.tab-btn-group')) _closeAllTabMenus();
  });
  // Close menus on window resize/scroll so the fixed-position popover doesn't
  // drift away from its trigger button.
  window.addEventListener('resize', _closeAllTabMenus);
  window.addEventListener('scroll', _closeAllTabMenus, { passive: true });
  // Close subtab picker on Escape
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSubtabPicker?.(); });
}

// ── Sub-tab switchers for the collapsed Reports — Attendance / Calling ──
// Both tabs now host their own [Live | Reports] (or [Calls | Reports]) toggle.
// Updates the "You are here" subtab name chip shown below the sub-tabs strip
function _updateSubtabChip(wrapId, nameId, label) {
  const wrap = document.getElementById(wrapId);
  const span = document.getElementById(nameId);
  if (!wrap || !span) return;
  if (label) { span.textContent = label; wrap.style.display = ''; }
  else        { wrap.style.display = 'none'; }
}

function switchAttSubTab(btn, sub) {
  // Live sub-tab is gated to Att. Seva users only
  if (sub === 'live' && !AppState.isAttSevaDev) {
    sub = 'coordinator';
    btn = document.querySelector('#tab-attendance .att-sub-tab[onclick*="\'coordinator\'"]') || btn;
  }
  const tabs = btn?.parentElement;
  if (tabs) tabs.querySelectorAll('.att-sub-tab').forEach(b => b.classList.remove('active'));
  btn?.classList.add('active');
  const careSubs = ['care-newcomers','care-returning','care-absent'];
  document.getElementById('att-panel-live').classList.toggle('active',          sub === 'live');
  document.getElementById('att-panel-coordinator').classList.toggle('active',   sub === 'coordinator');
  document.getElementById('att-panel-reports').classList.toggle('active',       sub === 'reports');
  document.getElementById('att-panel-repeat-absent')?.classList.toggle('active', sub === 'repeat-absent');
  careSubs.forEach(k => document.getElementById('att-panel-' + k)?.classList.toggle('active', sub === k));
  AppState._attSubTab = sub;
  const _attLabels = {
    live: 'Live Attendance', coordinator: 'Coordinator Performance', reports: 'Attendance Reports',
    'care-newcomers': 'New Comers', 'care-returning': 'Returning Newcomers',
    'repeat-absent': 'Repeat Absentees', 'care-absent': 'Absent',
  };
  _updateSubtabChip('att-active-subtab', 'att-active-subtab-name', _attLabels[sub] || sub);
  if (sub === 'live') {
    loadAttendanceTab?.();
  } else if (sub === 'coordinator') {
    if (typeof loadCoordinatorPerformance === 'function') loadCoordinatorPerformance();
  } else if (sub === 'repeat-absent') {
    if (typeof loadRepeatAbsenteesTab === 'function') loadRepeatAbsenteesTab();
  } else if (sub === 'care-returning') {
    const targetEl = document.getElementById('att-care-returning-content');
    if (targetEl && typeof loadReturningNewComers === 'function') loadReturningNewComers(targetEl);
  } else if (sub === 'care-absent') {
    const targetEl = document.getElementById('att-care-absent-merged-content');
    if (targetEl && typeof loadCareAbsentTab === 'function') loadCareAbsentTab(targetEl);
  } else if (sub === 'care-newcomers') {
    const targetEl = document.getElementById('att-care-newcomers-content');
    if (targetEl) {
      targetEl.innerHTML = '<div class="loading"><i class="fas fa-spinner"></i> Loading…</div>';
      if (typeof loadCareData === 'function') {
        loadCareData().then(() => {
          if (typeof _renderCareSection === 'function') _renderCareSection('newComers', targetEl);
        }).catch(() => {
          targetEl.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load</p></div>';
        });
      }
    }
  } else {
    _reportsCategory = 'attendance';
    if (typeof initReportsSessionFilter === 'function') initReportsSessionFilter();
    loadReports?.();
  }
}

function switchCallingSubTab(btn, sub) {
  const tabs = btn?.parentElement;
  if (tabs) tabs.querySelectorAll('.att-sub-tab').forEach(b => b.classList.remove('active'));
  btn?.classList.add('active');
  // Stats tiles only make sense on live-calling tabs, not reports/history
  const statsEl = document.getElementById('calling-stats');
  if (statsEl) {
    const showStats = ['calls','team-calling'].includes(sub); // only live calling tabs
    statsEl.style.display = showStats ? '' : 'none';
  }
  document.getElementById('calling-panel-list')?.classList.toggle('active',              sub === 'calls');
  document.getElementById('calling-panel-team')?.classList.toggle('active',              sub === 'team-calling');
  document.getElementById('calling-panel-reports')?.classList.toggle('active',           sub === 'reports');
  document.getElementById('calling-panel-history')?.classList.toggle('active',           sub === 'history');
  document.getElementById('calling-panel-said-coming')?.classList.toggle('active',       sub === 'said-coming');
  document.getElementById('calling-panel-not-coming-present')?.classList.toggle('active',sub === 'not-coming-present');
  AppState._callingSubTab = sub;
  const _callingLabels = {
    'calls': 'Your Calling Sewa', 'team-calling': 'Your Team Calling',
    'reports': 'Calling Reports', 'history': 'Calling History',
    'said-coming': 'Said Coming', 'not-coming-present': 'Surprise Present',
  };
  _updateSubtabChip('calling-active-subtab', 'calling-active-subtab-name', _callingLabels[sub] || sub);
  if (sub === 'calls') {
    loadCallingStatus?.();
  } else if (sub === 'team-calling') {
    loadTeamCallingList?.();
  } else if (sub === 'history') {
    loadCallingHistory?.();
  } else if (sub === 'said-coming') {
    loadSaidComingTab?.();
  } else if (sub === 'not-coming-present') {
    loadNotComingPresentTab?.();
  } else {
    _reportsCategory = 'calling';
    if (typeof _populateReportWeeks === 'function') _populateReportWeeks().then(() => loadCallingReports?.());
    else loadCallingReports?.();
  }
}

function switchSubTab(btn, id) {
  const scope = btn.closest('.reports-cat-panel') || document;
  scope.querySelectorAll('.sub-tab').forEach(b => b.classList.remove('active'));
  scope.querySelectorAll('.sub-panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('subtab-' + id)?.classList.add('active');
  if (id === 'trends')            loadTrends();
  if (id === 'serious-analysis')  loadSeriousAnalysis();
  if (id === 'team-leaderboard')  loadTeamLeaderboard();
  if (id === 'attendance-detail') loadAttendanceDetail();
  if (id === 'newcomers-report')  loadNewComersReport?.();
  renderBreadcrumb?.();
}

// ── EXPORT ATTENDANCE ─────────────────────────────────
async function exportAttendance() {
  if (!AppState.currentSessionId) return showToast('No session selected', 'error');
  try {
    const records = await DB.getSessionAttendance(AppState.currentSessionId);
    if (!records.length) return showToast('No attendance data', 'error');
    const rows = records.map(r => ({ Name: r.name, Mobile: r.mobile || '', 'Chanting Rounds': r.chanting_rounds, Team: r.team_name || '', 'Calling By': r.calling_by || '', Type: r.is_new_devotee ? 'New' : 'Regular' }));
    downloadExcel(rows, `attendance_${getToday()}.xlsx`);
  } catch (_) { showToast('Export failed', 'error'); }
}

// ── BREADCRUMB ──────────────────────────────────────────
// Renders the current location as a clickable path. Reads tab + sub-tab state
// from the DOM so we don't need a separate registry.
function renderBreadcrumb() {}
