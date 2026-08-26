/* ══════════════════════════════════════════════════════════════
   UroLink 연차관리 — 애플리케이션 로직
   저장소: localStorage(config 비어있을 때, 테스트용) 또는 Supabase(연차 전용 별도 프로젝트).
   ══════════════════════════════════════════════════════════════ */

/* ───────────────────────── 1. 상수 ───────────────────────── */
const LS_KEY = 'urolink_leave_v1';
/* 배포 버전 — index.html 의 ?v= 값과 version.json 과 반드시 동일하게 유지 */
const APP_VERSION = '20260826a';

const LEAVE_TYPES = { '연차': 1, '오전반차': 0.5, '오후반차': 0.5 };
const HALF_TYPES = ['오전반차', '오후반차'];

/* ───────────────────────── 2. 유틸 ───────────────────────── */
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const num = v => { const n = Number(String(v == null ? '' : v).replace(/[^\d.-]/g, '')); return isFinite(n) ? n : 0; };
function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function today() { return ymd(new Date()); }
function parseD(s) { if (!s) return null; const p = String(s).slice(0, 10).split('-'); const d = new Date(+p[0], +p[1] - 1, +p[2]); return isNaN(d) ? null : d; }
function fmtDate(s) { return s ? String(s).slice(0, 10).replace(/-/g, '.') : '-'; }
function addYearsD(d, n) { const r = new Date(d); r.setFullYear(r.getFullYear() + n); return r; }
function toast(msg) {
  $('toast-msg').textContent = msg || '저장되었습니다';
  const t = $('toast'); t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 1800);
}

/* ───────────────────────── 3. 연차 계산 (근로기준법 60조 기준 추정치)
   - 입사 1년 미만: 개근한 달마다 1일(최대 11일)
   - 입사 1년 이상: 15일 + (근속연수-1)/2 마다 1일 가산, 최대 25일
   - 관리자가 직원 관리에서 수동조정(이월·차감)을 더할 수 있음
   - 연차 사용연도는 "입사일 기준"(입사기념일~다음 입사기념일 전날)으로 계산 ─────── */
function yearsBetween(hire, ref) {
  let y = ref.getFullYear() - hire.getFullYear();
  const anniv = new Date(ref.getFullYear(), hire.getMonth(), hire.getDate());
  if (anniv > ref) y--;
  return y;
}
function monthsBetween(hire, ref) {
  let m = (ref.getFullYear() - hire.getFullYear()) * 12 + (ref.getMonth() - hire.getMonth());
  if (ref.getDate() < hire.getDate()) m--;
  return Math.max(0, m);
}
function leaveYearStart(hireDate, ref) {
  const hire = parseD(hireDate); if (!hire) return null;
  ref = ref || parseD(today());
  let anniv = new Date(ref.getFullYear(), hire.getMonth(), hire.getDate());
  if (anniv > ref) anniv.setFullYear(anniv.getFullYear() - 1);
  return anniv;
}
function grantedDays(hireDate, ref) {
  const hire = parseD(hireDate); if (!hire) return 0;
  ref = ref || parseD(today());
  const years = yearsBetween(hire, ref);
  if (years < 1) return Math.min(11, monthsBetween(hire, ref));
  return Math.min(25, 15 + Math.floor((years - 1) / 2));
}
function usedDays(profileId, hireDate, ref) {
  const start = leaveYearStart(hireDate, ref); if (!start) return 0;
  const end = addYearsD(start, 1);
  return (DB.leaves || []).filter(l => l.requesterId === profileId && l.status === '승인'
    && parseD(l.startDate) >= start && parseD(l.startDate) < end)
    .reduce((s, l) => s + num(l.days), 0);
}
function remainingDays(p) {
  if (!p || !p.hire_date) return null;
  return grantedDays(p.hire_date) + num(p.adjust_days) - usedDays(p.id, p.hire_date);
}

/* ───────────────────────── 4. 데이터 계층 ───────────────────────── */
let DB = null;
const CFG = window.UROLINK_CONFIG || {};
let SB = null, ME = null, MODE = 'local', SHADOW = {}, SYNCING = 0;
let PROFILES = [];   // 팀원 프로필 목록 (remote: ul_profiles / local: DB.employees)

