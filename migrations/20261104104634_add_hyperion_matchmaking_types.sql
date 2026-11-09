-- no-transaction

-- Independent Hyperion ladder identities. Rule 3 remains present for typed records and MMR,
-- but is hard-disabled in the shared matchmaking registry and is never queueable.

ALTER TYPE public.matchmaking_type ADD VALUE IF NOT EXISTS 'hyperion1v1rule1';
ALTER TYPE public.matchmaking_type ADD VALUE IF NOT EXISTS 'hyperion1v1rule2';
ALTER TYPE public.matchmaking_type ADD VALUE IF NOT EXISTS 'hyperion1v1rule3';
ALTER TYPE public.matchmaking_type ADD VALUE IF NOT EXISTS 'hyperion2v2rule1';
ALTER TYPE public.matchmaking_type ADD VALUE IF NOT EXISTS 'hyperion2v2rule2';
ALTER TYPE public.matchmaking_type ADD VALUE IF NOT EXISTS 'hyperion3v3rule1';
ALTER TYPE public.matchmaking_type ADD VALUE IF NOT EXISTS 'hyperion3v3rule2';
