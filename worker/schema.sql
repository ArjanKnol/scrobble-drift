-- Shared MusicBrainz answer cache.
--
-- Why this exists: MusicBrainz allows one request per second per application and
-- blocks IPs that exceed it. Cloudflare's edge cache already helped, but it is
-- per LOCATION, so the same artist could still be fetched once per datacentre,
-- and it does nothing about the rate when the requests are for different artists.
--
-- This is global and persistent. An artist any visitor has ever looked up is
-- never fetched again while the row is fresh. Listening is heavily power-law
-- distributed, so the hit rate climbs steeply with traffic: the busier the site
-- gets, the LESS load it puts on MusicBrainz per user, which is the opposite of
-- how it behaved before.
--
--   npx wrangler d1 execute scrobble-drift-cache --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS mb_cache (
  -- Route prefix plus normalised arguments, e.g. "cat:<mbid>:0" or
  -- "aid:playboi carti". Normalised so trivial spelling differences share a row.
  k       TEXT    PRIMARY KEY,

  -- The response body as JSON. Storing the SHAPED answer rather than the raw
  -- MusicBrainz payload keeps rows small and means a cache hit costs no parsing
  -- work beyond JSON.parse.
  v       TEXT    NOT NULL,

  -- Epoch seconds. Freshness is checked in the query rather than by deleting
  -- expired rows, so a read never needs a write and the daily write budget is
  -- spent only on genuinely new answers.
  created INTEGER NOT NULL
) STRICT;

-- Supports the eviction sweep below. The primary key already covers lookups.
CREATE INDEX IF NOT EXISTS mb_cache_created ON mb_cache (created);

-- Housekeeping, if the table ever approaches the 5 GB free-tier limit. Not
-- automated: at a few KB per row that limit is hundreds of thousands of artists
-- away, and a scheduled job that deletes rows would spend write budget to solve
-- a problem this project does not have yet.
--
--   DELETE FROM mb_cache WHERE created < unixepoch() - 60*60*24*180;
