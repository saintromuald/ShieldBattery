-- Brand only the official channel created by the upstream schema, leaving renamed or custom
-- channels untouched.
UPDATE channels
SET name = 'HyperShield'
WHERE id = 1 AND official = TRUE AND name = 'ShieldBattery';

-- The historical import uses these fixed IDs with no local author. Remove only those imported
-- release posts so this custom service does not present another product's history as its own.
DELETE FROM news_posts
WHERE author_id IS NULL
  AND id IN (
    '5eed0000-0000-0000-0000-000000000001',
    '5eed0000-0000-0000-0000-000000000002',
    '5eed0000-0000-0000-0000-000000000003',
    '5eed0000-0000-0000-0000-000000000004',
    '5eed0000-0000-0000-0000-000000000005',
    '5eed0000-0000-0000-0000-000000000006',
    '5eed0000-0000-0000-0000-000000000007',
    '5eed0000-0000-0000-0000-000000000008',
    '5eed0000-0000-0000-0000-000000000009',
    '5eed0000-0000-0000-0000-000000000010',
    '5eed0000-0000-0000-0000-000000000011',
    '5eed0000-0000-0000-0000-000000000012',
    '5eed0000-0000-0000-0000-000000000013',
    '5eed0000-0000-0000-0000-000000000014',
    '5eed0000-0000-0000-0000-000000000015',
    '5eed0000-0000-0000-0000-000000000016',
    '5eed0000-0000-0000-0000-000000000017',
    '5eed0000-0000-0000-0000-000000000018',
    '5eed0000-0000-0000-0000-000000000019',
    '5eed0000-0000-0000-0000-000000000020',
    '5eed0000-0000-0000-0000-000000000021',
    '5eed0000-0000-0000-0000-000000000022',
    '5eed0000-0000-0000-0000-000000000023'
  );

INSERT INTO news_posts
  (id, author_id, cover_image_path, title, summary, content, published_at, updated_at)
VALUES (
  '68797065-7265-4000-8000-000000000001',
  NULL,
  NULL,
  'Welcome to HyperShield',
  'A community test service for StarCraft: Brood War.',
  $post$HyperShield is a community TEST SERVICE for StarCraft: Brood War.

Use the official HyperShield channel to meet other testers, and the in-app reporting tools to
share bugs or moderation concerns. Features and stored test data may change as development
continues.$post$,
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;
