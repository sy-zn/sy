-- Shared ledger schema for partner mining project
-- Run this file in Supabase SQL Editor

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
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_profiles_updated_at
before update on public.profiles
for each row
execute function public.set_updated_at();

create table if not exists public.member_shares (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  hashrate_ths numeric(14, 2) not null default 0 check (hashrate_ths >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_member_shares_updated_at
before update on public.member_shares
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

create trigger set_settlement_periods_updated_at
before update on public.settlement_periods
for each row
execute function public.set_updated_at();

create table if not exists public.capital_entries (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id),
  amount numeric(14, 2) not null check (amount <> 0),
  entry_date date not null,
  description text,
  receipt_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_capital_entries_updated_at
before update on public.capital_entries
for each row
execute function public.set_updated_at();

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  payer_id uuid not null references public.profiles(id),
  amount numeric(14, 2) not null check (amount > 0),
  expense_date date not null,
  category text not null check (category in ('electricity', 'salary', 'maintenance', 'hospitality', 'travel', 'other')),
  payment_source text not null check (payment_source in ('pool', 'personal')),
  description text,
  receipt_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

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

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  fallback_name text;
begin
  fallback_name := coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1), 'member');

  insert into public.profiles (id, display_name, role)
  values (new.id, fallback_name, 'member')
  on conflict (id) do nothing;

  insert into public.member_shares (user_id, hashrate_ths, is_active)
  values (new.id, 0, true)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.member_shares enable row level security;
alter table public.settlement_periods enable row level security;
alter table public.capital_entries enable row level security;
alter table public.expenses enable row level security;

-- profiles policies
drop policy if exists "profiles_select_authenticated" on public.profiles;
create policy "profiles_select_authenticated"
on public.profiles
for select
to authenticated
using (true);

drop policy if exists "profiles_insert_self" on public.profiles;
create policy "profiles_insert_self"
on public.profiles
for insert
to authenticated
with check (id = auth.uid());

drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self"
on public.profiles
for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

-- member_shares policies
drop policy if exists "member_shares_select_authenticated" on public.member_shares;
create policy "member_shares_select_authenticated"
on public.member_shares
for select
to authenticated
using (true);

drop policy if exists "member_shares_admin_insert" on public.member_shares;
create policy "member_shares_admin_insert"
on public.member_shares
for insert
to authenticated
with check (public.is_admin(auth.uid()));

drop policy if exists "member_shares_admin_update" on public.member_shares;
create policy "member_shares_admin_update"
on public.member_shares
for update
to authenticated
using (public.is_admin(auth.uid()))
with check (public.is_admin(auth.uid()));

drop policy if exists "member_shares_admin_delete" on public.member_shares;
create policy "member_shares_admin_delete"
on public.member_shares
for delete
to authenticated
using (public.is_admin(auth.uid()));

-- settlement_periods policies
drop policy if exists "periods_select_authenticated" on public.settlement_periods;
create policy "periods_select_authenticated"
on public.settlement_periods
for select
to authenticated
using (true);

drop policy if exists "periods_admin_insert" on public.settlement_periods;
create policy "periods_admin_insert"
on public.settlement_periods
for insert
to authenticated
with check (public.is_admin(auth.uid()));

drop policy if exists "periods_admin_update" on public.settlement_periods;
create policy "periods_admin_update"
on public.settlement_periods
for update
to authenticated
using (public.is_admin(auth.uid()))
with check (public.is_admin(auth.uid()));

drop policy if exists "periods_admin_delete" on public.settlement_periods;
create policy "periods_admin_delete"
on public.settlement_periods
for delete
to authenticated
using (public.is_admin(auth.uid()));

-- capital_entries policies
drop policy if exists "capital_select_authenticated" on public.capital_entries;
create policy "capital_select_authenticated"
on public.capital_entries
for select
to authenticated
using (true);

drop policy if exists "capital_insert_own" on public.capital_entries;
create policy "capital_insert_own"
on public.capital_entries
for insert
to authenticated
with check (owner_id = auth.uid());

drop policy if exists "capital_update_own" on public.capital_entries;
create policy "capital_update_own"
on public.capital_entries
for update
to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

drop policy if exists "capital_delete_own" on public.capital_entries;
create policy "capital_delete_own"
on public.capital_entries
for delete
to authenticated
using (owner_id = auth.uid());

-- expenses policies
drop policy if exists "expenses_select_authenticated" on public.expenses;
create policy "expenses_select_authenticated"
on public.expenses
for select
to authenticated
using (true);

drop policy if exists "expenses_insert_own" on public.expenses;
create policy "expenses_insert_own"
on public.expenses
for insert
to authenticated
with check (payer_id = auth.uid());

drop policy if exists "expenses_update_own" on public.expenses;
create policy "expenses_update_own"
on public.expenses
for update
to authenticated
using (payer_id = auth.uid())
with check (payer_id = auth.uid());

drop policy if exists "expenses_delete_own" on public.expenses;
create policy "expenses_delete_own"
on public.expenses
for delete
to authenticated
using (payer_id = auth.uid());

-- Storage bucket and policies (private receipts)
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do update set public = excluded.public;

alter table storage.objects enable row level security;

drop policy if exists "receipts_select_authenticated" on storage.objects;
create policy "receipts_select_authenticated"
on storage.objects
for select
to authenticated
using (bucket_id = 'receipts');

drop policy if exists "receipts_insert_own_folder" on storage.objects;
create policy "receipts_insert_own_folder"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'receipts'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "receipts_update_own_folder" on storage.objects;
create policy "receipts_update_own_folder"
on storage.objects
for update
to authenticated
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
for delete
to authenticated
using (
  bucket_id = 'receipts'
  and (storage.foldername(name))[1] = auth.uid()::text
);
