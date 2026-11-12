-- Color identity of commanders, for the color squares next to commander names in the monthly post.
-- Decoration only: no stat function, view or existing table changes, and no stat reads these.
-- Filled by scripts/fetch-color-identity.ts from Scryfall's card search (CLAUDE.md data-source exception):
-- names and color identity only, no images and no image URLs. The bot and the Vercel app read this table and
-- never call Scryfall.

-- One row per name a commander can be written as (the card's Oracle name and each face of a "Front // Back"
-- card). colors is the card's color identity as a subset of WUBRG in that order; '' is colorless.
create table commander_colors (
  name_key   text primary key,
  name       text not null,
  card_name  text not null,
  colors     text not null,
  fetched_at timestamptz not null default now(),
  constraint commander_colors_key_matches check (name_key = card_name_key(name)),
  constraint commander_colors_wubrg check (colors ~ '^W?U?B?R?G?$')
);

-- The color identity of a registered leader: one card, or a pair written "A / B" (the union of both halves).
-- Each half is looked up on card_name_key, so typographic apostrophes match. A half that is not a card name
-- here is tried as a printed or flavor name of a pair card ("Will the Wise" is Wernog, Rider's Chaplain),
-- which pair_commanders already stores. Null when any half has no match (the post then shows no squares),
-- '' when every half is colorless.
create function commander_color_identity(p_leader text)
returns text
language sql stable parallel safe as $$
  with found as (
    select coalesce(
      (select c.colors from commander_colors c where c.name_key = card_name_key(h.half)),
      (select c.colors
       from pair_commanders p
       join commander_colors c on c.name_key = card_name_key(p.card_name)
       where p.name_key = card_name_key(h.half))
    ) as colors
    from unnest(string_to_array(p_leader, ' / ')) as h(half)
  )
  select case
    when not exists (select 1 from found) or exists (select 1 from found where colors is null) then null
    else coalesce(
      (select string_agg(x.letter, '' order by x.ord)
       from unnest(array['W', 'U', 'B', 'R', 'G']) with ordinality as x(letter, ord)
       where exists (select 1 from found f where position(x.letter in f.colors) > 0)),
      '')
  end
$$;
