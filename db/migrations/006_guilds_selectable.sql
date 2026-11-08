-- Milestone 5: per-server configuration for the Discord app, and which regions a server may pick.

create table guild_configs (
  guild_id          text primary key,
  region_id         text not null default 'global' references regions (id),
  channel_id        text,
  last_posted_month date,   -- first day of the last month whose report was posted
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Selectable regions appear in /region set. Seeds are selectable; scripts/regions.ts sets the flag on
-- auto rows (every country; admin-1 groups only in ES, IT, GB, FR, PT; admin-1 units only in US, CA, DE, AU).
alter table regions add column selectable boolean not null default false;
update regions set selectable = true where source = 'seed';
