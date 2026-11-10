-- no-transaction

-- Enum values added inside a transaction cannot be used until that transaction commits.
ALTER TYPE public.map_visibility ADD VALUE IF NOT EXISTS 'UNOFFICIAL';
