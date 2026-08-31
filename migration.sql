-- ═══════════════════════════════════════════════════════════════
--  UroLink 연차관리 — Supabase 스키마
--  Supabase 대시보드 → SQL Editor 에 전체 붙여넣고 1회 실행.
--  여러 번 실행해도 안전합니다(idempotent).
--  ⚠ CRM(urolink-crm)과는 "별도의 새 Supabase 프로젝트"에 실행하세요.
-- ═══════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────
-- 1. 프로필 (역할 + 연차 계산에 필요한 정보)
--    auth.users 1건 = ul_profiles 1건.
--    계정은 Supabase 대시보드 → Authentication → Users → Add user 에서
--    관리자가 직접 만듭니다(초대/가입 화면 없음). CRM 계정과 같은
--    이메일/비밀번호로 만들면 로그인 정보를 그대로 재사용할 수 있습니다.
-- ───────────────────────────────────────────────────────────────
create table if not exists ul_profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text,
  display_name text,
  department   text,                        -- 부서
  role         text not null default 'user' check (role in ('admin','user')),
  hire_date    date,                        -- 입사일 (연차 자동계산 기준)
  adjust_days  numeric not null default 0,  -- 관리자 수동 조정(이월·차감 등)
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);
-- 이미 만들어진 프로젝트(테이블이 먼저 생성된 경우)에도 부서 컬럼을 추가한다
alter table ul_profiles add column if not exists department text;

create or replace function ul_on_auth_user_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into ul_profiles (id, email, display_name)
  values (new.id, new.email, split_part(coalesce(new.email, ''), '@', 1))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists ul_auth_user_created on auth.users;
create trigger ul_auth_user_created
  after insert on auth.users
  for each row execute function ul_on_auth_user_created();

create or replace function ul_is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((select role = 'admin' from ul_profiles where id = auth.uid()), false);
$$;

create or replace function ul_is_active()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((select active from ul_profiles where id = auth.uid()), false);
$$;

-- 일반 사용자가 스스로 role/active/adjust_days 를 바꾸는 것을 차단
create or replace function ul_guard_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.role is distinct from old.role
      or new.active is distinct from old.active
      or new.adjust_days is distinct from old.adjust_days
      or new.hire_date is distinct from old.hire_date
      or new.department is distinct from old.department)
     and auth.uid() is not null
     and not ul_is_admin() then
    raise exception '권한이 없습니다(관리자만 변경 가능)';
  end if;
  return new;
end $$;

drop trigger if exists ul_profiles_guard on ul_profiles;
create trigger ul_profiles_guard
  before update on ul_profiles
  for each row execute function ul_guard_profile();

alter table ul_profiles enable row level security;

drop policy if exists ul_prof_read   on ul_profiles;
drop policy if exists ul_prof_update on ul_profiles;
drop policy if exists ul_prof_delete on ul_profiles;

create policy ul_prof_read on ul_profiles
  for select to authenticated using (true);
create policy ul_prof_update on ul_profiles
  for update to authenticated
  using (id = auth.uid() or ul_is_admin())
  with check (id = auth.uid() or ul_is_admin());
create policy ul_prof_delete on ul_profiles
  for delete to authenticated using (ul_is_admin());

-- ───────────────────────────────────────────────────────────────
-- 2. 연차 신청 (id + data jsonb 구조 — 필드 추가에 SQL 변경 불필요)
-- ───────────────────────────────────────────────────────────────
create table if not exists ul_leaves (
  id         text primary key,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create or replace function ul_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists ul_leaves_touch on ul_leaves;
create trigger ul_leaves_touch
  before update on ul_leaves
  for each row execute function ul_touch_updated_at();

alter table ul_leaves enable row level security;

drop policy if exists ul_leaves_read   on ul_leaves;
drop policy if exists ul_leaves_insert on ul_leaves;
drop policy if exists ul_leaves_update on ul_leaves;
drop policy if exists ul_leaves_delete on ul_leaves;

-- 활성 계정만 읽고 쓸 수 있음 (차단된 계정은 접근 불가)
create policy ul_leaves_read on ul_leaves
  for select to authenticated using (ul_is_active());
create policy ul_leaves_insert on ul_leaves
  for insert to authenticated with check (ul_is_active());
-- 수정: 본인 신청 또는 관리자(승인/반려 처리 포함)
create policy ul_leaves_update on ul_leaves
  for update to authenticated
  using (ul_is_active() and (ul_is_admin() or data->>'requesterId' = auth.uid()::text))
  with check (ul_is_active() and (ul_is_admin() or data->>'requesterId' = auth.uid()::text));
-- 삭제: 본인의 대기중 신청 취소, 또는 관리자
create policy ul_leaves_delete on ul_leaves
  for delete to authenticated using (
    ul_is_active() and (
      ul_is_admin() or
      (data->>'requesterId' = auth.uid()::text and data->>'status' = '대기')
    )
  );
