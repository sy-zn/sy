-- Shared ledger schema V2 (member-centric + account binding)
-- Run in Supabase SQL Editor

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  role text not null default 'member' check (role in ('admin', 'member')),
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists display_name text;
alter table public.profiles add column if not exists role text;

update public.profiles p
set email = u.email
from auth.users u
where p.id = u.id
  and (p.email is null or p.email = '');

create unique index if not exists profiles_email_unique on public.profiles(email) where email is not null;

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
before update on public.profiles
for each row
execute function public.set_updated_at();

create table if not exists public.members (
  id uuid primary key default gen_random_uuid(),
  member_name text not null unique,
  note text,
  is_active boolean not null default true,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_members_updated_at on public.members;
create trigger set_members_updated_at
before update on public.members
for each row
execute function public.set_updated_at();

create table if not exists public.account_member_bindings (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists account_member_bindings_profile_unique
on public.account_member_bindings(profile_id);

drop trigger if exists set_account_member_bindings_updated_at on public.account_member_bindings;
create trigger set_account_member_bindings_updated_at
before update on public.account_member_bindings
for each row
execute function public.set_updated_at();

create table if not exists public.member_hashrates (
  member_id uuid primary key references public.members(id) on delete cascade,
  hashrate_ths numeric(14,2) not null default 0 check (hashrate_ths >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_member_hashrates_updated_at on public.member_hashrates;
create trigger set_member_hashrates_updated_at
before update on public.member_hashrates
for each row
execute function public.set_updated_at();

create table if not exists public.settlement_periods (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  start_date date not null,
  end_date date not null,
  status text not null default 'open' check (status in ('open', 'locked')),
  notes text,
  created_by uuid not null references public.profiles(id),
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date)
);

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'settlement_periods'
      and column_name = 'start_at'
  ) then
    alter table public.settlement_periods alter column start_at drop not null;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'settlement_periods'
      and column_name = 'end_at'
  ) then
    alter table public.settlement_periods alter column end_at drop not null;
  end if;
end $$;

drop trigger if exists set_settlement_periods_updated_at on public.settlement_periods;
create trigger set_settlement_periods_updated_at
before update on public.settlement_periods
for each row
execute function public.set_updated_at();

create table if not exists public.capital_entries (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id),
  member_id uuid references public.members(id),
  amount numeric(14,2) not null check (amount <> 0),
  entry_date date not null,
  description text,
  receipt_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.capital_entries add column if not exists member_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'capital_entries_member_id_fkey'
  ) then
    alter table public.capital_entries
    add constraint capital_entries_member_id_fkey
    foreign key (member_id) references public.members(id);
  end if;
end $$;

drop trigger if exists set_capital_entries_updated_at on public.capital_entries;
create trigger set_capital_entries_updated_at
before update on public.capital_entries
for each row
execute function public.set_updated_at();

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  payer_id uuid not null references public.profiles(id),
  member_id uuid references public.members(id),
  amount numeric(14,2) not null check (amount > 0),
  expense_date date not null,
  category text not null check (category in ('electricity', 'salary', 'maintenance', 'hospitality', 'travel', 'other')),
  payment_source text not null check (payment_source in ('pool', 'personal')),
  description text,
  receipt_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.expenses add column if not exists member_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'expenses_member_id_fkey'
  ) then
    alter table public.expenses
    add constraint expenses_member_id_fkey
    foreign key (member_id) references public.members(id);
  end if;
end $$;

drop trigger if exists set_expenses_updated_at on public.expenses;
create trigger set_expenses_updated_at
before update on public.expenses
for each row
execute function public.set_updated_at();

create or replace function public.is_admin(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = uid
      and p.role = 'admin'
  );
$$;

create or replace function public.can_use_member(uid uuid, target_member uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.is_admin(uid)
    or exists (
      select 1
      from public.account_member_bindings b
      where b.profile_id = uid
        and b.member_id = target_member
        and b.is_active = true
    );
$$;

create or replace function public.is_date_locked(target_day date)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.settlement_periods p
    where p.status = 'locked'
      and target_day between p.start_date and p.end_date
  );
