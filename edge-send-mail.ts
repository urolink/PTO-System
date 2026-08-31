// ══════════════════════════════════════════════════════════════
//  Supabase Edge Function : send-mail
//  연차 신청 시 대표이사에게, 승인/반려 시 신청자에게 알림 메일을 보낸다.
//
//  왜 서버 함수로 하나
//    메일 발송 계정의 비밀번호(App Password)는 절대 브라우저 코드(config.js)에
//    둘 수 없다(공개 repo에 그대로 노출됨). 그래서 이 함수 안에만 두고,
//    앱은 자기 로그인 토큰으로 이 함수를 호출해서 "발송만" 부탁한다.
//    로그인하지 않은 사람은 호출할 수 없다(아래 1번 확인).
//
//  왜 라이브러리(denomailer) 대신 SMTP를 직접 구현했나
//    denomailer가 한글 제목(Subject)을 이메일 규격(RFC 2047)에 맞게
//    인코딩하지 못해, 받는 쪽(Gmail)이 메일을 통째로 못 알아보고
//    원문 그대로(=ec=95=88... 같은 코드) 보여주는 문제가 있었다.
//    제목·본문 모두 Base64로 직접 인코딩해서 규격을 확실히 지킨다.
//
//  배포 : Supabase 대시보드 → Edge Functions → Deploy a new function
//         이름을 정확히  send-mail  로 하고 이 파일 내용을 붙여넣는다.
//         SUPABASE_URL / SUPABASE_ANON_KEY 는 자동으로 들어간다.
//
//  추가로 등록해야 하는 비밀값 (Edge Functions → send-mail → Secrets):
//    SMTP_USER   메일 발송에 쓸 구글 워크스페이스 계정 (예: no-reply@urolink.co.kr)
//    SMTP_PASS   그 계정의 앱 비밀번호(App Password) — 로그인 비밀번호 아님!
//                구글 계정 → 보안 → 2단계 인증 켜기 → 앱 비밀번호 에서 발급.
//                (2단계 인증이 꺼져 있으면 앱 비밀번호 메뉴 자체가 안 보인다)
// ══════════════════════════════════════════════════════════════
import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

/* ── UTF-8 문자열 → Base64 (한글 등 비-ASCII 안전 변환) ── */
function toB64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
/* MIME 규격: base64 본문은 76자마다 줄바꿈 */
function wrap76(b64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join('\r\n');
}

