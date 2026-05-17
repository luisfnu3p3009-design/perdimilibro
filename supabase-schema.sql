-- ============================================================
-- perdimilibro · Schema Supabase v0.3
-- ------------------------------------------------------------
-- Pegar TODO este archivo en Supabase Dashboard → SQL Editor →
-- New query → Run. Crea tablas, índices, RLS, y trigger que
-- inicializa el household al hacer signup.
--
-- Idempotente: se puede correr varias veces sin romper nada.
-- ============================================================

-- ---------- 1. EXTENSIONES ----------
create extension if not exists "pgcrypto"; -- para gen_random_uuid()

-- ---------- 2. TABLAS ----------

-- Households: 1 por usuario (constraint unique más abajo)
create table if not exists public.households (
  id              uuid primary key default gen_random_uuid(),
  owner_user_id   uuid not null references auth.users(id) on delete cascade,
  name            text not null default 'Mi biblioteca',
  created_at      timestamptz not null default now()
);

create unique index if not exists households_owner_unique
  on public.households(owner_user_id);
-- ↑ Garantiza 1 user = 1 household. Si se quiere abrir a múltiples
--   bibliotecas por user en el futuro, basta con dropear este índice.

-- Members: dueños de libros dentro de un household ("Yo", "Mamá", etc.)
create table if not exists public.members (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references public.households(id) on delete cascade,
  name            text not null,
  color           text,
  created_at      timestamptz not null default now()
);
create index if not exists members_household_idx on public.members(household_id);

-- Locations: jerarquía padre-hijo de ubicaciones físicas
create table if not exists public.locations (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references public.households(id) on delete cascade,
  parent_id       uuid references public.locations(id) on delete set null,
  name            text not null,
  position        integer not null default 0,
  created_at      timestamptz not null default now()
);
create index if not exists locations_household_idx on public.locations(household_id);
create index if not exists locations_parent_idx    on public.locations(parent_id);

-- Books
create table if not exists public.books (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references public.households(id) on delete cascade,
  owner_id        uuid references public.members(id) on delete set null,
  location_id     uuid references public.locations(id) on delete set null,
  isbn            text,
  title           text not null default 'Sin título',
  authors         text[] not null default '{}',
  cover_url       text,
  publisher       text,
  published_year  integer,
  language        text default 'es',
  status          text not null default 'home', -- home, lent, reading, wishlist, lost
  notes           text,
  categories      text[] not null default '{}',
  added_at        timestamptz not null default now()
);
create index if not exists books_household_idx on public.books(household_id);
create index if not exists books_owner_idx     on public.books(owner_id);
create index if not exists books_location_idx  on public.books(location_id);
create index if not exists books_status_idx    on public.books(status);

-- Loans (préstamos a terceros)
create table if not exists public.loans (
  id                uuid primary key default gen_random_uuid(),
  book_id           uuid not null references public.books(id) on delete cascade,
  borrower_name     text not null,
  borrower_contact  text,
  lent_at           date not null default current_date,
  expected_return   date,
  returned_at       date,
  notes             text
);
create index if not exists loans_book_idx on public.loans(book_id);

-- ISBN cache: GLOBAL, compartido entre todos los usuarios.
-- Es data bibliográfica pública, no hay privacidad y compartirla
-- ahorra llamadas a Google Books / Anthropic API.
create table if not exists public.isbn_cache (
  isbn        text primary key,
  data        jsonb not null,
  source      text,
  cached_at   timestamptz not null default now()
);

-- Settings por usuario (reemplaza el store 'settings' de IndexedDB)
create table if not exists public.user_settings (
  user_id     uuid not null references auth.users(id) on delete cascade,
  key         text not null,
  value       jsonb,
  updated_at  timestamptz not null default now(),
  primary key (user_id, key)
);

-- ---------- 3. FUNCIÓN HELPER ----------
-- Devuelve el household del usuario logueado. Usada por RLS.
create or replace function public.current_household_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select id from public.households where owner_user_id = auth.uid() limit 1;
$$;

-- ---------- 4. RLS ----------

alter table public.households     enable row level security;
alter table public.members        enable row level security;
alter table public.locations      enable row level security;
alter table public.books          enable row level security;
alter table public.loans          enable row level security;
alter table public.isbn_cache     enable row level security;
alter table public.user_settings  enable row level security;

-- Drop policies viejas si existen (para que el script sea re-runnable)
drop policy if exists "households_select"  on public.households;
drop policy if exists "households_update"  on public.households;
drop policy if exists "members_all"        on public.members;
drop policy if exists "locations_all"      on public.locations;
drop policy if exists "books_all"          on public.books;
drop policy if exists "loans_all"          on public.loans;
drop policy if exists "isbn_cache_read"    on public.isbn_cache;
drop policy if exists "isbn_cache_write"   on public.isbn_cache;
drop policy if exists "user_settings_all"  on public.user_settings;

-- households: usuario ve y edita el propio. Insert lo hace el trigger,
-- delete está deshabilitado (cascade desde auth.users si borra cuenta).
create policy "households_select" on public.households
  for select using (owner_user_id = auth.uid());
create policy "households_update" on public.households
  for update using (owner_user_id = auth.uid());

-- members, locations, books: scope por household propio
create policy "members_all" on public.members
  for all
  using      (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());

create policy "locations_all" on public.locations
  for all
  using      (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());

create policy "books_all" on public.books
  for all
  using      (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());

-- loans: a través de book → household
create policy "loans_all" on public.loans
  for all
  using (
    book_id in (select id from public.books where household_id = public.current_household_id())
  )
  with check (
    book_id in (select id from public.books where household_id = public.current_household_id())
  );

-- isbn_cache: cualquier autenticado lee y escribe (es shared)
create policy "isbn_cache_read"  on public.isbn_cache
  for select to authenticated using (true);
create policy "isbn_cache_write" on public.isbn_cache
  for insert to authenticated with check (true);

-- user_settings: cada usuario ve/escribe el suyo
create policy "user_settings_all" on public.user_settings
  for all
  using      (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------- 5. TRIGGER: setup automático al signup ----------
-- Cuando se crea un row en auth.users, se crea:
--   - 1 household ("Mi biblioteca")
--   - 1 member default ("Yo")
--   - 1 location default ("Living")

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_household_id uuid;
begin
  insert into public.households (owner_user_id, name)
  values (new.id, 'Mi biblioteca')
  returning id into new_household_id;

  insert into public.members (household_id, name, color)
  values (new_household_id, 'Yo', '#1d2d44');

  insert into public.locations (household_id, name, position)
  values (new_household_id, 'Living', 0);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- 6. GRANTS ----------
-- Por defecto Supabase ya da acceso a 'authenticated' role, pero
-- por las dudas dejo explícito el grant a las tablas.
grant usage on schema public to authenticated;
grant all on public.households    to authenticated;
grant all on public.members       to authenticated;
grant all on public.locations     to authenticated;
grant all on public.books         to authenticated;
grant all on public.loans         to authenticated;
grant all on public.isbn_cache    to authenticated;
grant all on public.user_settings to authenticated;
grant execute on function public.current_household_id() to authenticated;

-- ============================================================
-- LISTO. Verificar:
--   select * from public.households;       -- vacía hasta el primer signup
--   select * from auth.users;              -- vacía hasta el primer signup
-- Hacer signup desde la app y volver a chequear: deben aparecer
-- 1 user, 1 household, 1 member, 1 location.
-- ============================================================