const isRemote = () => MODE === 'remote';
const isAdmin = () => !!(ME && ME.role === 'admin');
const clone = o => JSON.parse(JSON.stringify(o));

function blankDB() { return { leaves: [], employees: [], meta: { ver: 1 } }; }
function fixShape() {
  const b = blankDB();
  Object.keys(b).forEach(k => { if (DB[k] == null) DB[k] = b[k]; });
}

function loadLocal() {
  try { const raw = localStorage.getItem(LS_KEY); DB = raw ? JSON.parse(raw) : null; }
  catch (e) { DB = null; }
  if (!DB || typeof DB !== 'object') {
    DB = blankDB();
    ME = { id: 'me', email: 'test@urolink.co.kr', display_name: '테스트관리자', role: 'admin',
           hire_date: '2022-03-02', adjust_days: 0, active: true };
    DB.employees = [ME];
    save(true);
  }
  fixShape();
  PROFILES = DB.employees;
  if (!ME) ME = PROFILES[0];
}

function save(silent) {
  try { localStorage.setItem(isRemote() ? LS_KEY + '_cache' : LS_KEY, JSON.stringify(DB)); } catch (e) {}
  if (isRemote()) pushDiff(silent);
  else if (!silent) toast();
}

function syncing(on) {
  SYNCING = Math.max(0, SYNCING + (on ? 1 : -1));
  const badge = $('sync-badge'), text = $('sync-badge-text');
  if (!badge || !text) return;
  clearTimeout(syncing._t);
  if (SYNCING) { badge.classList.add('show', 'syncing'); badge.classList.remove('done'); text.textContent = '서버 동기화 중...'; }
  else badge.classList.remove('show', 'done', 'syncing');
}
function syncOk() {
  const badge = $('sync-badge'), text = $('sync-badge-text');
  if (!badge || !text) return;
  clearTimeout(syncing._t);
  badge.classList.add('show', 'done'); badge.classList.remove('syncing');
  text.textContent = '저장됨';
  syncing._t = setTimeout(() => badge.classList.remove('show', 'done'), 1200);
}

async function pushDiff(silent) {
  if (!SB) return;
  const cur = DB.leaves || [], prev = SHADOW.leaves || [];
  const curMap = new Map(), prevMap = new Map();
  cur.forEach(r => curMap.set(r.id, r));
  prev.forEach(r => prevMap.set(r.id, r));
  const ups = [], dels = [];
  curMap.forEach((row, k) => {
    const p = prevMap.get(k);
    if (!p || JSON.stringify(p) !== JSON.stringify(row)) ups.push({ id: k, data: row });
  });
  prevMap.forEach((_, k) => { if (!curMap.has(k)) dels.push(k); });
  if (!ups.length && !dels.length) { if (!silent) toast('변경된 내용이 없습니다'); return; }

  syncing(true);
  const ops = [];
  if (ups.length) ops.push(SB.from('ul_leaves').upsert(ups));
  if (dels.length) ops.push(SB.from('ul_leaves').delete().in('id', dels));
  let res;
  try { res = await Promise.all(ops); }
  catch (e) { syncing(false); toast('네트워크 오류 — 서버에 저장하지 못했습니다'); console.error(e); return; }
  syncing(false);
  const bad = res.find(r => r && r.error);
  if (bad) {
    const m = String(bad.error.message || '');
    toast(/row-level security|permission|policy/i.test(m) ? '권한이 없어 저장하지 못했습니다' : '저장 실패: ' + m);
    console.error(bad.error);
    return;
  }
  SHADOW = clone(DB);
  if (!silent) syncOk();
}

async function pullRemote() {
  const [lv, pf] = await Promise.all([
    SB.from('ul_leaves').select('id,data'),
    SB.from('ul_profiles').select('id,email,display_name,role,hire_date,adjust_days,active').order('display_name')
  ]);
  if (lv.error) { toast('데이터를 불러오지 못했습니다: ' + lv.error.message); DB = blankDB(); }
  else DB = { leaves: (lv.data || []).map(r => Object.assign({ id: r.id }, r.data)), employees: [], meta: { ver: 1 } };
  if (!pf.error) PROFILES = pf.data || [];
  SHADOW = clone(DB);
}

