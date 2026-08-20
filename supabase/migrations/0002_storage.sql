-- Afterglow storage buckets and policies.
--
-- Supabase-only: this file touches the `storage` schema and is skipped by the
-- local isolation tests, which run against a plain PostgreSQL.
--
-- Both buckets are public-read on purpose. A published character has to render
-- its portrait for people who do not own it, and signed URLs would defeat CDN
-- caching for every avatar in the library. Confidentiality comes from the
-- database rows, not from the image bytes; writes stay owner-only.
--
-- Object paths are always `users/{user_id}/...`, so the owner check is a path
-- prefix comparison and one account can never address another account's files.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('profile-avatars', 'profile-avatars', true, 2621440, ARRAY['image/png','image/jpeg','image/webp','image/gif']),
  ('character-avatars', 'character-avatars', true, 5242880, ARRAY['image/png','image/jpeg','image/webp','image/gif'])
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Read -----------------------------------------------------------------------
DROP POLICY IF EXISTS "Afterglow avatars are readable" ON storage.objects;
CREATE POLICY "Afterglow avatars are readable" ON storage.objects
  FOR SELECT TO public
  USING (bucket_id IN ('profile-avatars', 'character-avatars'));

-- Write ----------------------------------------------------------------------
-- `storage.foldername(name)` splits the object path; element 1 is `users` and
-- element 2 is the account UUID that owns the folder.
DROP POLICY IF EXISTS "Afterglow avatars are owner writable" ON storage.objects;
CREATE POLICY "Afterglow avatars are owner writable" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id IN ('profile-avatars', 'character-avatars')
    AND (storage.foldername(name))[1] = 'users'
    AND (storage.foldername(name))[2] = auth.uid()::text
  );

DROP POLICY IF EXISTS "Afterglow avatars are owner updatable" ON storage.objects;
CREATE POLICY "Afterglow avatars are owner updatable" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id IN ('profile-avatars', 'character-avatars')
    AND (storage.foldername(name))[1] = 'users'
    AND (storage.foldername(name))[2] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id IN ('profile-avatars', 'character-avatars')
    AND (storage.foldername(name))[1] = 'users'
    AND (storage.foldername(name))[2] = auth.uid()::text
  );

DROP POLICY IF EXISTS "Afterglow avatars are owner deletable" ON storage.objects;
CREATE POLICY "Afterglow avatars are owner deletable" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id IN ('profile-avatars', 'character-avatars')
    AND (storage.foldername(name))[1] = 'users'
    AND (storage.foldername(name))[2] = auth.uid()::text
  );
