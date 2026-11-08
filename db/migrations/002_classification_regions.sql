-- Milestone 2: event classification, offline reverse geocoding, and regions.

-- Event class, written by scripts/classify.ts.
alter table tournaments
  add column event_class     text check (event_class in ('cedh', 'casual', 'unlabeled_competitive', 'unlabeled_casual', 'test')),
  add column series_key      text,
  add column leader_coverage double precision;

-- Reverse geocoding from lat/lng, written by scripts/geocode.ts. Location strings are not used for regions.
alter table tournaments
  add column geo_country_code      text,   -- ISO 3166-1 alpha-2
  add column geo_country_name      text,
  add column geo_admin1_code       text,   -- ISO 3166-2, e.g. US-WA
  add column geo_admin1_name       text,
  add column geo_admin1_group_code text,   -- <ISO2>-<SLUG> of Natural Earth's grouping level, e.g. ES-CATALUNA
  add column geo_admin1_group_name text,
  add column geo_source            text check (geo_source in ('exact', 'nearby', 'unmatched')),
  add column geo_checked_at        timestamptz;

create index tournaments_geo_idx on tournaments (geo_country_code, geo_admin1_code, start_date);
create index tournaments_geo_group_idx on tournaments (geo_country_code, geo_admin1_group_code, start_date);
create index tournaments_series_key_idx on tournaments (series_key);

-- Manual class decisions per series; these win over the computed class.
create table series_overrides (
  series_key  text primary key,
  event_class text not null check (event_class in ('cedh', 'casual', 'unlabeled_competitive', 'unlabeled_casual', 'test')),
  note        text
);

create table regions (
  id           text primary key,   -- stable slug used in configs, e.g. pacific-northwest
  display_name text not null,
  type         text not null check (type in ('global', 'macro', 'country', 'admin1', 'custom'))
);

-- A member is a whole country (no admin-1 columns), one admin-1 unit, or one admin-1 group.
-- The global region has no members and matches every tournament.
create table region_members (
  id                bigint generated always as identity primary key,
  region_id         text not null references regions (id) on delete cascade,
  country_code      text not null check (country_code ~ '^[A-Z]{2}$'),
  admin1_code       text check (admin1_code like country_code || '-%'),
  admin1_group_code text check (admin1_group_code like country_code || '-%'),
  check (admin1_code is null or admin1_group_code is null)
);
create unique index region_members_unique_idx
  on region_members (region_id, country_code, coalesce(admin1_code, ''), coalesce(admin1_group_code, ''));

insert into regions (id, display_name, type) values
  ('global', 'Global', 'global'),
  ('north-america', 'North America', 'macro'),
  ('south-america', 'South America', 'macro'),
  ('europe', 'Europe', 'macro'),
  ('asia', 'Asia', 'macro'),
  ('oceania', 'Oceania', 'macro'),
  ('pacific-northwest', 'Pacific Northwest', 'custom');

-- Macro membership follows the UN M49 geoscheme. North America = Northern America + Central America +
-- Caribbean. Europe includes Russia; Asia includes Turkey and Cyprus. Africa is not seeded.
insert into region_members (region_id, country_code)
select r, unnest(c) from (values
  ('north-america', array['US','CA','MX','GL','BM','PM','BZ','CR','SV','GT','HN','NI','PA',
    'AG','AI','AW','BB','BL','BQ','BS','CU','CW','DM','DO','GD','GP','HT','JM','KN','KY','LC','MF','MQ','MS',
    'PR','SX','TC','TT','VC','VG','VI']),
  ('south-america', array['AR','BO','BR','CL','CO','EC','FK','GF','GY','PE','PY','SR','UY','VE']),
  ('europe', array['AD','AL','AT','AX','BA','BE','BG','BY','CH','CZ','DE','DK','EE','ES','FI','FO','FR','GB','GG',
    'GI','GR','HR','HU','IE','IM','IS','IT','JE','LI','LT','LU','LV','MC','MD','ME','MK','MT','NL','NO','PL','PT',
    'RO','RS','RU','SE','SI','SJ','SK','SM','UA','VA','XK']),
  ('asia', array['AE','AF','AM','AZ','BD','BH','BN','BT','CN','CY','GE','HK','ID','IL','IN','IQ','IR','JO','JP','KG',
    'KH','KP','KR','KW','KZ','LA','LB','LK','MM','MN','MO','MV','MY','NP','OM','PH','PK','PS','QA','SA','SG','SY',
    'TH','TJ','TL','TM','TR','TW','UZ','VN','YE']),
  ('oceania', array['AS','AU','CK','FJ','FM','GU','KI','MH','MP','NC','NF','NR','NU','NZ','PF','PG','PN','PW','SB',
    'TK','TO','TV','VU','WF','WS'])
) as m(r, c);

insert into region_members (region_id, country_code, admin1_code) values
  ('pacific-northwest', 'US', 'US-WA'),
  ('pacific-northwest', 'US', 'US-OR'),
  ('pacific-northwest', 'US', 'US-ID'),
  ('pacific-northwest', 'CA', 'CA-BC');

-- Entries that count toward stats: events with 16+ players classed cedh or unlabeled_competitive.
-- TODO: validate partner combos ("A / B" leaders) against Scryfall pair-commander rules. Not built yet,
-- and fetching Scryfall would need its own exception to the CLAUDE.md data-source rule.
create view qualifying_entries as
select
  e.*,
  t.start_date,
  t.participant_count,
  t.top_cut,
  t.event_class,
  t.series_key,
  t.leader_coverage,
  t.geo_country_code,
  t.geo_admin1_code,
  t.geo_admin1_group_code
from entries e
join tournaments t on t.tid = e.tid
where t.participant_count >= 16
  and t.event_class in ('cedh', 'unlabeled_competitive');