$$;

create or replace function public.guard_locked_period_capital()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if public.is_date_locked(new.entry_date) then
      raise exception 'This date is in a locked settlement period.';
    end if;
    return new;
  elsif tg_op = 'UPDATE' then
    if public.is_date_locked(old.entry_date) or public.is_date_locked(new.entry_date) then
      raise exception 'This date is in a locked settlement period.';
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    if public.is_date_locked(old.entry_date) then
      raise exception 'This date is in a locked settlement period.';
    end if;
    return old;
  end if;
  return null;
end;
$$;

create or replace function public.guard_locked_period_expense()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if public.is_date_locked(new.expense_date) then
      raise exception 'This date is in a locked settlement period.';
    end if;
    return new;
  elsif tg_op = 'UPDATE' then
    if public.is_date_locked(old.expense_date) or public.is_date_locked(new.expense_date) then
      raise exception 'This date is in a locked settlement period.';
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    if public.is_date_locked(old.expense_date) then
      raise exception 'This date is in a locked settlement period.';
    end if;
    return old;
  end if;
  return null;
end;
$$;

drop trigger if exists guard_locked_period_capital_trigger on public.capital_entries;
create trigger guard_locked_period_capital_trigger
before insert or update or delete on public.capital_entries
for each row
execute function public.guard_locked_period_capital();

drop trigger if exists guard_locked_period_expense_trigger on public.expenses;
create trigger guard_locked_period_expense_trigger
before insert or update or delete on public.expenses
for each row
execute function public.guard_locked_period_expense();

create schema if not exists private;

create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  insert into public.profiles (id, display_name, role, email)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), split_part(new.email, '@', 1), 'member'),
    'member',
    new.email
  )
  on conflict (id) do update
  set email = coalesce(excluded.email, public.profiles.email),
      display_name = coalesce(nullif(public.profiles.display_name, ''), excluded.display_name),
      updated_at = now();

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
drop trigger if exists on_auth_user_created_create_profile on auth.users;
drop function if exists public.handle_new_user();

create trigger on_auth_user_created_create_profile
after insert on auth.users
for each row
execute function private.handle_new_auth_user();

insert into public.profiles (id, email, display_name, role)
select
  u.id,
  u.email,
  coalesce(nullif(u.raw_user_meta_data->>'display_name', ''), split_part(u.email, '@', 1), 'member'),
  'member'
from auth.users u
where u.email is not null
on conflict (id) do update
set email = coalesce(excluded.email, public.profiles.email),
    display_name = coalesce(nullif(public.profiles.display_name, ''), excluded.display_name),
    updated_at = now();

-- backfill: create default member + binding for accounts without mapping
DO $$
DECLARE
  p record;
  new_member_id uuid;
  old_hashrate numeric;
BEGIN
  FOR p IN
    select pr.id, pr.display_name, pr.email
    from public.profiles pr
    where not exists (
      select 1 from public.account_member_bindings b where b.profile_id = pr.id
    )
  LOOP
    insert into public.members(member_name, note, is_active, created_by)
    values (
      coalesce(nullif(trim(p.display_name), ''), split_part(coalesce(p.email, ''), '@', 1), left(p.id::text, 8)),
      'auto-created from account',
      true,
      p.id
    )
    returning id into new_member_id;

    insert into public.account_member_bindings(profile_id, member_id, is_active)
    values (p.id, new_member_id, true)
    on conflict (profile_id) do update
    set member_id = excluded.member_id,
        is_active = true,
        updated_at = now();

    old_hashrate := null;
    if exists (
      select 1
      from information_schema.tables
      where table_schema = 'public' and table_name = 'member_shares'
    ) then
      execute 'select hashrate_ths from public.member_shares where user_id = $1' into old_hashrate using p.id;
    end if;

    insert into public.member_hashrates(member_id, hashrate_ths)
    values (new_member_id, coalesce(old_hashrate, 0))
    on conflict (member_id) do nothing;
  END LOOP;
