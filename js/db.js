/* ══ DB.JS – All Firestore operations ══ */

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

// ── NORMALISERS ───────────────────────────────────────
function tsToISO(ts) {
  if (!ts) return null;
  if (ts.toDate) return ts.toDate().toISOString();
  if (typeof ts === 'string') return ts;
  return null;
}

function toSnake(d) {
  if (!d) return null;
  return {
    id: d.id,
    name:                d.name || '',
    mobile:              d.mobile || null,
    mobile_alt:          d.mobileAlt || null,
    address:             d.address || null,
    dob:                 d.dob || null,
    date_of_joining:     d.dateOfJoining || null,
    chanting_rounds:     d.chantingRounds || 0,
    kanthi:              d.kanthi || 0,
    gopi_dress:          d.gopiDress || 0,
    team_name:           d.teamName || null,
    devotee_status:      d.devoteeStatus || 'Expected to be Serious',
    facilitator:         d.facilitator || null,
    reference_by:        d.referenceBy || null,
    calling_by:          d.callingBy || null,
    remarks:             d.remarks || null,
    lifetime_attendance: d.lifetimeAttendance || 0,
    is_active:           d.isActive !== false ? 1 : 0,
    inactivity_flag:     d.inactivityFlag ? 1 : 0,
    created_at:          tsToISO(d.createdAt),
    updated_at:          tsToISO(d.updatedAt),
    coming_status:       d.comingStatus  || null,
    calling_notes:       d.callingNotes  || null,
    attendance_id:       d.attendanceId  || null,
    // Personal details
    education:           d.education || null,
    email:               d.email || null,
    profession:          d.profession || null,
    family_favourable:   d.familyFavourable || null,
    family_members:      d.familyMembers || null,
    family_participants: d.familyParticipants || null,
    reading:             d.reading || null,
    hearing:             d.hearing || null,
    hobbies:             d.hobbies || null,
    skills:              d.skills || null,
    tilak:               d.tilak || 0,
    plays_instrument:    d.playsInstrument || null,
    instrument_name:     d.instrumentName || null,
    wants_kirtan_class:  d.wantsKirtanClass || null,
    is_not_interested:      d.isNotInterested || false,
    not_interested_at:      tsToISO(d.notInterestedAt),
    prior_sessions_attended: d.priorSessionsAttended || 0,
    // True once this devotee has had a completed personal meeting with Prabhuji.
    // Drives the © "met" badge next to their name. Toggled off via the
    // Completed-meetings tab "disconnect" action.
    met_prabhuji:           d.metPrabhuji === true,
    profile_pic:            d.profilePic || null,
  };
}

function toCamel(f) {
  return {
    name:              (f.name || '').trim(),
    mobile:            (f.mobile || '').trim() || null,
    mobileAlt:         (f.mobile_alt || '').trim() || null,
    address:           (f.address || '').trim() || null,
    dob:               f.dob || null,
    dateOfJoining:     f.date_of_joining || null,
    chantingRounds:    parseInt(f.chanting_rounds) || 0,
    kanthi:            parseInt(f.kanthi) || 0,
    gopiDress:         parseInt(f.gopi_dress) || 0,
    teamName:          f.team_name || null,
    devoteeStatus:     f.devotee_status || 'Expected to be Serious',
    facilitator:       (f.facilitator || '').trim() || null,
    referenceBy:       (f.reference_by || '').trim() || null,
    callingBy:         (f.calling_by || '').trim() || null,
    remarks:           (f.remarks || '').trim() || null,
    education:         (f.education || '').trim() || null,
    email:             (f.email || '').trim() || null,
    profession:        (f.profession || '').trim() || null,
    familyFavourable:  f.family_favourable || null,
    familyMembers:     f.family_members || null,
    familyParticipants: f.family_participants || null,
    reading:           f.reading || null,
    hearing:           f.hearing || null,
    hobbies:           (f.hobbies || '').trim() || null,
    skills:            (f.skills || '').trim() || null,
    tilak:             parseInt(f.tilak) || 0,
    isNotInterested:         f.is_not_interested || false,
    notInterestedAt:         f.not_interested_at || null,
    priorSessionsAttended:   parseInt(f.prior_sessions_attended) || 0,
    ...(f.profile_pic !== undefined ? { profilePic: f.profile_pic } : {}),
  };
}