/* ── 아주 작은 SMTP 클라이언트 (AUTH LOGIN + TLS, Gmail/워크스페이스용) ── */
async function smtpSend(opts: { from: string; to: string[]; subject: string; html: string; user: string; pass: string }) {
  const conn = await Deno.connectTls({ hostname: 'smtp.gmail.com', port: 465 });
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buf = '';

  async function readReply(): Promise<string> {
    for (;;) {
      const lines = buf.split('\r\n').filter(Boolean);
      const last = lines[lines.length - 1];
      if (last && /^\d{3} /.test(last)) {
        const consumed = lines.join('\r\n') + '\r\n';
        buf = buf.slice(consumed.length);
        return lines.join('\n');
      }
      const chunk = new Uint8Array(4096);
      const n = await conn.read(chunk);
      if (n === null) throw new Error('메일 서버 연결이 끊어졌습니다');
      buf += dec.decode(chunk.subarray(0, n));
    }
  }
  async function cmd(line: string): Promise<string> {
    await conn.write(enc.encode(line + '\r\n'));
    return await readReply();
  }

  try {
    const banner = await readReply();
    if (!banner.startsWith('220')) throw new Error('서버 응답 오류: ' + banner);

    let r = await cmd('EHLO urolink.co.kr');
    if (!r.startsWith('250')) throw new Error('EHLO 실패: ' + r);

    r = await cmd('AUTH LOGIN');
    if (!r.startsWith('334')) throw new Error('AUTH LOGIN 실패: ' + r);
    r = await cmd(btoa(opts.user));
    if (!r.startsWith('334')) throw new Error('계정 인증 실패: ' + r);
    r = await cmd(btoa(opts.pass));
    if (!r.startsWith('235')) throw new Error('비밀번호 인증 실패(앱 비밀번호를 확인해주세요): ' + r);

    r = await cmd(`MAIL FROM:<${opts.from}>`);
    if (!r.startsWith('250')) throw new Error('MAIL FROM 실패: ' + r);

    for (const addr of opts.to) {
      r = await cmd(`RCPT TO:<${addr}>`);
      if (!r.startsWith('250')) throw new Error(`RCPT TO 실패(${addr}): ` + r);
    }

    r = await cmd('DATA');
    if (!r.startsWith('354')) throw new Error('DATA 실패: ' + r);

    const subjectHeader = `=?UTF-8?B?${toB64(opts.subject)}?=`;
    const bodyB64 = wrap76(toB64(opts.html));
    const message =
      `From: ${opts.from}\r\n` +
      `To: ${opts.to.join(', ')}\r\n` +
      `Subject: ${subjectHeader}\r\n` +
      `Date: ${new Date().toUTCString()}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/html; charset="UTF-8"\r\n` +
      `Content-Transfer-Encoding: base64\r\n` +
      `\r\n` +
      bodyB64;
    // SMTP 규약: 본문 줄이 '.' 하나로 시작하면 종료 신호와 헷갈리므로 '..'으로 이스케이프
    const stuffed = message.split('\r\n').map(l => (l.startsWith('.') ? '.' + l : l)).join('\r\n');
    await conn.write(enc.encode(stuffed + '\r\n.\r\n'));
    r = await readReply();
    if (!r.startsWith('250')) throw new Error('메일 전송 실패: ' + r);

    await cmd('QUIT').catch(() => {});
  } finally {
    try { conn.close(); } catch { /* noop */ }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST 만 허용됩니다' }, 405);

  const URL_ = Deno.env.get('SUPABASE_URL')!;
  const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
  const SMTP_USER = Deno.env.get('SMTP_USER');
  const SMTP_PASS = Deno.env.get('SMTP_PASS');

  // ── 1) 로그인한 사람만 호출 가능 (활성 계정) ──
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader) return json({ error: '로그인이 필요합니다' }, 401);

  const asUser = createClient(URL_, ANON, { global: { headers: { Authorization: authHeader } } });
  const { data: userRes, error: uErr } = await asUser.auth.getUser();
  const caller = userRes?.user;
  if (uErr || !caller) return json({ error: '로그인이 필요합니다' }, 401);

  const { data: me } = await asUser
    .from('ul_profiles').select('active').eq('id', caller.id).maybeSingle();
  if (!me || me.active === false) return json({ error: '접속이 차단된 계정입니다' }, 403);

  // ── 2) 요청 처리 ──
  let body: { to?: string[]; subject?: string; html?: string } = {};
  try { body = await req.json(); } catch { return json({ error: '잘못된 요청입니다' }, 400); }

  const to = Array.isArray(body.to) ? body.to.filter(a => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(a))).slice(0, 5) : [];
  const subject = String(body.subject ?? '').slice(0, 200);
  const html = String(body.html ?? '').slice(0, 5000);
  if (!to.length) return json({ error: '받는 사람이 없습니다' }, 400);
  if (!subject || !html) return json({ error: '제목/내용이 없습니다' }, 400);

  if (!SMTP_USER || !SMTP_PASS) {
    // 관리자가 아직 Secrets 를 등록하지 않은 상태 — 메일만 건너뛰고 앱 흐름은 막지 않는다.
    return json({ ok: false, skipped: true, reason: 'SMTP_USER/SMTP_PASS 미설정' });
  }

  try {
    await smtpSend({ from: SMTP_USER, to, subject, html, user: SMTP_USER, pass: SMTP_PASS });
  } catch (e) {
    return json({ error: '메일 발송 실패: ' + (e instanceof Error ? e.message : String(e)) }, 500);
  }

  return json({ ok: true });
});
