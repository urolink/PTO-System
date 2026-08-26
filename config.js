/* ══════════════════════════════════════════════════════════════
   UroLink 연차관리 — 접속 설정
   ══════════════════════════════════════════════════════════════

   CRM과는 다른(새) Supabase 프로젝트를 씁니다. 그 프로젝트의
   URL / publishable 키를 아래에 채우세요.

   키 찾는 곳: Supabase 대시보드 → Settings → API Keys → anon / publishable
   ⚠ service_role(secret) 키는 절대 여기에 넣지 마세요.
     그 키는 RLS를 전부 우회하므로, 공개 repo에 올라가면 DB가 통째로 열립니다.

   로그인 계정은 이 프로젝트의 Authentication → Users → Add user 에서
   관리자가 직접 만듭니다(자체 가입 화면 없음). CRM과 같은 이메일/비밀번호로
   만들면 직원들이 같은 로그인 정보를 그대로 씁니다.
   ══════════════════════════════════════════════════════════════ */
window.UROLINK_CONFIG = {
  SUPABASE_URL: '',
  SUPABASE_KEY: ''
};