/* ───────────────────────── 5. 인증 ───────────────────────── */
function showLogin() { document.body.classList.add('locked'); $('login-screen').classList.add('on'); setTimeout(() => $('lg-email').focus(), 100); }
function hideLogin() { document.body.classList.remove('locked'); $('login-screen').classList.remove('on'); }
function lgMsg(m) { $('lg-msg').textContent = m || ''; }

async function doLogin() {
  const email = $('lg-email').value.trim(), pw = $('lg-pw').value;
  if (!email || !pw) return lgMsg('이메일과 비밀번호를 입력해주세요.');
  $('lg-btn').disabled = true; lgMsg('로그인 중...');
  const { data, error } = await SB.auth.signInWithPassword({ email, password: pw });
  $('lg-btn').disabled = false;
  if (error) {
    const m = String(error.message || '');
    return lgMsg(/invalid login|invalid credentials/i.test(m) ? '이메일 또는 비밀번호가 올바르지 않습니다.'
      : /not confirmed/i.test(m) ? '이메일 확인이 완료되지 않은 계정입니다. 관리자에게 문의하세요.' : m);
  }
  lgMsg('');
  await afterLogin(data.session);
}

async function afterLogin(session) {
  const { data: p } = await SB.from('ul_profiles')
    .select('id,email,display_name,role,hire_date,adjust_days,active').eq('id', session.user.id).maybeSingle();
  ME = p || { id: session.user.id, email: session.user.email,
              display_name: String(session.user.email || '').split('@')[0], role: 'user', adjust_days: 0, active: true };
  if (p && p.active === false) {
    await SB.auth.signOut(); ME = null; showLogin();
    lgMsg('접속이 차단된 계정입니다. 관리자에게 문의해주세요.');
    return;
  }
  hideLogin();
  await pullRemote();
  startApp();
}

async function doLogout() {
  if (!confirm('로그아웃할까요?')) return;
  try { await SB.auth.signOut(); } catch (e) {}
  location.reload();
}

/* ───────────────────────── 6. 라우팅 ───────────────────────── */
const PAGES = ['dashboard', 'apply', 'calendar', 'approvals', 'employees'];
function showPage(p) {
  if (!PAGES.includes(p)) p = 'dashboard';
  if ((p === 'approvals' || p === 'employees') && !isAdmin()) p = 'dashboard';
  PAGES.forEach(x => { $('page-' + x).classList.toggle('active', x === p); });
  document.querySelectorAll('.nav-link[data-page]').forEach(el => el.classList.toggle('active', el.dataset.page === p));
  if (p === 'dashboard') renderDashboard();
  if (p === 'apply') renderMyLeaves();
  if (p === 'calendar') renderCalendar();
  if (p === 'approvals') renderApprovals();
  if (p === 'employees') renderEmployees();
  location.hash = p;
}

function startApp() {
  $('nav-approvals').style.display = isAdmin() ? '' : 'none';
  $('nav-employees').style.display = isAdmin() ? '' : 'none';
  $('account-box').innerHTML = `<b>${esc(ME.display_name || ME.email)}</b>${isAdmin() ? ' <span class="badge-admin">관리자</span>' : ''}`;
  const p = location.hash.replace('#', '');
  showPage(PAGES.includes(p) ? p : 'dashboard');
  checkVersion();
}

