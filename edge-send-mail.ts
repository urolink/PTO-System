// ══════════════════════════════════════════════════════════════
//  Supabase Edge Function : send-mail
//  연차 신청 시 대표이사에게, 승인 시 신청자에게 알림 메일을 보낸다.
//
//  왜 서버 함수로 하나
//    메일 발송 계정의 비밀번호(App Password)는 절대 브라우저 코드(config.js)에
//    둘 수 없다(공개 repo에 그대로 노출됨). 그래서 이 함수 안에만 두고,
//    앱은 자기 로그인 토큰으로 이 함수를 호출해서 "발송만" 부탁한다.
//    로그인하지 않은 사람은 호출할 수 없다(아래 1번 확인).
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
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

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

  const client = new SMTPClient({
    connection: {
      hostname: 'smtp.gmail.com',
      port: 465,
      tls: true,
      auth: { username: SMTP_USER, password: SMTP_PASS },
    },
  });

  try {
    await client.send({ from: SMTP_USER, to, subject, html, content: 'auto' });
  } catch (e) {
    return json({ error: '메일 발송 실패: ' + (e instanceof Error ? e.message : String(e)) }, 500);
  } finally {
    try { await client.close(); } catch { /* noop */ }
  }

  return json({ ok: true });
});
