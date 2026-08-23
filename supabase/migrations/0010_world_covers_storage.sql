-- Storage for world cover art.
--
-- Supabase-only, like 0002. Worlds are becoming first-class public objects
-- with their own page, so their covers get their own bucket rather than
-- borrowing the character one — a world outlives any single character that
-- references it.
--
-- Public-read for the same reason as the avatar buckets: a published world has
-- to render its cover for people who do not own it, and confidentiality comes
-- from the database rows, not the image bytes. Writes stay owner-only through
-- the `users/{user_id}/...` path prefix.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('world-covers', 'world-covers', true, 5242880, ARRAY['image/png','image/jpeg','image/webp','image/gif'])
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Afterglow world covers are readable" ON storage.objects;
CREATE POLICY "Afterglow world covers are readable" ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'world-covers');

DROP POLICY IF EXISTS "Afterglow world covers are owner writable" ON storage.objects;
CREATE POLICY "Afterglow world covers are owner writable" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'world-covers'
    AND (storage.foldername(name))[1] = 'users'
    AND (storage.foldername(name))[2] = auth.uid()::text
  );

DROP POLICY IF EXISTS "Afterglow world covers are owner updatable" ON storage.objects;
CREATE POLICY "Afterglow world covers are owner updatable" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'world-covers'
    AND (storage.foldername(name))[1] = 'users'
    AND (storage.foldername(name))[2] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'world-covers'
    AND (storage.foldername(name))[1] = 'users'
    AND (storage.foldername(name))[2] = auth.uid()::text
  );

DROP POLICY IF EXISTS "Afterglow world covers are owner deletable" ON storage.objects;
CREATE POLICY "Afterglow world covers are owner deletable" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'world-covers'
    AND (storage.foldername(name))[1] = 'users'
    AND (storage.foldername(name))[2] = auth.uid()::text
  );
