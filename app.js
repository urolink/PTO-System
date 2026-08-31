/* ══════════════════════════════════════════════════════════════
   UroLink 연차관리 — 애플리케이션 로직
   저장소: localStorage(config 비어있을 때, 테스트용) 또는 Supabase(연차 전용 별도 프로젝트).
   ══════════════════════════════════════════════════════════════ */

/* ───────────────────────── 1. 상수 ───────────────────────── */
const LS_KEY = 'urolink_leave_v1';
/* 배포 버전 — index.html 의 ?v= 값과 version.json 과 반드시 동일하게 유지 */
const APP_VERSION = '20260831k';

const HALF_TYPES = ['오전반차', '오후반차'];
/* 경조사는 연차와 별도 휴가라 잔여 연차에서 차감하지 않는다 */
const DEDUCT_TYPES = ['연차', '오전반차', '오후반차'];

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
  return (DB.leaves || []).filter(l => l.requesterId === profileId && l.status === '승인' && DEDUCT_TYPES.includes(l.type)
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
    ME = { id: 'me', email: 'test@urolink.co.kr', display_name: '테스트관리자', department: '영업팀', job_title: '대리', phone: '010-0000-0000', role: 'admin',
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
    SB.from('ul_profiles').select('id,email,display_name,department,job_title,phone,role,hire_date,adjust_days,active').order('display_name')
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
    .select('id,email,display_name,department,job_title,phone,role,hire_date,adjust_days,active').eq('id', session.user.id).maybeSingle();
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
function accountBoxHtml() {
  return `<b>${esc(ME.display_name || ME.email)}</b>${isAdmin() ? ' <span class="badge-admin">관리자</span>' : ''}`;
}

/* ── 비밀번호 변경 (본인) ── */
function openPwModal() {
  if (!isRemote()) { alert('테스트 모드에서는 비밀번호 변경을 쓸 수 없습니다.'); return; }
  $('pw-new').value = ''; $('pw-confirm').value = ''; $('pw-msg').textContent = '';
  new bootstrap.Modal($('modal-pw')).show();
}
async function changePassword() {
  const pw = $('pw-new').value, pw2 = $('pw-confirm').value;
  if (pw.length < 6) return $('pw-msg').textContent = '비밀번호는 6자 이상이어야 합니다.';
  if (pw !== pw2) return $('pw-msg').textContent = '비밀번호가 서로 일치하지 않습니다.';
  $('pw-msg').textContent = '변경 중...';
  const { error } = await SB.auth.updateUser({ password: pw });
  if (error) { $('pw-msg').textContent = error.message; return; }
  bootstrap.Modal.getInstance($('modal-pw')).hide();
  toast('비밀번호가 변경되었습니다');
}

/* ── 알림 메일 (send-mail Edge Function 필요 — 없거나 실패해도 조용히 무시) ──
   메일 발송은 사용자 조작을 막으면 안 되는 부가 기능이라 항상 try/catch 로 감싸고,
   실패해도 화면에는 알리지 않는다(콘솔에만 남김). */
async function sendMail(to, subject, html) {
  if (!isRemote() || !SB || !to.length) return;
  try {
    const { error } = await SB.functions.invoke('send-mail', { body: { to, subject, html } });
    if (error) console.warn('[메일 발송 실패]', error);
  } catch (e) { console.warn('[메일 발송 실패]', e); }
}
function appLink() { return location.origin + location.pathname; }
function notifyCeoOfSubmission(l) {
  const ceos = (PROFILES || []).filter(p => p.job_title === '대표이사' && p.email && p.active !== false).map(p => p.email);
  if (!ceos.length) return;
  const html = `<p>${esc(l.requesterName)}${l.requesterDept ? ' (' + esc(l.requesterDept) + ')' : ''}님이 휴가를 신청했습니다.</p>
    <p>구분: ${esc(l.type)}<br>기간: ${fmtDate(l.startDate)}${l.endDate !== l.startDate ? ' ~ ' + fmtDate(l.endDate) : ''} (${l.days}일)<br>사유: ${esc(l.reason || '-')}</p>
    <p><a href="${esc(appLink())}">연차관리 시스템에서 확인하기</a></p>`;
  sendMail(ceos, `[연차신청] ${l.requesterName} · ${l.type} 승인 요청`, html);
}
function notifyRequesterOfDecision(l) {
  const p = (PROFILES || []).find(x => x.id === l.requesterId);
  if (!p || !p.email) return;
  const ok = l.status === '승인';
  const html = `<p>신청하신 휴가가 <b>${ok ? '승인' : '반려'}</b>되었습니다.</p>
    <p>구분: ${esc(l.type)}<br>기간: ${fmtDate(l.startDate)}${l.endDate !== l.startDate ? ' ~ ' + fmtDate(l.endDate) : ''} (${l.days}일)<br>처리자: ${esc(l.decidedBy || '-')}</p>
    ${!ok && l.rejectReason ? `<p>반려 사유: ${esc(l.rejectReason)}</p>` : ''}
    <p><a href="${esc(appLink())}">연차관리 시스템에서 확인하기</a></p>`;
  sendMail([p.email], `[연차${ok ? '승인' : '반려'}] ${l.type} ${fmtDate(l.startDate)}`, html);
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
  $('account-box').innerHTML = accountBoxHtml();
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
       <span>${l.requesterDept ? esc(l.requesterDept) + ' · ' : ''}${esc(l.requesterName)}${l.requesterTitle ? ' ' + esc(l.requesterTitle) : ''} · ${esc(l.type)}</span>
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
  const createdAt = new Date().toISOString();
  const newLeave = {
    id: uid(), docNo: genDocNo(createdAt),
    requesterId: ME.id, requesterName: ME.display_name || ME.email, requesterDept: ME.department || '', requesterTitle: ME.job_title || '', requesterPhone: ME.phone || '',
    type, startDate: start, endDate: end, days,
    reason: $('ap-reason').value.trim(), status: '대기',
    decidedBy: '', decidedTitle: '', decidedAt: '', rejectReason: '', createdAt
  };
  DB.leaves.push(newLeave);
  save();
  notifyCeoOfSubmission(newLeave);
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
      <td style="white-space:nowrap">
        <button class="btn btn-sm btn-outline-secondary" onclick="openLeaveForm('${l.id}')" title="신청서 보기/인쇄"><i class="bi bi-printer"></i></button>
        ${l.status === '대기' ? `<button class="btn btn-sm btn-outline-danger" onclick="cancelLeave('${l.id}')">취소</button>` : ''}
      </td>
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

/* ───────────────────────── 8-1. 연차 신청서 (회사 공식 양식, 인쇄 / PDF 저장) ─────────────────────────
   별도 다운로드 라이브러리 없이, 새 창에 인쇄용 문서를 그려서
   브라우저 인쇄 대화상자의 "PDF로 저장"을 파일 다운로드로 쓴다.
   문서번호 형식: PTO + 신청일(YYYYMMDD) + '-' + 그 날짜의 신청 순번(2자리). */
function genDocNo(createdAtIso) {
  const d = String(createdAtIso).slice(0, 10).replace(/-/g, '');
  const prefix = 'PTO' + d + '-';
  const n = (DB.leaves || []).filter(x => String(x.docNo || '').startsWith(prefix)).length + 1;
  return prefix + pad(n, 2);
}
function leaveFormHtml(l) {
  const p = (PROFILES || []).find(x => x.id === l.requesterId) || {};
  const decided = l.status !== '대기';
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<title>휴가신청서 - ${esc(l.docNo || '')}</title>
<script src="https://cdn.jsdelivr.net/npm/html2pdf.js@0.10.1/dist/html2pdf.bundle.min.js"><\/script>
<style>
  body{font-family:'Malgun Gothic','Noto Sans KR',sans-serif;color:#111;max-width:720px;margin:0 auto;padding:36px 30px 50px}
  .toolbar{text-align:center;margin-bottom:26px;display:flex;gap:8px;justify-content:center}
  .toolbar button{padding:9px 20px;font-size:13px;font-weight:700;border:1px solid #0e7490;background:#0e7490;color:#fff;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
  .toolbar button.dl{background:#fff;color:#0e7490}
  .brandmark{text-align:right;font-size:15px;font-weight:800;letter-spacing:-.4px;margin-bottom:14px}
  .brandmark .a{color:#0B1220}.brandmark .b{color:#42A5F5}
  .doc-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:22px}
  .doc-title{font-size:27px;font-weight:800;letter-spacing:6px;padding-top:10px}
  .appr{border:1px solid #333;display:flex}
  .appr .lb{writing-mode:vertical-rl;padding:4px 3px;border-right:1px solid #333;font-weight:700;font-size:12.5px;letter-spacing:3px;display:flex;align-items:center;justify-content:center}
  .appr .slot{width:96px;display:flex;flex-direction:column}
  .appr .role{height:30px;border-bottom:1px solid #333;font-size:12px;text-align:center;display:flex;align-items:center;justify-content:center}
  .appr .sign{height:56px;font-size:13.5px;font-weight:700;text-align:center;display:flex;align-items:center;justify-content:center}
  table.frm{width:100%;border-collapse:collapse}
  table.frm th, table.frm td{border:1px solid #333;padding:9px 12px;font-size:13.5px}
  table.frm th{background:#f4f5f7;font-weight:700;text-align:center;white-space:nowrap}
  .reason{min-height:90px;white-space:pre-wrap;text-align:left;vertical-align:top}
  .statement{text-align:center;margin:28px 0 22px;font-size:14px}
  .dateline{text-align:center;font-size:14px;margin-bottom:26px;letter-spacing:3px}
  .company{text-align:center;font-size:17px;font-weight:800;letter-spacing:3px}
  @media print{ .toolbar{display:none} body{padding:0} }
</style></head><body>
<div class="toolbar">
  <button onclick="window.print()"><i>🖨</i> 인쇄</button>
  <button class="dl" onclick="downloadPdf()"><i>⬇</i> 다운로드(PDF)</button>
</div>
<div id="doc-body">
<div class="brandmark"><span class="a">Uro</span><span class="b">LinK</span></div>
<div class="doc-head">
  <div class="doc-title">휴 가 신 청 서</div>
  <div class="appr">
    <div class="lb">결재</div>
    <div class="slot">
      <div class="role">${decided ? esc(l.decidedTitle || '-') : ''}</div>
      <div class="sign">${decided ? esc(l.decidedBy || '-') : ''}</div>
    </div>
  </div>
</div>
<table class="frm">
  <tr><th style="width:100px">문서번호</th><td colspan="5">${esc(l.docNo || '-')}</td></tr>
  <tr>
    <th style="width:100px">신청일자</th><td style="width:130px">${fmtDate(l.createdAt)}</td>
    <th style="width:80px">신청자</th><td style="width:110px">${esc(l.requesterName)}</td>
    <th style="width:80px">부서</th><td>${esc(l.requesterDept || p.department || '-')}</td>
  </tr>
  <tr>
    <th>직급</th><td>${esc(l.requesterTitle || p.job_title || '-')}</td>
    <th>연락처</th><td colspan="3">${esc(l.requesterPhone || p.phone || '-')}</td>
  </tr>
  <tr><th>휴가구분</th><td colspan="5">${esc(l.type)}</td></tr>
  <tr><th>휴가기간</th><td colspan="5">${fmtDate(l.startDate)}${l.endDate !== l.startDate ? ' ~ ' + fmtDate(l.endDate) : ''} (${l.days}일)</td></tr>
  <tr><th>휴가사유</th><td colspan="5" class="reason">${esc(l.reason || '-')}</td></tr>
</table>
<div class="statement">위와 같이 휴가를 신청하오니 재가하여 주시기 바랍니다.</div>
<div class="dateline">${String(l.createdAt).slice(0, 4)}년&nbsp;&nbsp;${num(String(l.createdAt).slice(5, 7))}월&nbsp;&nbsp;${num(String(l.createdAt).slice(8, 10))}일</div>
<div class="company">주식회사 유로링크</div>
</div>
<script>
function downloadPdf(){
  html2pdf().set({
    filename: ${JSON.stringify((l.docNo || 'leave-form') + '.pdf')},
    margin: 10,
    html2canvas: { scale: 2 },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
  }).from(document.getElementById('doc-body')).save();
}
<\/script>
</body></html>`;
}
function openLeaveForm(id) {
  const l = (DB.leaves || []).find(x => x.id === id);
  if (!l) return;
  if (!l.docNo) { l.docNo = genDocNo(l.createdAt); save(true); }   // 기능 추가 전 신청건 소급 부여
  const w = window.open('', '_blank');
  if (!w) { alert('팝업이 차단되었습니다. 브라우저 팝업 차단을 해제한 뒤 다시 시도해주세요.'); return; }
  w.document.write(leaveFormHtml(l));
  w.document.close();
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
      ${hits.map(l => `<span class="cal-tag" title="${esc(l.requesterDept || '')} ${esc(l.requesterTitle || '')} ${esc(l.requesterName)} ${esc(l.type)}">${l.requesterDept ? esc(l.requesterDept) + ' · ' : ''}${esc(l.requesterName)}${l.requesterTitle ? ' ' + esc(l.requesterTitle) : ''}${HALF_TYPES.includes(l.type) ? '(' + esc(l.type[2]) + ')' : ''}</span>`).join('')}
    </div>`;
  }).join('');
}

/* ───────────────────────── 10. 승인 관리 ───────────────────────── */
function renderApprovals() {
  const pending = (DB.leaves || []).filter(l => l.status === '대기').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  $('pending-body').innerHTML = pending.length ? pending.map(l => `
    <tr>
      <td>${esc(l.requesterName)}</td>
      <td>${esc(l.requesterDept || '-')}</td>
      <td>${esc(l.requesterTitle || '-')}</td>
      <td>${esc(l.type)}</td>
      <td>${fmtDate(l.startDate)}${l.endDate !== l.startDate ? ' ~ ' + fmtDate(l.endDate) : ''}</td>
      <td>${l.days}일</td>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(l.reason || '-')}</td>
      <td>${fmtDate(l.createdAt)}</td>
      <td>
        <button class="btn btn-sm btn-success" onclick="decideLeave('${l.id}','승인')">승인</button>
        <button class="btn btn-sm btn-outline-danger" onclick="decideLeave('${l.id}','반려')">반려</button>
      </td>
    </tr>`).join('') : `<tr><td colspan="9" class="empty-ul">대기중인 신청이 없습니다</td></tr>`;

  const decided = (DB.leaves || []).filter(l => l.status !== '대기').sort((a, b) => (b.decidedAt || '').localeCompare(a.decidedAt || '')).slice(0, 50);
  $('decided-body').innerHTML = decided.length ? decided.map(l => `
    <tr>
      <td>${esc(l.requesterName)}</td>
      <td>${esc(l.requesterDept || '-')}</td>
      <td>${esc(l.requesterTitle || '-')}</td>
      <td>${esc(l.type)}</td>
      <td>${fmtDate(l.startDate)}${l.endDate !== l.startDate ? ' ~ ' + fmtDate(l.endDate) : ''}</td>
      <td>${l.days}일</td>
      <td>${stBadge(l.status)}</td>
      <td>${esc(l.decidedBy || '-')}</td>
      <td>${fmtDate(l.decidedAt)}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-sm btn-outline-secondary" onclick="openLeaveForm('${l.id}')" title="신청서 보기/인쇄"><i class="bi bi-printer"></i></button>
        <button class="btn btn-sm btn-outline-warning" onclick="undecideLeave('${l.id}')" title="대기중으로 되돌리기">결정 취소</button>
      </td>
    </tr>`).join('') : `<tr><td colspan="10" class="empty-ul">처리 이력이 없습니다</td></tr>`;
}
function decideLeave(id, decision) {
  if (!isAdmin()) return;
  const row = (DB.leaves || []).find(l => l.id === id);
  if (!row) return;
  let reason = '';
  if (decision === '반려') {
    reason = prompt('반려 사유를 입력해주세요(선택):') || '';
  }
  row.status = decision; row.decidedBy = ME.display_name || ME.email; row.decidedTitle = ME.job_title || '';
  row.decidedAt = new Date().toISOString(); row.rejectReason = reason;
  save();
  if (decision === '승인') notifyRequesterOfDecision(row);
  renderApprovals(); renderDashboard();
}
/* 잘못 승인/반려한 건을 대기 상태로 되돌린다.
   승인 취소 시 잔여 연차·팀 캘린더는 status==='승인' 필터를 쓰므로 자동으로 반영됨. */
function undecideLeave(id) {
  if (!isAdmin()) return;
  const row = (DB.leaves || []).find(l => l.id === id);
  if (!row) return;
  if (!confirm(`${row.requesterName}님의 ${row.type} 신청(${row.status})을 대기중으로 되돌릴까요?`)) return;
  row.status = '대기'; row.decidedBy = ''; row.decidedTitle = ''; row.decidedAt = ''; row.rejectReason = '';
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
      <td>${esc(p.department || '-')}</td>
      <td>${esc(p.job_title || '-')}</td>
      <td>${esc(p.phone || '-')}</td>
      <td>${esc(p.email || '-')}</td>
      <td>${p.role === 'admin' ? '<span class="badge-admin">관리자</span>' : '일반'}</td>
      <td>${p.hire_date ? fmtDate(p.hire_date) : '<span style="color:#cbd5e1">미등록</span>'}</td>
      <td>${remain == null ? '-' : remain + '일'}</td>
      <td>${num(p.adjust_days) >= 0 ? '+' : ''}${num(p.adjust_days)}</td>
      <td>${p.active === false ? '<span class="badge-st no">차단</span>' : '<span class="badge-st ok">활성</span>'}</td>
      <td><button class="btn btn-sm btn-outline-secondary" onclick="openEmpModal('${p.id}')"><i class="bi bi-pencil"></i></button></td>
    </tr>`;
  }).join('') : `<tr><td colspan="11" class="empty-ul">직원이 없습니다</td></tr>`;
}
function openEmpModal(id) {
  const p = PROFILES.find(x => x.id === id); if (!p) return;
  $('em-id').value = p.id;
  $('em-email').textContent = p.email || '';
  $('em-name').value = p.display_name || '';
  $('em-dept').value = p.department || '';
  $('em-title').value = p.job_title || '';
  $('em-phone').value = p.phone || '';
  $('em-hire').value = p.hire_date || '';
  $('em-adjust').value = num(p.adjust_days);
  $('em-role').value = p.role === 'admin' ? 'admin' : 'user';
  $('em-active').checked = p.active !== false;
  new bootstrap.Modal($('modal-emp')).show();
}
async function saveEmp() {
  const id = $('em-id').value;
  const p = PROFILES.find(x => x.id === id);
  const name = $('em-name').value.trim();
  const patch = {
    display_name: name || (p.email || '').split('@')[0],
    department: $('em-dept').value.trim(),
    job_title: $('em-title').value.trim(),
    phone: $('em-phone').value.trim(),
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
    Object.assign(p, patch);
  } else {
    Object.assign(p, patch);
    save(true);
  }
  if (id === ME.id) { Object.assign(ME, patch); $('account-box').innerHTML = accountBoxHtml(); }
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