END $$;

update public.capital_entries c
set member_id = b.member_id
from public.account_member_bindings b
where c.member_id is null
  and c.owner_id = b.profile_id;

update public.expenses e
set member_id = b.member_id
from public.account_member_bindings b
where e.member_id is null
  and e.payer_id = b.profile_id;

alter table public.profiles enable row level security;
alter table public.members enable row level security;
alter table public.account_member_bindings enable row level security;
alter table public.member_hashrates enable row level security;
alter table public.settlement_periods enable row level security;
alter table public.capital_entries enable row level security;
alter table public.expenses enable row level security;

grant usage on schema public to authenticated;

grant select, insert, update, delete on table public.profiles to authenticated;
grant select, insert, update, delete on table public.members to authenticated;
grant select, insert, update, delete on table public.account_member_bindings to authenticated;
grant select, insert, update, delete on table public.member_hashrates to authenticated;
grant select, insert, update, delete on table public.settlement_periods to authenticated;
grant select, insert, update, delete on table public.capital_entries to authenticated;
grant select, insert, update, delete on table public.expenses to authenticated;

-- profiles
drop policy if exists "profiles_select_authenticated" on public.profiles;
create policy "profiles_select_authenticated"
on public.profiles
for select to authenticated
using (true);

drop policy if exists "profiles_insert_self" on public.profiles;
create policy "profiles_insert_self"
on public.profiles
for insert to authenticated
with check (id = auth.uid());

drop policy if exists "profiles_update_self_or_admin" on public.profiles;
create policy "profiles_update_self_or_admin"
on public.profiles
for update to authenticated
using (id = auth.uid() or public.is_admin(auth.uid()))
with check (id = auth.uid() or public.is_admin(auth.uid()));

-- members
drop policy if exists "members_select_authenticated" on public.members;
create policy "members_select_authenticated"
on public.members
for select to authenticated
using (true);

drop policy if exists "members_admin_insert" on public.members;
create policy "members_admin_insert"
on public.members
for insert to authenticated
with check (public.is_admin(auth.uid()));

drop policy if exists "members_admin_update" on public.members;
create policy "members_admin_update"
on public.members
for update to authenticated
using (public.is_admin(auth.uid()))
with check (public.is_admin(auth.uid()));

drop policy if exists "members_admin_delete" on public.members;
create policy "members_admin_delete"
on public.members
for delete to authenticated
using (public.is_admin(auth.uid()));

-- account bindings
drop policy if exists "bindings_select_authenticated" on public.account_member_bindings;
create policy "bindings_select_authenticated"
on public.account_member_bindings
for select to authenticated
using (true);

drop policy if exists "bindings_admin_insert" on public.account_member_bindings;
create policy "bindings_admin_insert"
on public.account_member_bindings
for insert to authenticated
with check (public.is_admin(auth.uid()));

drop policy if exists "bindings_admin_update" on public.account_member_bindings;
create policy "bindings_admin_update"
on public.account_member_bindings
for update to authenticated
using (public.is_admin(auth.uid()))
with check (public.is_admin(auth.uid()));

drop policy if exists "bindings_admin_delete" on public.account_member_bindings;
create policy "bindings_admin_delete"
on public.account_member_bindings
for delete to authenticated
using (public.is_admin(auth.uid()));

-- member hashrates
drop policy if exists "hashrates_select_authenticated" on public.member_hashrates;
create policy "hashrates_select_authenticated"
on public.member_hashrates
for select to authenticated
using (true);

drop policy if exists "hashrates_admin_insert" on public.member_hashrates;
create policy "hashrates_admin_insert"
on public.member_hashrates
for insert to authenticated
with check (public.is_admin(auth.uid()));

drop policy if exists "hashrates_admin_update" on public.member_hashrates;
create policy "hashrates_admin_update"
on public.member_hashrates
for update to authenticated
using (public.is_admin(auth.uid()))
with check (public.is_admin(auth.uid()));