// ── DB ────────────────────────────────────────────────
const DB = {

  /* DEVOTEES */
  async getDevotees(filters = {}) {
    let list = await DevoteeCache.all();
    if (filters.search) {
      const s = filters.search.toLowerCase();
      list = list.filter(d => d.name.toLowerCase().includes(s) || (d.mobile || '').includes(s));
    }
    if (filters.team)       list = list.filter(d => d.teamName === filters.team);
    if (filters.calling_by) list = list.filter(d => d.callingBy === filters.calling_by);
    // "connecting" = devotees who have met Prabhuji (© badge). Source it directly
    // from completed personal meetings (robust even if the metPrabhuji flag wasn't
    // written), unioned with the flag. Otherwise match the devotee status.
    if (filters.status === 'connecting') {
      const metIds = new Set();
      try {
        const snap = await fdb.collection('personalMeetings').where('status', '==', 'completed').get();
        snap.docs.forEach(doc => { const did = doc.data().devoteeId; if (did) metIds.add(did); });
      } catch (_) {}
      list = list.filter(d => d.metPrabhuji === true || metIds.has(d.id));
    } else if (filters.status) {
      list = list.filter(d => d.devoteeStatus === filters.status);
    }
    return list.map(toSnake);
  },

  async getDevotee(id) {
    const doc = await fdb.collection('devotees').doc(id).get();
    if (!doc.exists) return null;
    return toSnake({ id: doc.id, ...doc.data() });
  },

  async getCallingPersons() {
    const list = await DevoteeCache.all();
    return [...new Set(list.map(d => d.callingBy).filter(Boolean))].sort();
  },

  async createDevotee(formData) {
    // Duplicate rule: only same NAME + same MOBILE is a duplicate.
    //   - same name + different mobile  → allowed (likely a different person sharing a name)
    //   - different name + same mobile  → allowed (e.g. shared family number)
    //   - same name + same mobile        → blocked as duplicate
    const list = await DevoteeCache.all();
    const mobile = (formData.mobile || '').trim();
    const name   = (formData.name   || '').trim();
    if (name && mobile) {
      const ex = list.find(d =>
        (d.mobile || '') === mobile &&
        (d.name || '').trim().toLowerCase() === name.toLowerCase()
      );
      if (ex) throw { error: 'Duplicate', message: `"${ex.name}" with this mobile already exists`, existingId: ex.id };
    }
    const payload = { ...toCamel(formData), lifetimeAttendance: 0, isActive: true, inactivityFlag: false, createdAt: TS(), updatedAt: TS() };
    const ref = await fdb.collection('devotees').add(payload);
    DevoteeCache.bust();
    return toSnake({ id: ref.id, ...payload });
  },

  async forceCreateDevotee(formData) {
    const payload = { ...toCamel(formData), lifetimeAttendance: 0, isActive: true, inactivityFlag: false, createdAt: TS(), updatedAt: TS() };
    const ref = await fdb.collection('devotees').add(payload);
    DevoteeCache.bust();
    return toSnake({ id: ref.id, ...payload });
  },

  async updateDevotee(id, formData) {
    const doc = await fdb.collection('devotees').doc(id).get();
    if (!doc.exists) throw new Error('Not found');
    const ex = doc.data();
    const updates = { ...toCamel(formData), updatedAt: TS() };
    const trackMap = { name:'name', mobile:'mobile', chantingRounds:'chanting_rounds', kanthi:'kanthi', gopiDress:'gopi_dress', teamName:'team_name', devoteeStatus:'devotee_status', facilitator:'facilitator', referenceBy:'reference_by', callingBy:'calling_by', remarks:'remarks' };
    const batch = fdb.batch();
    Object.entries(trackMap).forEach(([fKey, formKey]) => {
      const nv = updates[fKey], ov = ex[fKey];
      if (nv !== undefined && String(nv ?? '') !== String(ov ?? '')) {
        batch.set(fdb.collection('profileChanges').doc(), { devoteeId: id, fieldName: formKey, oldValue: String(ov ?? ''), newValue: String(nv ?? ''), changedAt: TS(), changedBy: AppState.userName || 'Coordinator' });
      }
    });
    batch.update(fdb.collection('devotees').doc(id), updates);
    await batch.commit();
    DevoteeCache.bust();
    return this.getDevotee(id);
  },

  async softDeleteDevotee(id) {
    await fdb.collection('devotees').doc(id).update({ isActive: false, updatedAt: TS() });
    DevoteeCache.bust();
  },

  async getProfileHistory(id) {
    const snap = await fdb.collection('profileChanges').where('devoteeId', '==', id).get();
    return snap.docs.map(d => {
      const dt = d.data();
      return { id: d.id, field_name: dt.fieldName, old_value: dt.oldValue, new_value: dt.newValue, changed_at: tsToISO(dt.changedAt), changed_by: dt.changedBy };
    }).sort((a, b) => (b.changed_at || '').localeCompare(a.changed_at || ''));
  },

  async importDevotees(rows, mode = 'add') {
    let imported = 0, updated = 0, skipped = [], errors = [];
    const list = await DevoteeCache.all();
    // Duplicate key = name + mobile (lowercased name).
    // Same name with a different number, or same number with a different name,
    // are NOT duplicates and will be imported as new devotees.
    const pairKey = (name, mobile) => `${(name || '').trim().toLowerCase()}|${(mobile || '').trim()}`;
    const pairMap = {};
    list.forEach(d => {
      pairMap[pairKey(d.name, d.mobile)] = { id: d.id, name: d.name };
    });

    for (let ci = 0; ci < rows.length; ci += 400) {
      const chunk = rows.slice(ci, ci + 400);
      const batch = fdb.batch(); let any = false;
      chunk.forEach((row, i) => {
        const rowNum = ci + i + 2;
        try {
          const name   = importCol(row, ['Name','name','Full Name','Devotee Name','NAAM']).trim();
          const mobile = importCol(row, ['Mobile','Contact','Phone','Mobile Number','Mobile (10 digits)','Contact Number','Mob','Ph No','Ph.No','mob no','contact']).replace(/\D/g,'').slice(0,10);
          if (!name) { skipped.push({ row: rowNum, name: '(blank)', mobile: mobile || '', reason: 'Name is empty' }); return; }

          const payload = {
            name,
            mobile:           mobile || null,
            address:          importCol(row, ['Address','address','Addr','ADDRESS']) || null,
            dob:              importDate(importCol(row, ['DOB','D.O.B','Date of Birth','Birth Date','dob','D.O.B.','DOB (DD/MM/YYYY)'])) || null,
            dateOfJoining:    importDate(importCol(row, ['Date of Joining','Date Of Joining','Joining Date','DOJ','Date of joining'])) || null,
            chantingRounds:   Math.abs(parseInt(importCol(row, ['Chanting Rounds','CHANTING','Chanting','CR','chanting','Rounds','rounds','chanting rounds'])) || 0),
            kanthi:           importYN(importCol(row, ['Kanthi','kanthi','KANTHI'])),
            gopiDress:        importYN(importCol(row, ['Gopi Dress','Gopi','GOPI','gopi dress','Gopi dress'])),
            tilak:            importYN(importCol(row, ['Tilak','tilak','TILAK'])),
            teamName:         importCol(row, ['Team','Team Wise','Team Name','TEAM','Group','team','Team wise','Teamwise']) || null,
            devoteeStatus:    importStatus(importCol(row, ['Status','Devotee Status','Dev Status','status','ETS','devotee status'])),
            facilitator:      importCol(row, ['Facilitator','facilitator','Faciltr']) || null,
            referenceBy:      importCol(row, ['Reference','Ref','Reference By','Referred By','Ref-2','ref','Ref 2','reference']) || null,
            callingBy:        importCol(row, ['Calling By','Called By','Caller','Calling by','calling by','CallingBy']) || null,
            remarks:          importCol(row, ['Remarks','remarks','Notes','notes','Comment','comment']) || null,
            education:        importCol(row, ['Education','education','EDUCATION']) || null,
            email:            importCol(row, ['Email','E-Mail','email','E Mail','e-mail','EMAIL']) || null,
            profession:       importCol(row, ['Profession','Occupation','profession','PROFESSION']) || null,
            familyFavourable: importCol(row, ['Family Favourable','Family Favorable','Family','family favourable','Family Favourable?']) || null,
            reading:          importCol(row, ['Reading','reading','READING']) || null,
            hearing:          importCol(row, ['Hearing','hearing','HEARING']) || null,
            hobbies:          importCol(row, ['Hobbies','hobbies','Hobby','HOBBIES']) || null,
            skills:           importCol(row, ['Skills','skills','Skill','SKILLS']) || null,
            isActive: true, inactivityFlag: false, updatedAt: TS(),
          };

          const dupKey = pairKey(name, mobile);
          const exact  = pairMap[dupKey];

          if (mode === 'upsert' && exact) {
            batch.update(fdb.collection('devotees').doc(exact.id), payload);
            updated++; any = true;
          } else if (exact) {
            skipped.push({ row: rowNum, name, mobile: mobile || '', reason: `Duplicate — same name + mobile already exists as "${exact.name}"` });
          } else {
            batch.set(fdb.collection('devotees').doc(), { ...payload, lifetimeAttendance: 0, createdAt: TS() });
            pairMap[dupKey] = { id: 'new', name };
            imported++; any = true;
          }
        } catch (e) { errors.push({ row: rowNum, name: '', mobile: '', reason: e.message }); }
      });
      if (any) await batch.commit();
    }
    DevoteeCache.bust();
    return { imported, updated, skipped, errors };
  },

  /* SESSIONS */
  async getTodaySession() {
    const upcomingSunday = getUpcomingSunday();
    // Use upcoming Sunday only if it already exists (admin has configured it in Session Mgmt).
    // Otherwise fall back to the most recent past session so the app opens on real data.
    const upcomingSnap = await fdb.collection('sessions')
      .where('sessionDate', '==', upcomingSunday).limit(1).get();
    if (!upcomingSnap.empty) {
      return { id: upcomingSnap.docs[0].id, session_date: upcomingSunday };
    }
    const pastSnap = await fdb.collection('sessions')
      .orderBy('sessionDate', 'desc').limit(1).get();
    if (!pastSnap.empty) {
      const d = pastSnap.docs[0];
      return { id: d.id, session_date: d.data().sessionDate };
    }
    // No sessions at all — create upcoming Sunday as the bootstrap session
    const ref = await fdb.collection('sessions').add({ sessionDate: upcomingSunday, createdAt: TS() });
    return { id: ref.id, session_date: upcomingSunday };
  },

  async getOrCreateSession(dateStr) {
    const snap = await fdb.collection('sessions').where('sessionDate', '==', dateStr).limit(1).get();
    if (!snap.empty) return { id: snap.docs[0].id, session_date: dateStr };
    const ref = await fdb.collection('sessions').add({ sessionDate: dateStr, createdAt: TS() });
    return { id: ref.id, session_date: dateStr };
  },

  async getSessions() {
    const snap = await fdb.collection('sessions').orderBy('sessionDate', 'desc').limit(52).get();
    return snap.docs.map(d => ({
      id: d.id,
      session_date: d.data().sessionDate,
      topic: d.data().topic || '',
      is_cancelled: d.data().isCancelled || false,
    }));
  },

  async configureSunday(sessionId, { topic, isCancelled }) {
    await fdb.collection('sessions').doc(sessionId).update({ topic: topic || '', isCancelled: !!isCancelled, updatedAt: TS() });
  },

  async getSessionsWithPresent() {
    const sessions = await this.getSessions();
    const counts = await Promise.all(
      sessions.map(s =>
        fdb.collection('attendanceRecords').where('sessionId', '==', s.id).get()
          .then(snap => snap.size).catch(() => 0)
      )
    );
    return sessions.map((s, i) => ({ ...s, present: counts[i] }));
  },

  async getSheetData(yearStart, yearEnd) {
    const snap = await fdb.collection('sessions')
      .where('sessionDate', '>=', yearStart)
      .where('sessionDate', '<=', yearEnd)
      .orderBy('sessionDate', 'asc').get();
    const sessions = snap.docs.map(d => ({
      id: d.id, sessionDate: d.data().sessionDate,
      topic: d.data().topic || '', isCancelled: d.data().isCancelled || false,
    }));
    if (!sessions.length) return { sessions: [], devotees: [], attMap: {}, attTimeMap: {}, csMap: {} };
    const devotees = await DevoteeCache.all();
    const sessionIds = sessions.map(s => s.id);

    // callingStatus.weekDate stores the SATURDAY calling date, not the Sunday
    // session date. Build a session→calling map (Sunday - 1 day) so the
    // calling-status query targets the right field, and a reverse map so we
    // can store results keyed by session date for the table.
    const callingDateForSession = {};
    const sessionDateForCalling = {};
    const callingDates = [];
    sessions.forEach(s => {
      const d = new Date(s.sessionDate + 'T00:00:00');
      d.setDate(d.getDate() - 1);
      const cd = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      callingDateForSession[s.sessionDate] = cd;
      sessionDateForCalling[cd] = s.sessionDate;
      callingDates.push(cd);
    });

    const attMap = {}, attTimeMap = {}, csMap = {};

    // Attendance: keyed by Firestore sessionId (doc ID).
    // attMap[sid] = Set of devoteeIds (existing behaviour, used for "did they attend")
    // attTimeMap[sid][did] = ISO timestamp string (used for the new Time column)
    for (let i = 0; i < sessionIds.length; i += 10) {
      const batch = sessionIds.slice(i, i + 10);
      const aSnap = await fdb.collection('attendanceRecords').where('sessionId', 'in', batch).get();
      aSnap.docs.forEach(d => {
        const data = d.data();
        const sid = data.sessionId, did = data.devoteeId;
        if (!attMap[sid]) attMap[sid] = new Set();
        attMap[sid].add(did);
        if (!attTimeMap[sid]) attTimeMap[sid] = {};
        attTimeMap[sid][did] = tsToISO(data.markedAt);
      });
    }

    // Calling status: query by calling dates (Saturdays), then store in csMap
    // keyed by SESSION date (Sunday) so the sheet's `csMap[s.sessionDate]`
    // lookup works as the table iterates over Sunday session columns.
    for (let i = 0; i < callingDates.length; i += 10) {
      const batch = callingDates.slice(i, i + 10);
      const cSnap = await fdb.collection('callingStatus').where('weekDate', 'in', batch).get();
      cSnap.docs.forEach(d => {
        const dt = d.data();
        const sessionDate = sessionDateForCalling[dt.weekDate];
        if (!sessionDate) return; // unmatched calling date — skip
        if (!csMap[sessionDate]) csMap[sessionDate] = {};
        // Store the FULL calling-status record (all fields: comingStatus,
        // callingReason, callingNotes, availableFrom, lateRemarks, triesCount,
        // texted, …) so every view can show complete data, not an abbreviation.
        csMap[sessionDate][dt.devoteeId] = { ...dt };
      });
    }
    return { sessions, devotees, attMap, attTimeMap, csMap };
  },

  async getSessionStats(sessionId) {
    // sessionId may be the Firestore doc ID OR the date string (YYYY-MM-DD).
    // Try doc lookup first; if missing, fall back to a date query.
    const [sessSnap, cfgSnap] = await Promise.all([
      fdb.collection('sessions').doc(sessionId).get(),
      fdb.collection('settings').doc('callingWeek').get(),
    ]);
    let realSessionId = sessionId;
    let sessionDate;
    if (sessSnap.exists) {
      sessionDate = sessSnap.data().sessionDate;
    } else {
      // sessionId is probably a date string — look it up by field
      const byDate = await fdb.collection('sessions').where('sessionDate', '==', sessionId).limit(1).get();
      if (!byDate.empty) {
        realSessionId = byDate.docs[0].id;
        sessionDate   = byDate.docs[0].data().sessionDate;
      } else {
        sessionDate = getUpcomingSunday();
      }
    }
    const cfg = cfgSnap.exists ? cfgSnap.data() : null;
    // callingStatus uses Saturday calling date; derive it if config doesn't match
    const weekDate = (cfg?.sessionDate === sessionDate && cfg?.callingDate)
      ? cfg.callingDate
      : (() => { const d = new Date(sessionDate + 'T00:00:00'); d.setDate(d.getDate()-1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();
    const [cs, at, allDevotees, submSnap] = await Promise.all([
      fdb.collection('callingStatus').where('weekDate', '==', weekDate).get(),
      fdb.collection('attendanceRecords').where('sessionId', '==', realSessionId).get(),
      DevoteeCache.all(),
      fdb.collection('callingSubmissions').where('weekDate', '==', weekDate).get(),
    ]);
    // Only count "Yes" from callers who have submitted — matches the calling report logic
    // so the attendance "Confirmed" tile and the report "Yes" column show the same number.
    const submittedCallers = new Set(submSnap.docs.map(d => d.data().userName).filter(Boolean));
    const devCallerMap = {};
    allDevotees.forEach(d => { if (d.callingBy) devCallerMap[d.id] = d.callingBy; });
    const confirmed = cs.docs.filter(d => {
      if (d.data().comingStatus !== 'Yes') return false;
      const caller = devCallerMap[d.data().devoteeId];
      return !caller || submittedCallers.has(caller);
    }).length;
    // "New" = attendance records explicitly marked isNewDevotee
    const newPresentSet = new Set(at.docs.filter(d => d.data().isNewDevotee).map(d => d.data().devoteeId));
    const newDevotees = newPresentSet.size;
    const present     = at.size - newDevotees;   // regular attendees only
    const totalPresent = at.size;                // present + new = all who attended
    return { confirmed, present, newDevotees, totalPresent };
  },

  /* ATTENDANCE */
  async getAttendanceCandidates(sessionId, search = '') {
    const [sessSnap, cfgSnap] = await Promise.all([
      fdb.collection('sessions').doc(sessionId).get(),
      fdb.collection('settings').doc('callingWeek').get(),
    ]);
    let realSessionId = sessionId;
    let sessionDate;
    if (sessSnap.exists) {
      sessionDate = sessSnap.data().sessionDate;
    } else {
      const byDate = await fdb.collection('sessions').where('sessionDate', '==', sessionId).limit(1).get();
      if (!byDate.empty) { realSessionId = byDate.docs[0].id; sessionDate = byDate.docs[0].data().sessionDate; }
      else sessionDate = getUpcomingSunday();
    }
    const cfg = cfgSnap.exists ? cfgSnap.data() : null;
    const week = (cfg?.sessionDate === sessionDate && cfg?.callingDate)
      ? cfg.callingDate
      : (() => { const d = new Date(sessionDate + 'T00:00:00'); d.setDate(d.getDate()-1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();
    const [rawDevotees, csSnap, atSnap] = await Promise.all([
      DevoteeCache.all(),
      fdb.collection('callingStatus').where('weekDate', '==', week).get(),
      fdb.collection('attendanceRecords').where('sessionId', '==', realSessionId).get()
    ]);
    const csMap = {}, markedAtMap = {};
    csSnap.docs.forEach(d => { csMap[d.data().devoteeId] = d.data(); });
    atSnap.docs.forEach(d => {
      markedAtMap[d.data().devoteeId] = tsToISO(d.data().markedAt);
    });
    const presentSet = new Set(atSnap.docs.map(d => d.data().devoteeId));
    let list = rawDevotees.filter(d => {
      const cs = csMap[d.id];
      return !cs || !['Shift', 'Not Interested'].includes(cs.comingStatus);
    });
    if (search) {
      const s = search.toLowerCase();
      list = list.filter(d => d.name.toLowerCase().includes(s) || (d.mobile || '').includes(s));
    }
    return list.map(d => ({
      ...toSnake(d),
      coming_status: csMap[d.id]?.comingStatus || null,
      attendance_id: presentSet.has(d.id) ? d.id : null,
      marked_at:     markedAtMap[d.id] || null,
    }));
  },

  async markPresent(sessionId, devotee, isNewDevotee = false) {
    const snap = await fdb.collection('attendanceRecords').where('sessionId', '==', sessionId).where('devoteeId', '==', devotee.id).limit(1).get();
    if (!snap.empty) throw { status: 409, error: 'Already marked present' };
    await fdb.collection('attendanceRecords').add({
      sessionId, devoteeId: devotee.id,
      devoteeName: devotee.name, teamName: devotee.team_name || null,
      mobile: devotee.mobile || null, referenceBy: devotee.reference_by || null,
      callingBy: devotee.calling_by || null, chantingRounds: devotee.chanting_rounds || 0,
      dob: devotee.dob || null, devoteeStatus: devotee.devotee_status || null,
      isNewDevotee, markedAt: TS()
    });
    await fdb.collection('devotees').doc(devotee.id).update({ lifetimeAttendance: INC(1), inactivityFlag: false, updatedAt: TS() });
    DevoteeCache.bust();
    if (typeof _bustDashboardCache === 'function') _bustDashboardCache();
    if (typeof _bustCareCache === 'function') _bustCareCache();
  },

  async undoPresent(sessionId, devoteeId) {
    const snap = await fdb.collection('attendanceRecords').where('sessionId', '==', sessionId).where('devoteeId', '==', devoteeId).limit(1).get();
    if (snap.empty) return;
    await snap.docs[0].ref.delete();
    await fdb.collection('devotees').doc(devoteeId).update({ lifetimeAttendance: INC(-1), updatedAt: TS() });
    DevoteeCache.bust();
    if (typeof _bustDashboardCache === 'function') _bustDashboardCache();
    if (typeof _bustCareCache === 'function') _bustCareCache();
  },

  async getSessionAttendance(sessionId) {
    const snap = await fdb.collection('attendanceRecords').where('sessionId', '==', sessionId).get();
    return snap.docs.map(d => {
      const dt = d.data();
      return { id: d.id, devotee_id: dt.devoteeId, name: dt.devoteeName, mobile: dt.mobile, chanting_rounds: dt.chantingRounds, team_name: dt.teamName, calling_by: dt.callingBy, is_new_devotee: dt.isNewDevotee ? 1 : 0, marked_at: tsToISO(dt.markedAt) };
    }).sort((a, b) => (b.marked_at || '').localeCompare(a.marked_at || ''));
  },

  /* CALLING CONFIG — cached 15s so window open/close propagates fast */
  _cfgCache: null,
  async getCallingWeekConfig() {
    if (this._cfgCache && Date.now() - this._cfgCache.ts < 15_000) return this._cfgCache.data;
    const doc = await fdb.collection('settings').doc('callingWeek').get();
    const data = doc.exists ? doc.data() : null;
    this._cfgCache = { ts: Date.now(), data };
    return data;
  },
  _bustCfgCache() { this._cfgCache = null; },
  async setCallingWeekConfig(callingDate, sessionDate, extra = {}) {
    const payload = {
      callingDate, sessionDate: sessionDate || '',
      updatedAt: TS(), updatedBy: AppState.userName
    };
    if (extra.topic       !== undefined) payload.topic       = extra.topic || '';
    if (extra.speakerName !== undefined) payload.speakerName = extra.speakerName || '';
    if (extra.sessionType !== undefined) payload.sessionType = extra.sessionType || 'regular';
    if (extra.callingWindowOpen !== undefined) payload.callingWindowOpen = !!extra.callingWindowOpen;
    await fdb.collection('settings').doc('callingWeek').set(payload, { merge: true });
    this._bustCfgCache();
    // Also propagate topic onto the Session doc so it shows on attendance screen
    if (sessionDate && (extra.topic !== undefined || extra.speakerName !== undefined || extra.sessionType !== undefined)) {
      const snap = await fdb.collection('sessions').where('sessionDate','==',sessionDate).limit(1).get();
      const update = { updatedAt: TS() };
      if (extra.topic       !== undefined) update.topic       = extra.topic || '';
      if (extra.speakerName !== undefined) update.speakerName = extra.speakerName || '';
      if (extra.sessionType !== undefined) update.sessionType = extra.sessionType || 'regular';
      if (snap.empty) {
        await fdb.collection('sessions').add({ sessionDate, createdAt: TS(), ...update });
      } else {
        await snap.docs[0].ref.update(update);
      }
    }
    // Calling week config changed → all derived caches are stale.
    if (typeof _bustDashboardCache === 'function') _bustDashboardCache();
    if (typeof _bustCareCache === 'function') _bustCareCache();
    if (typeof _bustCMCache === 'function') _bustCMCache();
  },

  /* ATTENDANCE TARGETS */
  async getAttendanceTargets() {
    const doc = await fdb.collection('settings').doc('attendanceTargets').get();
    return doc.exists ? doc.data() : { type: 'class', teams: {} };
  },
  async setAttendanceTargets(type, teams, global = 0) {
    await fdb.collection('settings').doc('attendanceTargets').set({
      type, teams, global, updatedAt: TS(), updatedBy: AppState.userName
    });
    // Target changes affect dashboard % column.
    if (typeof _bustDashboardCache === 'function') _bustDashboardCache();
  },

  // One-time migration: rename a team across all collections.
  // Checks settings/migrations to skip if already done.
  async migrateTeamNameOnce(oldName, newName) {
    const migKey = `teamRename_${oldName}_${newName}`;
    const migDoc = await fdb.collection('settings').doc('migrations').get();
    if (migDoc.exists && migDoc.data()[migKey]) return false; // already done

    const BATCH = 400;
    const collections = ['devotees','users','callingStatus','callingSubmissions',
      'attendanceRecords','bookDistributions','services','registrations','donations'];

    for (const col of collections) {
      try {
        const snap = await fdb.collection(col).where('teamName','==', oldName).get();
        for (let i = 0; i < snap.docs.length; i += BATCH) {
          const batch = fdb.batch();
          snap.docs.slice(i, i + BATCH).forEach(d => batch.update(d.ref, { teamName: newName }));
          await batch.commit();
        }
      } catch (_) {}
    }

    // Also fix attendanceTargets settings doc if it has the old team key
    try {
      const tDoc = await fdb.collection('settings').doc('attendanceTargets').get();
      if (tDoc.exists && tDoc.data().teams?.[oldName] !== undefined) {
        const teams = { ...tDoc.data().teams };
        teams[newName] = teams[oldName];
        delete teams[oldName];
        await fdb.collection('settings').doc('attendanceTargets').update({ teams });
      }
    } catch (_) {}

    // Mark as done
    await fdb.collection('settings').doc('migrations').set({ [migKey]: true }, { merge: true });
    return true;
  },

  // On-demand team rename — updates all collections in one go.
  async renameTeam(oldName, newName) {
    if (!oldName || !newName || oldName === newName) throw new Error('Invalid team names');
    const BATCH = 400;
    const collections = ['devotees','users','callingStatus','callingSubmissions',
      'attendanceRecords','bookDistributions','services','registrations','donations'];
    let totalUpdated = 0;
    for (const col of collections) {
      try {
        const snap = await fdb.collection(col).where('teamName', '==', oldName).get();
        for (let i = 0; i < snap.docs.length; i += BATCH) {
          const batch = fdb.batch();
          snap.docs.slice(i, i + BATCH).forEach(d => batch.update(d.ref, { teamName: newName }));
          await batch.commit();
          totalUpdated += Math.min(BATCH, snap.docs.length - i);
        }
      } catch (_) {}
    }
    try {
      const tDoc = await fdb.collection('settings').doc('attendanceTargets').get();
      if (tDoc.exists && tDoc.data().teams?.[oldName] !== undefined) {
        const teams = { ...tDoc.data().teams };
        teams[newName] = teams[oldName];
        delete teams[oldName];
        await fdb.collection('settings').doc('attendanceTargets').update({ teams });
      }
    } catch (_) {}
    DevoteeCache.bust();
    return totalUpdated;
  },

  // When a coordinator renames themselves, propagate the new name to every
  // devotee whose callingBy field still holds the old name.
  async updateCallingByName(oldName, newName) {
    const snap = await fdb.collection('devotees').where('callingBy', '==', oldName).get();
    if (!snap.size) return;
    const BATCH = 400;
    for (let i = 0; i < snap.docs.length; i += BATCH) {
      const batch = fdb.batch();
      snap.docs.slice(i, i + BATCH).forEach(d => batch.update(d.ref, { callingBy: newName }));
      await batch.commit();
    }
  },

  /* PERSONAL MEETINGS */
  async getPersonalMeetings() {
    const snap = await fdb.collection('personalMeetings').get();
    return snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.scheduledDate || '').localeCompare(a.scheduledDate || ''));
  },
  async addPersonalMeeting(data) {
    return fdb.collection('personalMeetings').add({
      devoteeId: data.devoteeId || '',
      devoteeName: data.devoteeName || '',
      teamName: data.teamName || '',
      devoteeStatus: data.devoteeStatus || '',
      scheduledDate: data.scheduledDate || '',
      metBy: data.metBy || '',
      status: data.status || 'scheduled',
      completedDate: data.completedDate || '',
      notes: data.notes || '',
      authorityRemarks: data.authorityRemarks || '',
      createdAt: TS(),
      updatedAt: TS(),
      createdBy: AppState.userName || '',
    });
  },
  async updatePersonalMeeting(id, data) {
    await fdb.collection('personalMeetings').doc(id).update({
      ...data,
      updatedAt: TS(),
    });
  },
  async deletePersonalMeeting(id) {
    await fdb.collection('personalMeetings').doc(id).delete();
  },

  // ── INTERACTIONS (4-level call/meet tracker) ──────────────────────────────
  async logInteraction(data) {
    return fdb.collection('interactions').add({
      devoteeId:    data.devoteeId    || '',
      devoteeName:  data.devoteeName  || '',
      teamName:     data.teamName     || '',
      level:        data.level        || 4,      // 1-4
      type:         data.type         || 'call', // 'call' | 'meet' | 'parent-meet'
      by:           data.by           || AppState.userName || '',
      byUserId:     data.byUserId     || AppState.userId   || '',
      notes:        data.notes        || '',
      at:           TS(),
      atClient:     new Date().toISOString(),
    });
  },

  async getDevoteeInteractions(devoteeId) {
    // No orderBy to avoid composite index requirement — sort client-side
    const snap = await fdb.collection('interactions')
      .where('devoteeId', '==', devoteeId).limit(50).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.atClient || '').localeCompare(a.atClient || ''));
  },

  async getMyInteractions(userId) {
    // No orderBy to avoid composite index requirement — sort client-side
    const snap = await fdb.collection('interactions')
      .where('byUserId', '==', userId).limit(100).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.atClient || '').localeCompare(a.atClient || ''));
  },

  async getRecentInteractions(teamFilter) {
    // Simple collection scan — no composite index needed
    const snap = await fdb.collection('interactions').limit(200).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(d => !teamFilter || d.teamName === teamFilter)
      .sort((a, b) => (b.atClient || '').localeCompare(a.atClient || ''));
  },

  // Permanently delete devotees (hard delete). Used only for the
  // Not-Interested bulk-cleanup flow — super-admin only, irreversible.
  // History/audit rows in other collections are left untouched.
  async hardDeleteDevotees(ids) {
    const list = (ids || []).filter(Boolean);
    if (!list.length) return 0;
    const BATCH = 400;
    for (let i = 0; i < list.length; i += BATCH) {
      const batch = fdb.batch();
      list.slice(i, i + BATCH).forEach(id => batch.delete(fdb.collection('devotees').doc(id)));
      await batch.commit();
    }
    DevoteeCache.bust();
    return list.length;
  },

  // Toggle the "met Prabhuji" badge flag on a devotee. Set true when a meeting
  // is completed; set false from the Completed-meetings "disconnect" action.
  async setDevoteeMetPrabhuji(devoteeId, value) {
    if (!devoteeId) return;
    await fdb.collection('devotees').doc(devoteeId).set(
      { metPrabhuji: !!value, updatedAt: TS() }, { merge: true }
    );
    DevoteeCache.bust();
  },

  // One-time backfill: mark every devotee who already has a completed meeting
  // so existing data shows the © badge. Idempotent — guarded by a migration key.
  async migrateMetPrabhujiOnce() {
    const migKey = 'metPrabhujiBackfill_v1';
    try {
      const mDoc = await fdb.collection('settings').doc('migrations').get();
      if (mDoc.exists && mDoc.data()[migKey]) return false;
    } catch (_) { return false; }
    const snap = await fdb.collection('personalMeetings').where('status', '==', 'completed').get();
    const ids = [...new Set(snap.docs.map(d => d.data().devoteeId).filter(Boolean))];
    const BATCH = 400;
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = fdb.batch();
      ids.slice(i, i + BATCH).forEach(id =>
        batch.set(fdb.collection('devotees').doc(id), { metPrabhuji: true }, { merge: true }));
      await batch.commit();
    }
    await fdb.collection('settings').doc('migrations').set({ [migKey]: true }, { merge: true });
    return ids.length > 0;
  },

  /* CALLING */
  async getCallingStatus(weekDate) {
    const [raw, csSnap, cfgSnap] = await Promise.all([
      DevoteeCache.all(),
      fdb.collection('callingStatus').where('weekDate', '==', weekDate).get(),
      fdb.collection('settings').doc('callingWeek').get(),
    ]);
    const csMap = {};
    csSnap.docs.forEach(d => { csMap[d.data().devoteeId] = { id: d.id, ...d.data() }; });
    const sessionType = cfgSnap.exists ? (cfgSnap.data().sessionType || 'regular') : 'regular';
    const isFestival  = sessionType === 'festival';
    let filtered = raw.filter(d => {
      if (d.isNotInterested) return false;
      if (d.callingMode === 'not_interested') return false;
      if (d.callingMode === 'online') return false;
      if (d.callingMode === 'festival') {
        if (!isFestival) return false;
        return !!(d.callingBy && d.callingBy.trim());
      }
      return !!(d.callingBy && d.callingBy.trim());
    });
    // Calls tab is always personal — filter to only this user's assigned devotees
    filtered = filtered.filter(d => d.callingBy === AppState.userName);
    return filtered.map(d => ({
      ...toSnake(d),
      coming_status:     csMap[d.id]?.comingStatus    || null,
      calling_notes:     csMap[d.id]?.callingNotes    || null,
      calling_reason:    csMap[d.id]?.callingReason   || null,
      available_from:    csMap[d.id]?.availableFrom   || null,
      calling_id:        csMap[d.id]?.id              || null,
      updated_at_client: csMap[d.id]?.updatedAtClient || null,
      late_remarks:      csMap[d.id]?.lateRemarks     || null,
      tries_count:       csMap[d.id]?.triesCount      ?? null,
      texted:            csMap[d.id]?.texted          ?? null,
    }));
  },

  // Team Calling tab — all facilitators' calling lists for oversight.
  // superAdmin: all teams (filtered via master filter bar in UI).
  // teamAdmin: own team only.
  async getTeamCallingStatus(weekDate) {
    const [raw, csSnap, cfgSnap, submSnap] = await Promise.all([
      DevoteeCache.all(),
      fdb.collection('callingStatus').where('weekDate', '==', weekDate).get(),
      fdb.collection('settings').doc('callingWeek').get(),
      fdb.collection('callingSubmissions').where('weekDate', '==', weekDate).get(),
    ]);
    const csMap = {};
    csSnap.docs.forEach(d => { csMap[d.data().devoteeId] = { id: d.id, ...d.data() }; });
    const sessionType = cfgSnap.exists ? (cfgSnap.data().sessionType || 'regular') : 'regular';
    const isFestival  = sessionType === 'festival';
    const submittedCallers = new Set(submSnap.docs.map(d => d.data().userName).filter(Boolean));

    let filtered = raw.filter(d => {
      if (d.isNotInterested) return false;
      if (d.callingMode === 'not_interested') return false;
      if (d.callingMode === 'online') return false;
      if (d.callingMode === 'festival') {
        if (!isFestival) return false;
        return !!(d.callingBy && d.callingBy.trim());
      }
      return !!(d.callingBy && d.callingBy.trim());
    });
    // teamAdmin sees only their own team; superAdmin sees all
    if (AppState.userRole === 'teamAdmin' && AppState.userTeam) {
      filtered = filtered.filter(d => d.teamName === AppState.userTeam);
    }
    const devotees = filtered.map(d => ({
      ...toSnake(d),
      coming_status:     csMap[d.id]?.comingStatus    || null,
      calling_notes:     csMap[d.id]?.callingNotes    || null,
      calling_reason:    csMap[d.id]?.callingReason   || null,
      available_from:    csMap[d.id]?.availableFrom   || null,
      calling_id:        csMap[d.id]?.id              || null,
      updated_at_client: csMap[d.id]?.updatedAtClient || null,
      tries_count:       csMap[d.id]?.triesCount      ?? null,
      texted:            csMap[d.id]?.texted          ?? null,
    }));
    return { devotees, submittedCallers };
  },

  async getUsersForTeam(team, search = '') {
    const snap = await fdb.collection('users').get();
    let users = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
    users = users.filter(u => u.role !== 'superAdmin');
    if (team) users = users.filter(u => u.teamName === team);
    if (search) {
      const s = search.toLowerCase();
      users = users.filter(u => (u.name || '').toLowerCase().includes(s));
    }
    return users;
  },

  async getNotInterestedDevotees() {
    const snap = await fdb.collection('devotees').where('isNotInterested', '==', true).get();
    return snap.docs.map(d => toSnake({ id: d.id, ...d.data() }));
  },

  async markNotInterested(id) {
    const updates = { isNotInterested: true, notInterestedAt: TS(), updatedAt: TS(), teamName: '', callingBy: '' };
    const batch = fdb.batch();
    batch.update(fdb.collection('devotees').doc(id), updates);
    batch.set(fdb.collection('profileChanges').doc(), {
      devoteeId: id, fieldName: 'is_not_interested',
      oldValue: 'false', newValue: 'true',
      changedAt: TS(), changedBy: AppState.userName || 'Admin'
    });
    await batch.commit();
    DevoteeCache.bust();
  },

  async updateCallingStatus(devoteeId, weekDate, data) {
    const now = new Date();
    const snap = await fdb.collection('callingStatus').where('devoteeId', '==', devoteeId).where('weekDate', '==', weekDate).limit(1).get();
    const payload = {
      devoteeId, weekDate,
      comingStatus:    data.coming_status || '',
      updatedAt:       TS(),
      updatedAtClient: now.toISOString(),
    };
    if (data.calling_notes   !== undefined) payload.callingNotes   = data.calling_notes   ?? null;
    if (data.calling_reason  !== undefined) payload.callingReason  = data.calling_reason  ?? null;
    if (data.available_from  !== undefined) payload.availableFrom  = data.available_from  ?? null;
    if (data.late_remarks    !== undefined) payload.lateRemarks    = data.late_remarks    ?? null;
    // Did-not-pick follow-up fields
    if (data.tries_count     !== undefined) payload.triesCount     = data.tries_count     ?? null;
    if (data.texted          !== undefined) payload.texted         = data.texted          ?? null;

    if (snap.empty) {
      payload.createdAt = TS();
      payload.createdAtClient = now.toISOString();
      await fdb.collection('callingStatus').add(payload);
    } else {
      const prev = snap.docs[0].data();
      await snap.docs[0].ref.update(payload);

      // Record what changed so coordinators can see the full edit history.
      // Only write a history entry when something meaningful actually changed.
      const changes = {};
      if ((prev.comingStatus  || '') !== (payload.comingStatus  || '')) changes.comingStatus  = { from: prev.comingStatus  || '', to: payload.comingStatus  || '' };
      if ((prev.callingReason || '') !== (payload.callingReason || '')) changes.callingReason = { from: prev.callingReason || '', to: payload.callingReason || '' };
      if ((prev.callingNotes  || '') !== (payload.callingNotes  || '')) changes.callingNotes  = { from: prev.callingNotes  || '', to: payload.callingNotes  || '' };
      if (Object.keys(changes).length) {
        await fdb.collection('callingStatusChanges').add({
          devoteeId,
          weekDate,
          changedAt:       TS(),
          changedAtClient: now.toISOString(),
          changedBy:       AppState.userName || '',
          changes,
        });
      }
    }
    // Calling status drives Dashboard "Called/Yes" counts and Care lists.
    // Bust those caches so next view shows fresh numbers.
    if (typeof _bustDashboardCache === 'function') _bustDashboardCache();
    if (typeof _bustCareCache === 'function') _bustCareCache();
  },


  // Returns last 4 calling weeks + per-devotee status + which devotee+week combos
  // had post-submission edits (for the pencil icon in the Calling History grid).
  async getCallingHistoryGrid(teamFilter, callerFilter) {
    // Last 4 calling Saturdays — find the most recent Saturday, step back weekly
    const saturdays = [];
    const anchor = new Date();
    const dayOfWeek = anchor.getDay(); // 0=Sun … 6=Sat
    const daysToSat = dayOfWeek === 6 ? 0 : dayOfWeek + 1;
    anchor.setDate(anchor.getDate() - daysToSat);
    for (let i = 0; i < 4; i++) {
      const d = new Date(anchor);
      d.setDate(d.getDate() - i * 7);
      saturdays.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`);
    }
    // oldest → newest for column order
    saturdays.reverse();

    const oldestWeek = saturdays[0];

    const [allDevotees, csSnaps, changesResult, submSnaps] = await Promise.all([
      DevoteeCache.all(),
      // callingStatus for all 4 weeks in one query (Firestore 'in' allows up to 10)
      fdb.collection('callingStatus').where('weekDate', 'in', saturdays).get(),
      // edits — fail-safe: callingStatusChanges may not have Firebase rules deployed yet
      fdb.collection('callingStatusChanges').where('weekDate', '>=', oldestWeek).get()
        .catch(() => ({ docs: [] })),
      // submissions to know who submitted each week
      fdb.collection('callingSubmissions').where('weekDate', '>=', oldestWeek).get(),
    ]);
    const changesSnap = changesResult;

    // Build lookup: devoteeId+weekDate → callingStatus data
    const csMap = {}; // key: `${devoteeId}__${weekDate}`
    csSnaps.docs.forEach(d => {
      const dt = d.data();
      csMap[`${dt.devoteeId}__${dt.weekDate}`] = dt;
    });

    // Build set of devoteeId+weekDate combos that were edited after submission
    const editedSet = new Set();
    changesSnap.docs.forEach(d => {
      const dt = d.data();
      editedSet.add(`${dt.devoteeId}__${dt.weekDate}`);
    });

    // submission map: weekDate → Set of callerNames who submitted
    const submMap = {};
    saturdays.forEach(w => { submMap[w] = new Set(); });
    submSnaps.docs.forEach(d => {
      const { weekDate, userName } = d.data();
      if (submMap[weekDate]) submMap[weekDate].add(userName);
    });

    // Filter devotees
    let devotees = allDevotees.filter(d => d.isActive !== false && !d.isNotInterested && d.callingBy);
    if (teamFilter)   devotees = devotees.filter(d => d.teamName   === teamFilter);
    if (callerFilter) devotees = devotees.filter(d => d.callingBy  === callerFilter);
    devotees.sort((a, b) => (a.teamName || '').localeCompare(b.teamName || '') || (a.name || '').localeCompare(b.name || ''));

    return {
      weeks: saturdays,
      submMap,
      devotees: devotees.map(d => ({
        id: d.id, name: d.name, teamName: d.teamName, callingBy: d.callingBy,
        weeks: saturdays.map(w => {
          const cs = csMap[`${d.id}__${w}`] || null;
          const wasEdited = editedSet.has(`${d.id}__${w}`);
          return { weekDate: w, cs, wasEdited };
        }),
      })),
    };
  },

  async getCallingStatusChanges(devoteeId) {
    // Last 8 weeks of change history, newest first
    const cutoff = (() => {
      const d = new Date(); d.setDate(d.getDate() - 56);
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    })();
    const snap = await fdb.collection('callingStatusChanges')
      .where('devoteeId', '==', devoteeId)
      .where('weekDate', '>=', cutoff)
      .get();
    return snap.docs
      .map(d => ({ id: d.id, ...d.data(), changedAtISO: tsToISO(d.data().changedAt) }))
      .sort((a, b) => (b.changedAtISO || b.changedAtClient || '').localeCompare(a.changedAtISO || a.changedAtClient || ''));
  },

  async getCallingHistory(devoteeId, weeksBefore = 4) {
    // Fetch ALL callingStatus records for this devotee, sort by weekDate desc,
    // take the most recent N. This works regardless of whether weekDate is a
    // Saturday (calling day) or Sunday (session day) — no date-type mismatch.
    const snap = await fdb.collection('callingStatus')
      .where('devoteeId', '==', devoteeId)
      .get();
    return snap.docs
      .map(d => ({ weekDate: d.data().weekDate, ...d.data(), id: d.id }))
      .filter(r => r.weekDate)
      .sort((a, b) => b.weekDate.localeCompare(a.weekDate))
      .slice(0, weeksBefore);
  },

  async getLateSubmissions(weekDate, afterHour = 21) {
    const snap = await fdb.collection('callingStatus').where('weekDate', '==', weekDate).get();
    const all  = await DevoteeCache.all();
    const devMap = {}; all.forEach(d => { devMap[d.id] = d; });
    return snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(r => {
        const t = r.updatedAtClient || (r.updatedAt?.toDate ? r.updatedAt.toDate().toISOString() : null);
        if (!t) return false;
        return new Date(t).getHours() >= afterHour;
      })
      .map(r => {
        const dev = devMap[r.devoteeId] || {};
        return {
          id: r.id, devoteeId: r.devoteeId,
          name: dev.name || '—', team_name: dev.teamName || '',
          calling_by: dev.callingBy || '',
          coming_status: r.comingStatus || '',
          updated_at_client: r.updatedAtClient || null,
          late_remarks: r.lateRemarks || '',
        };
      })
      .sort((a, b) => (a.updated_at_client || '').localeCompare(b.updated_at_client || ''));
  },

  async saveCallingRemarks(statusId, remarks) {
    await fdb.collection('callingStatus').doc(statusId).update({ lateRemarks: remarks, updatedAt: TS() });
    if (typeof _bustDashboardCache === 'function') _bustDashboardCache();
  },

  async submitCallingWeek(weekDate, userId, userName, teamName) {
    const docId = `${userId}_${weekDate}`;
    const now = new Date().toISOString();
    const docRef = fdb.collection('callingSubmissions').doc(docId);
    const existing = await docRef.get();
    if (existing.exists && existing.data().initialSubmittedAtClient) {
      await docRef.update({
        weekDate, userId, userName, teamName: teamName || '',
        submittedAt: TS(), submittedAtClient: now,
      });
    } else {
      await docRef.set({
        weekDate, userId, userName, teamName: teamName || '',
        submittedAt: TS(), submittedAtClient: now,
        initialSubmittedAt: TS(), initialSubmittedAtClient: now,
      });
    }
  },

  async getCallingSubmissions(weekDates) {
    const result = {};
    weekDates.forEach(w => { result[w] = {}; });
    await Promise.all(weekDates.map(async w => {
      const snap = await fdb.collection('callingSubmissions').where('weekDate', '==', w).get();
      snap.docs.forEach(d => {
        const { userName, teamName, submittedAtClient, initialSubmittedAtClient } = d.data();
        result[w][userName] = {
          teamName: teamName || '',
          submittedAtClient: submittedAtClient || null,
          initialSubmittedAtClient: initialSubmittedAtClient || submittedAtClient || null,
        };
      });
    }));
    return result;
  },

  async getMyCallingSubmission(weekDate, userId) {
    const docId = `${userId}_${weekDate}`;
    const doc = await fdb.collection('callingSubmissions').doc(docId).get();
    if (doc.exists) return doc.data();
    const snap = await fdb.collection('callingSubmissions')
      .where('weekDate', '==', weekDate).where('userId', '==', userId).limit(1).get();
    return snap.empty ? null : snap.docs[0].data();
  },

  async getCallingWeeksList() {
    const snap = await fdb.collection('callingSubmissions').orderBy('weekDate', 'desc').get();
    const weeks = [...new Set(snap.docs.map(d => d.data().weekDate).filter(Boolean))];
    return weeks.sort((a, b) => b.localeCompare(a));
  },

  async getSubmissionReport() {
    const [submSnap, usersSnap, allDevotees] = await Promise.all([
      fdb.collection('callingSubmissions').orderBy('weekDate', 'desc').limit(500).get(),
      fdb.collection('users').get(),
      DevoteeCache.all(),
    ]);

    // Last 4 distinct calling dates that have submissions
    const weekDatesSet = new Set();
    submSnap.docs.forEach(d => weekDatesSet.add(d.data().weekDate));
    const fourWeeks = [...weekDatesSet].sort().slice(-4);

    if (!fourWeeks.length) return { fourWeeks: [], teamRows: [] };

    // uid → current name (source of truth for all name resolution)
    const uidNameMap = {};
    usersSnap.docs.forEach(d => { if (d.data().name) uidNameMap[d.id] = d.data().name; });

    // Super admins are NOT callers — their calling activity must not be tracked
    // in this report. Collect their names to exclude everywhere below.
    const superAdminNames = new Set();
    usersSnap.docs.forEach(d => { const u = d.data(); if (u.role === 'superAdmin' && u.name) superAdminNames.add(u.name); });

    // Build old-stored-name → current-name alias map from submission docs.
    // Each submission stores both userId and the userName at submission time,
    // so if a coordinator renamed themselves we can detect and merge them.
    const aliasNameMap = {};
    submSnap.docs.forEach(d => {
      const { userId, userName } = d.data();
      if (userId && uidNameMap[userId] && userName && userName !== uidNameMap[userId]) {
        aliasNameMap[userName] = uidNameMap[userId];
      }
    });

    // Resolve any name to its current version
    const resolveName = (name, userId) => {
      if (userId && uidNameMap[userId]) return uidNameMap[userId];
      return aliasNameMap[name] || name;
    };

    // Team admins: teamName → current adminName
    const teamAdminMap = {};
    usersSnap.docs.forEach(d => {
      const u = d.data();
      if (u.role === 'teamAdmin' && u.teamName && u.name) teamAdminMap[u.teamName] = u.name;
    });

    // Submission map: weekDate → currentName → { initialSubmittedAtClient }
    const submMap = {};
    fourWeeks.forEach(w => { submMap[w] = {}; });
    submSnap.docs.forEach(d => {
      const { weekDate, userId, userName, teamName, submittedAtClient, initialSubmittedAtClient } = d.data();
      if (!submMap[weekDate]) return;
      const currentName = resolveName(userName, userId);
      // Keep earliest initial time if two records resolve to the same person
      const existing = submMap[weekDate][currentName];
      const incoming = initialSubmittedAtClient || submittedAtClient || null;
      submMap[weekDate][currentName] = {
        teamName: teamName || '',
        initial: existing?.initial && incoming
          ? (existing.initial < incoming ? existing.initial : incoming)
          : (existing?.initial || incoming),
      };
    });

    // Coordinator → team from devotees; resolve any stale callingBy names
    const coordTeamMap = {};
    allDevotees.filter(d => d.callingBy && !d.isNotInterested).forEach(d => {
      const name = aliasNameMap[d.callingBy] || d.callingBy;
      if (!coordTeamMap[name]) coordTeamMap[name] = d.teamName || '';
    });
    // Also register team admins themselves
    Object.entries(teamAdminMap).forEach(([team, name]) => {
      if (!coordTeamMap[name]) coordTeamMap[name] = team;
    });
    // Include anyone who submitted but isn't in devotees — except super admins.
    fourWeeks.forEach(w => {
      Object.entries(submMap[w]).forEach(([name, s]) => {
        if (superAdminNames.has(name)) return;   // never list super admins as callers
        if (!coordTeamMap[name]) coordTeamMap[name] = s.teamName || '';
      });
    });

    // Build per-team lists
    const teamMap = {};
    Object.entries(coordTeamMap).forEach(([name, team]) => {
      if (!teamMap[team]) teamMap[team] = { admin: teamAdminMap[team] || null, others: [] };
      teamMap[team].others.push(name);
    });

    // Build ordered teamRows: known TEAMS first, then any extras
    const teamRows = [];
    const knownTeamNames = (typeof TEAMS !== 'undefined') ? TEAMS : [];
    [...knownTeamNames, ...Object.keys(teamMap).filter(t => !knownTeamNames.includes(t))].forEach(team => {
      if (!teamMap[team]) return;
      const { admin, others } = teamMap[team];
      const cleanAdmin = superAdminNames.has(admin) ? null : admin;
      const othersSorted = [...new Set(others)].filter(n => n !== cleanAdmin && !superAdminNames.has(n)).sort();
      if (!cleanAdmin && !othersSorted.length) return;  // drop empty rows (e.g. super-admin-only)
      teamRows.push({ team, admin: cleanAdmin, coordinators: othersSorted });
    });

    return { fourWeeks, submMap, teamRows };
  },

  async getCallingReport(weekDate, sessionDateOverride) {
    // weekDate is the calling date (Saturday). Derive the session date (Sunday = +1 day)
    // unless the caller already knows the session date (avoids off-by-one when calling
    // was done on a non-standard day configured via settings/callingWeek).
    const sessionDate = sessionDateOverride || (() => {
      const d = new Date(weekDate + 'T00:00:00');
      d.setDate(d.getDate() + 1);
      return localDateStr(d);
    })();
    const [raw, snap, usersSnap, submSnap] = await Promise.all([
      DevoteeCache.all(),
      fdb.collection('callingStatus').where('weekDate', '==', weekDate).get(),
      fdb.collection('users').get(),
      fdb.collection('callingSubmissions').where('weekDate', '==', weekDate).get(),
    ]);
    const csMap = {};
    snap.docs.forEach(d => { csMap[d.data().devoteeId] = d.data(); });
    const userRoleMap = {};
    usersSnap.docs.forEach(d => { const u = d.data(); if (u.name) userRoleMap[u.name] = { role: u.role, position: u.position || null }; });
    // "Submit" is the trigger that finalises a caller's work for the week.
    // Counts (Yes / Online / Festival / Not Interested / Called / Not Called)
    // are only computed for callers who have submitted; un-submitted callers
    // appear in the report with a "Not Submitted" flag so admins can chase them.
    const submittedCallers = new Set();
    submSnap.docs.forEach(d => { const n = d.data().userName; if (n) submittedCallers.add(n); });

    const sessSnap = await fdb.collection('sessions')
      .where('sessionDate', '==', sessionDate).limit(1).get();
    let attSet = new Set(), hasSession = false;
    if (!sessSnap.empty && !sessSnap.docs[0].data().isCancelled) {
      hasSession = true;
      const attSnap = await fdb.collection('attendanceRecords')
        .where('sessionId', '==', sessSnap.docs[0].id).get();
      attSnap.docs.forEach(d => attSet.add(d.data().devoteeId));
    }

    const active = raw.filter(d => d.callingBy && !d.isNotInterested);
    const STAT_KEYS = ['called','yes','online','festival','notInterested','notCalled','came','yesAndCame','yesNotCame','noButCame'];
    const zeroStats = () => Object.fromEntries(STAT_KEYS.map(k => [k, 0]));

    const result = { _hasSession: hasSession, _totalPresent: attSet.size };
    TEAMS.forEach(team => {
      const members = active.filter(d => d.teamName === team);
      if (!members.length) return;
      const callers = [...new Set(members.map(d => d.callingBy).filter(Boolean))].sort();
      result[team] = { total: members.length, ...zeroStats(), callers: {}, unsubmittedTotal: 0 };
      callers.forEach(caller => {
        const sub = members.filter(d => d.callingBy === caller);
        const submitted = submittedCallers.has(caller);
        const s = { total: sub.length, ...zeroStats(), submitted };
        if (submitted) {
          sub.forEach(d => {
            const cs = csMap[d.id];
            const came = attSet.has(d.id);
            if (came) s.came++;
            if (!cs) { s.notCalled++; return; }
            s.called++;
            if (cs.comingStatus === 'Yes') { s.yes++; came ? s.yesAndCame++ : s.yesNotCame++; }
            else if (cs.callingReason === 'online_class' || cs.comingStatus === 'Shift') { s.online++; }
            else if (cs.callingReason === 'festival_calling') { s.festival++; }
            else if (cs.callingReason === 'not_interested_now') { s.notInterested++; }
          });
        } else {
          // Track how many devotees are in unsubmitted lists — they are effectively
          // unreported and should surface in the "Not Called" count for the team.
          result[team].unsubmittedTotal += sub.length;
        }
        s.isCoordinator = userRoleMap[caller]?.role === 'teamAdmin';
        s.position = s.isCoordinator ? 'Coordinator' : (userRoleMap[caller]?.position || 'Calling Facilitator');
        result[team].callers[caller] = s;
        // Roll up to team — only submitted callers contribute to the stat counts
        if (submitted) STAT_KEYS.forEach(k => { result[team][k] += s[k]; });
      });
    });
    return result;
  },

  async getYesAbsentList(callingDate, sessionDate) {
    // callingDate = Saturday (weekDate in callingStatus docs)
    // sessionDate = Sunday (sessionDate in sessions docs)
    // If sessionDate not provided, derive it as callingDate + 1 day
    if (!sessionDate) {
      const d = new Date(callingDate + 'T00:00:00');
      d.setDate(d.getDate() + 1);
      sessionDate = d.toISOString().slice(0, 10);
    }
    const [all, csSnap, sessSnap] = await Promise.all([
      DevoteeCache.all(),
      fdb.collection('callingStatus').where('weekDate','==',callingDate).where('comingStatus','==','Yes').get(),
      fdb.collection('sessions').where('sessionDate','==',sessionDate).limit(1).get()
    ]);
    const devMap = {};
    all.forEach(d => { devMap[d.id] = d; });
    const yesIds = csSnap.docs.map(d => d.data().devoteeId);
    if (sessSnap.empty || sessSnap.docs[0].data().isCancelled) return { hasSession:false, list:[] };
    const attSnap = await fdb.collection('attendanceRecords').where('sessionId','==',sessSnap.docs[0].id).get();
    const attSet = new Set(attSnap.docs.map(d => d.data().devoteeId));
    const list = yesIds.filter(id => !attSet.has(id)).map(id => {
      const d = devMap[id] || {};
      return { id, name:d.name||'—', teamName:d.teamName||'', callingBy:d.callingBy||'', mobile:d.mobile||'' };
    }).sort((a,b) => (a.teamName||'').localeCompare(b.teamName||'') || a.name.localeCompare(b.name));
    return { hasSession:true, list };
  },

  /* REPORTS */
  async getAttendanceReport(sessionId) {
    return this.getSessionAttendance(sessionId);
  },

  async getTeamsReport(weekDate, sessionId) {
    const teams = TEAMS;
    const raw = await DevoteeCache.all();
    const [csSnap, atSnap] = await Promise.all([
      fdb.collection('callingStatus').where('weekDate', '==', weekDate).get(),
      sessionId ? fdb.collection('attendanceRecords').where('sessionId', '==', sessionId).get() : Promise.resolve({ docs: [] })
    ]);
    const csMap = {};
    csSnap.docs.forEach(d => { csMap[d.data().devoteeId] = d.data(); });
    const presentSet = new Set(atSnap.docs.map(d => d.data().devoteeId));
    return teams.map(team => {
      const td = raw.filter(d => d.teamName === team);
      const callingList = td.filter(d => { const cs = csMap[d.id]; return !cs || !['Shift','Not Interested'].includes(cs.comingStatus); });
      const target = td.filter(d => csMap[d.id]?.comingStatus === 'Yes');
      const actual = td.filter(d => presentSet.has(d.id));
      return { team, total: td.length, callingList: callingList.length, target: target.length, actualPresent: actual.length, percentage: target.length > 0 ? Math.round(actual.length / target.length * 100) : 0 };
    });
  },

  async getCallingMgmtData(currentWeek) {
    const fourWeeksAgo = (() => {
      const d = new Date(currentWeek + 'T00:00:00');
      d.setDate(d.getDate() - 28);
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    })();

    const [allDevotees, csCurrentSnap, csHistorySnap] = await Promise.all([
      DevoteeCache.all(),
      fdb.collection('callingStatus').where('weekDate', '==', currentWeek).get(),
      fdb.collection('callingStatus')
        .where('weekDate', '>=', fourWeeksAgo)
        .where('weekDate', '<=', currentWeek)
        .get(),
    ]);

    const csCurrentMap = {};
    csCurrentSnap.docs.forEach(d => { csCurrentMap[d.data().devoteeId] = d.data(); });

    const csHistoryMap = {};
    csHistorySnap.docs.forEach(d => {
      const { devoteeId, comingStatus, callingReason, weekDate } = d.data();
      if (!csHistoryMap[devoteeId]) csHistoryMap[devoteeId] = [];
      csHistoryMap[devoteeId].push({ comingStatus, callingReason, weekDate });
    });

    const active = allDevotees.filter(d => d.callingBy && !d.isNotInterested);
    return active.map(d => ({
      id: d.id,
      name: d.name,
      mobile: d.mobile || '',
      team_name: d.teamName || '',
      calling_by: d.callingBy || '',
      calling_mode: d.callingMode || '',
      is_not_interested: d.isNotInterested || false,
      is_active: d.isActive !== false,
      lifetime_attendance: d.lifetimeAttendance || 0,
      chanting_rounds: d.chantingRounds || 0,
      current_status: csCurrentMap[d.id]?.comingStatus || null,
      current_reason: csCurrentMap[d.id]?.callingReason || null,
      history: (csHistoryMap[d.id] || [])
        .sort((a, b) => b.weekDate.localeCompare(a.weekDate))
        .slice(0, 4),
    }));
  },

  async getTeamChangeHistory(devoteeId) {
    // Single-field query only — composite index (devoteeId+fieldName+orderBy changedAt)
    // does not exist, so filter and sort in memory instead.
    const snap = await fdb.collection('profileChanges')
      .where('devoteeId', '==', devoteeId)
      .get();
    return snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(d => d.fieldName === 'team_name')
      .sort((a, b) => (b.changedAt?.seconds || 0) - (a.changedAt?.seconds || 0))
      .slice(0, 30);
  },

  async getSeriousReport(weekDate, sessionId) {
    const teams = TEAMS;
    const statuses = ['Expected to be Serious','Serious','Most Serious','New Devotee','Inactive'];
    const raw = await DevoteeCache.all();
    const [csSnap, atSnap] = await Promise.all([
      fdb.collection('callingStatus').where('weekDate', '==', weekDate).get(),
      sessionId ? fdb.collection('attendanceRecords').where('sessionId', '==', sessionId).get() : Promise.resolve({ docs: [] })
    ]);
    const calledYes = new Set(csSnap.docs.filter(d => d.data().comingStatus === 'Yes').map(d => d.data().devoteeId));
    const presentSet = new Set(atSnap.docs.map(d => d.data().devoteeId));
    const data = [];
    teams.forEach(team => statuses.forEach(status => {
      const cohort = raw.filter(d => d.teamName === team && d.devoteeStatus === status);
      data.push({ team, status, promised: cohort.filter(d => calledYes.has(d.id)).length, arrived: cohort.filter(d => presentSet.has(d.id)).length });
    }));
    return data;
  },

  async getTrends(period = 'weekly', team = '') {
    const snap = await fdb.collection('sessions').orderBy('sessionDate', 'asc').limit(24).get();
    const sessions = snap.docs.map(d => ({ id: d.id, sessionDate: d.data().sessionDate }));
    if (!sessions.length) return [];
    const aSnaps = await Promise.all(sessions.map(s => {
      let q = fdb.collection('attendanceRecords').where('sessionId', '==', s.id);
      if (team) q = q.where('teamName', '==', team);
      return q.get();
    }));
    const results = [];
    sessions.forEach((s, i) => {
      const label = period === 'monthly' ? s.sessionDate.slice(0, 7) : s.sessionDate;
      const ex = results.find(r => r.period === label);
      if (ex) ex.count += aSnaps[i].size; else results.push({ period: label, count: aSnaps[i].size });
    });
    return results;
  },

  /* CARE */
  async getCareAbsent(anchorDate) {
    const q = anchorDate
      ? fdb.collection('sessions').where('sessionDate', '<=', anchorDate).orderBy('sessionDate', 'desc').limit(5)
      : fdb.collection('sessions').orderBy('sessionDate', 'desc').limit(5);
    const sSnap = await q.get();
    const sessions = sSnap.docs.map(d => ({ id: d.id }));
    if (sessions.length < 2) return { absentThisWeek: [], absentPast2Weeks: [] };
    const [latest, ...prev] = sessions;
    const raw = await DevoteeCache.all();
    const allIds = sessions.map(s => s.id);
    const attSnaps = await Promise.all(allIds.map(sid => fdb.collection('attendanceRecords').where('sessionId', '==', sid).get()));
    const attMap = {};
    attSnaps.forEach((snap, i) => snap.docs.forEach(d => { const did = d.data().devoteeId; if (!attMap[did]) attMap[did] = new Set(); attMap[did].add(allIds[i]); }));
    const absentThisWeek = [], absentPast2Weeks = [];
    raw.forEach(d => {
      const att = attMap[d.id] || new Set();
      if (att.has(latest.id)) return;
      if (!prev.slice(0, 4).some(s => att.has(s.id))) return;
      (prev.slice(0, 2).every(s => !att.has(s.id)) ? absentPast2Weeks : absentThisWeek).push(toSnake(d));
    });
    return { absentThisWeek, absentPast2Weeks };
  },

  // New devotees who attended the selected session (isNewDevotee flag in attendanceRecords)
  async getNewComersForSession(sessionDate) {
    if (!sessionDate) return [];
    const sSnap = await fdb.collection('sessions').where('sessionDate', '==', sessionDate).limit(1).get();
    if (sSnap.empty) return [];
    const sessionDocId = sSnap.docs[0].id;
    const attSnap = await fdb.collection('attendanceRecords').where('sessionId', '==', sessionDocId).get();
    const newDocs = attSnap.docs.filter(d => d.data().isNewDevotee);
    if (!newDocs.length) return [];
    const newIds = new Set(newDocs.map(d => d.data().devoteeId));
    const markedAtMap = {};
    newDocs.forEach(d => { markedAtMap[d.data().devoteeId] = d.data().markedAt; });
    const raw = await DevoteeCache.all();
    return raw.filter(d => newIds.has(d.id)).map(d => ({ ...toSnake(d), marked_at: markedAtMap[d.id] || null }));
  },

  // All active devotees whose devoteeStatus is still 'New Devotee', with last-8-session attendance matrix
  async getReturningNewComers() {
    const sessSnap = await fdb.collection('sessions').orderBy('sessionDate', 'desc').limit(8).get();
    const sessions = sessSnap.docs.map(d => ({ id: d.id, date: d.data().sessionDate }));
    const all = await DevoteeCache.all();
    const newDevs = all.filter(d => d.isActive !== false && d.devoteeStatus === 'New Devotee');
    if (!newDevs.length || !sessions.length) return { sessions: [], devotees: [] };
    const attSnaps = await Promise.all(
      sessions.map(s => fdb.collection('attendanceRecords').where('sessionId', '==', s.id).get().catch(() => ({ docs: [] })))
    );
    const attMap = {};
    sessions.forEach((s, i) => { attMap[s.id] = new Set(attSnaps[i].docs.map(d => d.data().devoteeId)); });
    const devotees = newDevs.map(d => ({
      ...toSnake(d),
      attendance: sessions.map(s => attMap[s.id]?.has(d.id) ?? false),
    }));
    // Sort by dateOfJoining descending (most recently joined first), then by name
    devotees.sort((a, b) => {
      const aj = a.date_of_joining || '', bj = b.date_of_joining || '';
      if (aj !== bj) return bj.localeCompare(aj);
      return (a.name || '').localeCompare(b.name || '');
    });
    return { sessions, devotees };
  },

  async getCareBirthdays() {
    const raw = await DevoteeCache.all();
    const today = new Date();
    const mds = new Set();
    for (let i = 0; i < 7; i++) {
      const d = new Date(today); d.setDate(today.getDate() + i);
      mds.add(`${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`);
    }
    return raw.filter(d => d.dob && mds.has(d.dob.slice(5))).map(toSnake);
  },

  async getCareInactive() {
    const sSnap = await fdb.collection('sessions').orderBy('sessionDate', 'desc').limit(3).get();
    if (sSnap.size >= 3) {
      const sids = sSnap.docs.map(d => d.id);
      const attSnaps = await Promise.all(sids.map(sid => fdb.collection('attendanceRecords').where('sessionId', '==', sid).get()));
      const attendedSet = new Set();
      attSnaps.forEach(s => s.docs.forEach(d => attendedSet.add(d.data().devoteeId)));
      const raw = await DevoteeCache.all();
      const batch = fdb.batch(); let any = false;
      raw.forEach(d => {
        const should = !attendedSet.has(d.id);
        if (should !== !!d.inactivityFlag) { batch.update(fdb.collection('devotees').doc(d.id), { inactivityFlag: should }); any = true; }
      });
      if (any) { await batch.commit(); DevoteeCache.bust(); }
    }
    const raw = await DevoteeCache.all(true);
    return raw.filter(d => d.inactivityFlag).map(toSnake);
  },

  /* EVENTS */
  async getEvents() {
    const snap = await fdb.collection('events').get();
    return snap.docs.map(d => {
      const dt = d.data();
      return { id: d.id, event_name: dt.eventName, event_date: dt.eventDate || null, description: dt.description || null };
    }).sort((a, b) => (a.event_date || '').localeCompare(b.event_date || ''));
  },

  async createEvent(data) {
    const ref = await fdb.collection('events').add({ eventName: data.event_name.trim(), eventDate: data.event_date || null, description: data.description?.trim() || null, createdAt: TS() });
    return { id: ref.id, event_name: data.event_name, event_date: data.event_date };
  },

  async updateEvent(id, data) {
    await fdb.collection('events').doc(id).update({ eventName: data.event_name.trim(), eventDate: data.event_date || null, description: data.description?.trim() || null });
  },

  async deleteEvent(id) {
    const snap = await fdb.collection('eventDevotees').where('eventId', '==', id).get();
    const batch = fdb.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    batch.delete(fdb.collection('events').doc(id));
    await batch.commit();
  },

  async getEventDevotees(eventId) {
    const snap = await fdb.collection('eventDevotees').where('eventId', '==', eventId).get();
    return snap.docs.map(d => {
      const dt = d.data();
      return { id: d.id, devotee_id: dt.devoteeId, name: dt.devoteeName, mobile: dt.mobile, team_name: dt.teamName };
    }).sort((a, b) => a.name.localeCompare(b.name));
  },

  async addEventDevotee(eventId, devotee) {
    const snap = await fdb.collection('eventDevotees').where('eventId', '==', eventId).where('devoteeId', '==', devotee.id).limit(1).get();
    if (!snap.empty) throw { error: 'Already added' };
    await fdb.collection('eventDevotees').add({ eventId, devoteeId: devotee.id, devoteeName: devotee.name, teamName: devotee.team_name || null, mobile: devotee.mobile || null, addedAt: TS() });
  },

  async removeEventDevotee(eventId, devoteeId) {
    const snap = await fdb.collection('eventDevotees').where('eventId', '==', eventId).where('devoteeId', '==', devoteeId).limit(1).get();
    if (!snap.empty) await snap.docs[0].ref.delete();
  },

  // ── MANAGEMENT / CALLING WEEK HISTORY ─────────────────────────────
  async getCallingWeekHistory(limit = 4) {
    const snap = await fdb.collection('callingWeekHistory')
      .orderBy('callingDate', 'desc').limit(limit).get();
    return snap.docs.map(d => d.data()).reverse();
  },

  async setCallingWeekHistory(callingDate, sessionDate) {
    await fdb.collection('callingWeekHistory').doc(callingDate).set({
      callingDate,
      sessionDate: sessionDate || null,
      updatedAt: TS(),
      updatedBy: AppState.userId || null,
    }, { merge: true });
  },

  async getMgmtGridData(weekEntries) {
    if (!weekEntries.length) return [];
    // Round 1: fire ALL callingStatus queries and ALL session lookups in parallel
    // (previously these were sequential per-week, causing avoidable latency).
    const [csSnaps, sessSnaps] = await Promise.all([
      Promise.all(weekEntries.map(w =>
        fdb.collection('callingStatus').where('weekDate', '==', w.callingDate).get()
      )),
      Promise.all(weekEntries.map(w =>
        w.sessionDate
          ? fdb.collection('sessions').where('sessionDate', '==', w.sessionDate).limit(1).get()
          : Promise.resolve(null)
      )),
    ]);

    // Collect session IDs so we can fetch attendance in one parallel round.
    const sessionIds = sessSnaps.map(snap => (snap && !snap.empty) ? snap.docs[0].id : null);

    // Round 2: fire ALL attendanceRecord queries in parallel.
    const attSnaps = await Promise.all(
      sessionIds.map(sid =>
        sid ? fdb.collection('attendanceRecords').where('sessionId', '==', sid).get() : Promise.resolve(null)
      )
    );

    return weekEntries.map((w, i) => {
      const csMap = {};
      csSnaps[i].docs.forEach(d => { csMap[d.data().devoteeId] = d.data(); });
      const atSet = new Set();
      if (attSnaps[i]) attSnaps[i].docs.forEach(d => atSet.add(d.data().devoteeId));
      return { callingDate: w.callingDate, sessionDate: w.sessionDate, csMap, atSet };
    });
  },

  async getMgmtSeparateLists() {
    const all = await DevoteeCache.all();
    const online = all.filter(d => d.callingMode === 'online');
    const festival = all.filter(d => d.callingMode === 'festival');
    const notInterested = all.filter(d => d.callingMode === 'not_interested' || d.isNotInterested === true);
    return { online, festival, notInterested };
  },

  async setDevoteeCallingMode(devoteeId, mode) {
    // Keep callingBy for 'festival' so they reappear during festival sessions
    const updateData = { callingMode: mode || '', updatedAt: TS() };
    if (mode === 'online' || mode === 'not_interested') updateData.callingBy = '';
    if (mode === 'not_interested') updateData.teamName = '';
    await fdb.collection('devotees').doc(devoteeId).update(updateData);
    await fdb.collection('profileChanges').add({
      devoteeId,
      fieldName: 'calling_mode',
      oldValue: '',
      newValue: mode || '',
      changedAt: TS(),
      changedBy: AppState.userName || '',
    });
    DevoteeCache.bust();
  },

  // ── ATTENDANCE SESSION REPORT (home drawer) ──────────
  // Returns one row per team with calling + attendance stats for a single session.
  async getAttendanceSessionReport(sessionId, callingDate) {
    const [allDevotees, attSnap, csSnap] = await Promise.all([
      DevoteeCache.all(),
      sessionId
        ? fdb.collection('attendanceRecords').where('sessionId', '==', sessionId).get()
        : Promise.resolve({ docs: [] }),
      callingDate
        ? fdb.collection('callingStatus').where('weekDate', '==', callingDate).get()
        : Promise.resolve({ docs: [] }),
    ]);
    const teamMap = {};
    const ensure = t => { if (!teamMap[t]) teamMap[t] = { team: t, total: 0, called: 0, saidComing: new Set(), came: new Set() }; };
    allDevotees.forEach(d => { const t = d.teamName || 'Other'; ensure(t); teamMap[t].total++; });
    const devById = Object.fromEntries(allDevotees.map(d => [d.id, d]));
    csSnap.docs.forEach(d => {
      const dt = d.data();
      const t = devById[dt.devoteeId]?.teamName || dt.teamName || 'Other';
      ensure(t);
      teamMap[t].called++;
      if (dt.comingStatus === 'Yes') teamMap[t].saidComing.add(dt.devoteeId);
    });
    attSnap.docs.forEach(d => {
      const dt = d.data();
      const t = dt.teamName || devById[dt.devoteeId]?.teamName || 'Other';
      ensure(t);
      teamMap[t].came.add(dt.devoteeId);
    });
    return Object.values(teamMap).filter(r => r.total > 0).map(r => ({
      team: r.team,
      total: r.total,
      called: r.called,
      saidComing: r.saidComing.size,
      actuallyCame: r.came.size,
      saidComingNotCame: [...r.saidComing].filter(id => !r.came.has(id)).length,
    })).sort((a, b) => a.team.localeCompare(b.team));
  },

  // ── BOOK DISTRIBUTION ────────────────────────────────
  async addBookDistribution({ devoteeId, devoteeName, teamName, date, quantity }) {
    await fdb.collection('bookDistributions').add({
      devoteeId: devoteeId || '',
      devoteeName: devoteeName || '',
      teamName: teamName || '',
      date: date || localDateStr(new Date()),
      quantity: parseInt(quantity) || 0,
      addedBy: AppState.userName || '',
      createdAt: TS(),
    });
  },

  async getBookDistributions({ startDate, endDate } = {}) {
    let q = fdb.collection('bookDistributions');
    if (startDate) q = q.where('date', '>=', startDate);
    if (endDate)   q = q.where('date', '<=', endDate);
    const snap = await q.get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  },

  // ── DONATION ─────────────────────────────────────────
  async addDonation({ teamName, amount, date, note }) {
    await fdb.collection('donations').add({
      teamName: teamName || '',
      amount: parseFloat(amount) || 0,
      date: date || localDateStr(new Date()),
      note: note || '',
      addedBy: AppState.userName || '',
      createdAt: TS(),
    });
  },

  async getDonations({ startDate, endDate } = {}) {
    let q = fdb.collection('donations');
    if (startDate) q = q.where('date', '>=', startDate);
    if (endDate)   q = q.where('date', '<=', endDate);
    const snap = await q.get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  },

  // ── REGISTRATION ─────────────────────────────────────
  async addRegistration({ devoteeId, devoteeName, teamName, date, count }) {
    await fdb.collection('registrations').add({
      devoteeId: devoteeId || '',
      devoteeName: devoteeName || '',
      teamName: teamName || '',
      date: date || localDateStr(new Date()),
      count: parseInt(count) || 0,
      addedBy: AppState.userName || '',
      createdAt: TS(),
    });
  },

  async getRegistrations({ startDate, endDate } = {}) {
    let q = fdb.collection('registrations');
    if (startDate) q = q.where('date', '>=', startDate);
    if (endDate)   q = q.where('date', '<=', endDate);
    const snap = await q.get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  },

  // ── SERVICE ──────────────────────────────────────────
  async addService({ devoteeId, devoteeName, teamName, date, serviceDescription }) {
    await fdb.collection('services').add({
      devoteeId: devoteeId || '',
      devoteeName: devoteeName || '',
      teamName: teamName || '',
      date: date || localDateStr(new Date()),
      serviceDescription: serviceDescription || '',
      addedBy: AppState.userName || '',
      createdAt: TS(),
    });
  },

  async getServices({ startDate, endDate } = {}) {
    let q = fdb.collection('services');
    if (startDate) q = q.where('date', '>=', startDate);
    if (endDate)   q = q.where('date', '<=', endDate);
    const snap = await q.get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  },
};
