-- Keep stage progress visible after navigation and recover partial drafts on restart.
ALTER TABLE publishing_drafts ADD COLUMN generation_stage TEXT NOT NULL DEFAULT ''
  CHECK (generation_stage IN ('', 'writing', 'illustrating', 'image_failed'));