/* ───────────────────────── 7. 대시보드 ───────────────────────── */
function renderDashboard() {
  const granted = grantedDays(ME.hire_date), used = usedDays(ME.id, ME.hire_date), adjust = num(ME.adjust_days);
  const remain = ME.hire_date ? (granted + adjust - used) : null;
  $('dash-band').innerHTML = `
    <div class="wt-hero">
      <div class="l">내 올해 잔여 연차</div>
      <b>${remain == null ? '-' : remain}</b>
      <div class="s">입사일 미등록이면 관리자에게 요청해주세요</div>
    </div>
    <div class="wt-fact"><div class="l">발생</div><b>${granted}</b><div class="s">일</div></div>
    <div class="wt-fact"><div class="l">사용</div><b>${used}</b><div class="s">일</div></div>
    <div class="wt-fact"><div class="l">수동조정</div><b class="${adjust < 0 ? 'rd' : ''}">${adjust >= 0 ? '+' : ''}${adjust}</b><div class="s">일</div></div>
    <div class="wt-fact"><div class="l">대기중 신청</div><b>${(DB.leaves || []).filter(l => l.requesterId === ME.id && l.status === '대기').length}</b><div class="s">건</div></div>
  `;
  const now = new Date(), ms = pad(now.getMonth() + 1);
  const monthLeaves = (DB.leaves || []).filter(l => l.status === '승인' && String(l.startDate).slice(0, 7) === now.getFullYear() + '-' + ms)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  $('dash-month-list').innerHTML = monthLeaves.length ? monthLeaves.map(l =>
    `<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border);font-size:13px">
       <span>${esc(l.requesterName)} · ${esc(l.type)}</span>
       <span style="color:#64748b">${fmtDate(l.startDate)}${l.endDate !== l.startDate ? ' ~ ' + fmtDate(l.endDate) : ''}</span>
     </div>`).join('') : '<div class="empty-ul">이번 달 승인된 휴가가 없습니다</div>';
}

