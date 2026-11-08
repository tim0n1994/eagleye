-- The SEC connector exists in the registry, but some established databases
-- never received its original seed. This host currently receives HTTP 403
-- from SEC, so a new entry starts inactive until its operator has configured
-- a valid SEC identity and working egress. Preserve existing choices.
INSERT OR IGNORE INTO sources
  (id, slug, label, description, homepage_url, feed_url, connector_type, is_active)
VALUES
  ('s-physical-ai-sec-8k', 'physical-ai-sec-8k', 'Physical AI — SEC 8-K',
   'SEC 8-K filings for semiconductor, robotics and photonics companies',
   'https://www.sec.gov', NULL, 'sec-8k', 0);