drop policy if exists "hashrates_admin_delete" on public.member_hashrates;
create policy "hashrates_admin_delete"
on public.member_hashrates
for delete to authenticated
using (public.is_admin(auth.uid()));

-- settlement periods
drop policy if exists "periods_select_authenticated" on public.settlement_periods;
create policy "periods_select_authenticated"
on public.settlement_periods
for select to authenticated
using (true);

drop policy if exists "periods_admin_insert" on public.settlement_periods;
create policy "periods_admin_insert"
on public.settlement_periods
for insert to authenticated
with check (public.is_admin(auth.uid()));

drop policy if exists "periods_admin_update" on public.settlement_periods;
create policy "periods_admin_update"
on public.settlement_periods
for update to authenticated
using (public.is_admin(auth.uid()))
with check (public.is_admin(auth.uid()));

drop policy if exists "periods_admin_delete" on public.settlement_periods;
create policy "periods_admin_delete"
on public.settlement_periods
for delete to authenticated
using (public.is_admin(auth.uid()));

-- capital entries
drop policy if exists "capital_select_authenticated" on public.capital_entries;
create policy "capital_select_authenticated"
on public.capital_entries
for select to authenticated
using (true);

drop policy if exists "capital_insert_own_bound_member" on public.capital_entries;
create policy "capital_insert_own_bound_member"
on public.capital_entries
for insert to authenticated
with check (
  owner_id = auth.uid()
  and member_id is not null
  and public.can_use_member(auth.uid(), member_id)
);

drop policy if exists "capital_update_own_bound_member" on public.capital_entries;
create policy "capital_update_own_bound_member"
on public.capital_entries
for update to authenticated
using (owner_id = auth.uid())
with check (
  owner_id = auth.uid()
  and member_id is not null
  and public.can_use_member(auth.uid(), member_id)
);

drop policy if exists "capital_delete_own" on public.capital_entries;
create policy "capital_delete_own"
on public.capital_entries
for delete to authenticated
using (owner_id = auth.uid());

-- expenses
drop policy if exists "expenses_select_authenticated" on public.expenses;
create policy "expenses_select_authenticated"
on public.expenses
for select to authenticated
using (true);

drop policy if exists "expenses_insert_own_bound_member" on public.expenses;
create policy "expenses_insert_own_bound_member"
on public.expenses
for insert to authenticated
with check (
  payer_id = auth.uid()
  and member_id is not null
  and public.can_use_member(auth.uid(), member_id)
);

drop policy if exists "expenses_update_own_bound_member" on public.expenses;
create policy "expenses_update_own_bound_member"
on public.expenses
for update to authenticated
using (payer_id = auth.uid())
with check (
  payer_id = auth.uid()
  and member_id is not null
  and public.can_use_member(auth.uid(), member_id)
);

drop policy if exists "expenses_delete_own" on public.expenses;
create policy "expenses_delete_own"
on public.expenses
for delete to authenticated
using (payer_id = auth.uid());

-- Storage bucket + policies (optional: if dashboard blocks, configure in Storage -> Policies UI)
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do update set public = excluded.public;

drop policy if exists "receipts_select_authenticated" on storage.objects;
create policy "receipts_select_authenticated"
on storage.objects
for select to authenticated
using (bucket_id = 'receipts');

drop policy if exists "receipts_insert_own_folder" on storage.objects;
create policy "receipts_insert_own_folder"
on storage.objects
for insert to authenticated
with check (
  bucket_id = 'receipts'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "receipts_update_own_folder" on storage.objects;
create policy "receipts_update_own_folder"
on storage.objects
for update to authenticated
using (
  bucket_id = 'receipts'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'receipts'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "receipts_delete_own_folder" on storage.objects;
create policy "receipts_delete_own_folder"
on storage.objects
for delete to authenticated
using (
  bucket_id = 'receipts'
  and (storage.foldername(name))[1] = auth.uid()::text
);