/* ───────────────────────── 8. 연차 신청 ───────────────────────── */
function openApplyModal() {
  $('ap-type').value = '연차';
  $('ap-start').value = today();
  $('ap-end').value = today();
  $('ap-reason').value = '';
  applyTypeChange();
  new bootstrap.Modal($('modal-apply')).show();
}
function applyTypeChange() {
  const half = HALF_TYPES.includes($('ap-type').value);
  $('ap-end-wrap').style.display = half ? 'none' : '';
  if (half) $('ap-end').value = $('ap-start').value;
  applyDaysRecalc();
}
function countWeekdays(s, e) {
  const a = parseD(s), b = parseD(e); if (!a || !b || b < a) return 0;
  let n = 0, d = new Date(a);
  while (d <= b) { const wd = d.getDay(); if (wd !== 0 && wd !== 6) n++; d.setDate(d.getDate() + 1); }
  return n;
}
function applyDaysRecalc() {
  const type = $('ap-type').value, s = $('ap-start').value;
  const half = HALF_TYPES.includes(type);
  const e = half ? s : $('ap-end').value;
  const days = half ? (s ? 0.5 : 0) : countWeekdays(s, e);
  $('ap-days-view').textContent = days;
  const remain = ME.hire_date ? remainingDays(ME) : null;
  $('ap-remain-view').textContent = remain == null ? '-' : remain;
}
function submitApply() {
  const type = $('ap-type').value, start = $('ap-start').value;
  const half = HALF_TYPES.includes(type);
  const end = half ? start : $('ap-end').value;
  if (!start || !end) return alert('날짜를 입력해주세요.');
  if (end < start) return alert('종료일이 시작일보다 빠를 수 없습니다.');
  const days = half ? 0.5 : countWeekdays(start, end);
  if (days <= 0) return alert('평일이 포함된 기간을 선택해주세요.');
  DB.leaves = DB.leaves || [];
  DB.leaves.push({
    id: uid(), requesterId: ME.id, requesterName: ME.display_name || ME.email,
    type, startDate: start, endDate: end, days,
    reason: $('ap-reason').value.trim(), status: '대기',
    decidedBy: '', decidedAt: '', rejectReason: '', createdAt: new Date().toISOString()
  });
  save();
  bootstrap.Modal.getInstance($('modal-apply')).hide();
  renderMyLeaves();
  toast('신청되었습니다');
}
function renderMyLeaves() {
  const rows = (DB.leaves || []).filter(l => l.requesterId === ME.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  $('my-leaves-body').innerHTML = rows.length ? rows.map(l => `
    <tr>
      <td>${esc(l.type)}</td>
      <td>${fmtDate(l.startDate)}${l.endDate !== l.startDate ? ' ~ ' + fmtDate(l.endDate) : ''}</td>
      <td>${l.days}일</td>
      <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(l.reason || '-')}</td>
      <td>${stBadge(l.status)}${l.status === '반려' && l.rejectReason ? `<div style="font-size:11px;color:#94a3b8;margin-top:2px">${esc(l.rejectReason)}</div>` : ''}</td>
      <td>${l.status === '대기' ? `<button class="btn btn-sm btn-outline-danger" onclick="cancelLeave('${l.id}')">취소</button>` : ''}</td>
    </tr>`).join('') : `<tr><td colspan="6" class="empty-ul">신청 내역이 없습니다</td></tr>`;
}
function stBadge(s) {
  const cls = s === '승인' ? 'ok' : s === '반려' ? 'no' : 'wait';
  return `<span class="badge-st ${cls}">${esc(s)}</span>`;
}
function cancelLeave(id) {
  const row = (DB.leaves || []).find(l => l.id === id);
  if (!row || row.status !== '대기') return;
  if (!confirm('이 신청을 취소할까요?')) return;
  DB.leaves = DB.leaves.filter(l => l.id !== id);
  save();
  renderMyLeaves(); renderDashboard();
}

/* ───────────────────────── 9. 팀 캘린더 ───────────────────────── */
let CAL_Y = new Date().getFullYear(), CAL_M = new Date().getMonth();
function calMove(d) {
  CAL_M += d;
  if (CAL_M < 0) { CAL_M = 11; CAL_Y--; } else if (CAL_M > 11) { CAL_M = 0; CAL_Y++; }
  renderCalendar();
}
function renderCalendar() {
  $('cal-title').textContent = `${CAL_Y}년 ${CAL_M + 1}월`;
  $('cal-dow').innerHTML = ['일', '월', '화', '수', '목', '금', '토'].map(d => `<div class="cal-dow">${d}</div>`).join('');
  const first = new Date(CAL_Y, CAL_M, 1), startDow = first.getDay();
  const daysInMonth = new Date(CAL_Y, CAL_M + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  const approved = (DB.leaves || []).filter(l => l.status === '승인');
  const tday = today();
  $('cal-grid').innerHTML = cells.map(d => {
    if (!d) return `<div class="cal-cell other"></div>`;
    const dateStr = `${CAL_Y}-${pad(CAL_M + 1)}-${pad(d)}`;
    const hits = approved.filter(l => dateStr >= l.startDate && dateStr <= l.endDate);
    return `<div class="cal-cell${dateStr === tday ? ' today' : ''}">
      <div class="d">${d}</div>
      ${hits.map(l => `<span class="cal-tag" title="${esc(l.requesterName)} ${esc(l.type)}">${esc(l.requesterName)}${HALF_TYPES.includes(l.type) ? '(' + esc(l.type[2]) + ')' : ''}</span>`).join('')}
    </div>`;
  }).join('');
}

/* ───────────────────────── 10. 승인 관리 ───────────────────────── */
function renderApprovals() {
  const pending = (DB.leaves || []).filter(l => l.status === '대기').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  $('pending-body').innerHTML = pending.length ? pending.map(l => `
    <tr>
      <td>${esc(l.requesterName)}</td>
      <td>${esc(l.type)}</td>
      <td>${fmtDate(l.startDate)}${l.endDate !== l.startDate ? ' ~ ' + fmtDate(l.endDate) : ''}</td>
      <td>${l.days}일</td>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(l.reason || '-')}</td>
      <td>${fmtDate(l.createdAt)}</td>
      <td>
        <button class="btn btn-sm btn-success" onclick="decideLeave('${l.id}','승인')">승인</button>
        <button class="btn btn-sm btn-outline-danger" onclick="decideLeave('${l.id}','반려')">반려</button>
      </td>
    </tr>`).join('') : `<tr><td colspan="7" class="empty-ul">대기중인 신청이 없습니다</td></tr>`;

  const decided = (DB.leaves || []).filter(l => l.status !== '대기').sort((a, b) => (b.decidedAt || '').localeCompare(a.decidedAt || '')).slice(0, 50);
  $('decided-body').innerHTML = decided.length ? decided.map(l => `
    <tr>
      <td>${esc(l.requesterName)}</td>
      <td>${esc(l.type)}</td>
      <td>${fmtDate(l.startDate)}${l.endDate !== l.startDate ? ' ~ ' + fmtDate(l.endDate) : ''}</td>
      <td>${l.days}일</td>
      <td>${stBadge(l.status)}</td>
      <td>${esc(l.decidedBy || '-')}</td>
      <td>${fmtDate(l.decidedAt)}</td>
    </tr>`).join('') : `<tr><td colspan="7" class="empty-ul">처리 이력이 없습니다</td></tr>`;
}
function decideLeave(id, decision) {
  if (!isAdmin()) return;
  const row = (DB.leaves || []).find(l => l.id === id);
  if (!row) return;
  let reason = '';
  if (decision === '반려') {
    reason = prompt('반려 사유를 입력해주세요(선택):') || '';
  }
  row.status = decision; row.decidedBy = ME.display_name || ME.email;
  row.decidedAt = new Date().toISOString(); row.rejectReason = reason;
  save();
  renderApprovals(); renderDashboard();
}

/* ───────────────────────── 11. 직원 관리 ───────────────────────── */
function renderEmployees() {
  const rows = (PROFILES || []).slice().sort((a, b) => String(a.display_name || '').localeCompare(String(b.display_name || '')));
  $('emp-body').innerHTML = rows.length ? rows.map(p => {
    const remain = p.hire_date ? remainingDays(p) : null;
    return `<tr>
      <td>${esc(p.display_name || '-')}</td>
      <td>${esc(p.email || '-')}</td>
      <td>${p.role === 'admin' ? '<span class="badge-admin">관리자</span>' : '일반'}</td>
      <td>${p.hire_date ? fmtDate(p.hire_date) : '<span style="color:#cbd5e1">미등록</span>'}</td>
      <td>${remain == null ? '-' : remain + '일'}</td>
      <td>${num(p.adjust_days) >= 0 ? '+' : ''}${num(p.adjust_days)}</td>
      <td>${p.active === false ? '<span class="badge-st no">차단</span>' : '<span class="badge-st ok">활성</span>'}</td>
      <td><button class="btn btn-sm btn-outline-secondary" onclick="openEmpModal('${p.id}')"><i class="bi bi-pencil"></i></button></td>
    </tr>`;
  }).join('') : `<tr><td colspan="8" class="empty-ul">직원이 없습니다</td></tr>`;
}
function openEmpModal(id) {
  const p = PROFILES.find(x => x.id === id); if (!p) return;
  $('em-id').value = p.id;
  $('em-name').textContent = p.display_name || p.email;
  $('em-hire').value = p.hire_date || '';
  $('em-adjust').value = num(p.adjust_days);
  $('em-role').value = p.role === 'admin' ? 'admin' : 'user';
  $('em-active').checked = p.active !== false;
  new bootstrap.Modal($('modal-emp')).show();
}
async function saveEmp() {
  const id = $('em-id').value;
  const patch = {
    hire_date: $('em-hire').value || null,
    adjust_days: num($('em-adjust').value),
    role: $('em-role').value,
    active: $('em-active').checked
  };
  if (isRemote()) {
    syncing(true);
    const { error } = await SB.from('ul_profiles').update(patch).eq('id', id);
    syncing(false);
    if (error) { toast('저장 실패: ' + error.message); return; }
    Object.assign(PROFILES.find(p => p.id === id), patch);
  } else {
    Object.assign(PROFILES.find(p => p.id === id), patch);
    save(true);
  }
  bootstrap.Modal.getInstance($('modal-emp')).hide();
  renderEmployees();
  toast('저장되었습니다');
}

/* ───────────────────────── 12. 자동 최신화 ───────────────────────── */
async function checkVersion() {
  if (location.protocol === 'file:') return;
  try {
    const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    if (!j || !j.version || j.version === APP_VERSION) return;
    $('update-bar').classList.add('on');
  } catch (e) {}
}
function applyUpdate() { location.reload(); }
setInterval(checkVersion, 10 * 60 * 1000);

/* ───────────────────────── 13. 부팅 ───────────────────────── */
(async function boot() {
  const hasCfg = CFG.SUPABASE_URL && CFG.SUPABASE_KEY;
  if (hasCfg && window.supabase) {
    MODE = 'remote';
    SB = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY);
    let session = null;
    try { session = (await SB.auth.getSession()).data.session; } catch (e) {}
    if (!session) { showLogin(); return; }
    await afterLogin(session);
    return;
  }
  if (hasCfg && !window.supabase) {
    alert('Supabase 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인해주세요.\n우선 테스트 모드로 실행합니다.');
  }
  MODE = 'local';
  loadLocal();
  startApp();
})();
