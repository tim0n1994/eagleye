-- Deduplicate existing entity collisions before adding UNIQUE constraint

-- Step 1: Find duplicate (name, type) pairs, keep the one with most graph edges (oldest id as tiebreaker)
CREATE TEMP TABLE IF NOT EXISTS _entity_dedup AS
SELECT name, type,
       (SELECT e2.id FROM entities e2
        WHERE e2.name = e1.name AND e2.type = e1.type
        ORDER BY (SELECT COUNT(*) FROM graph_edges WHERE to_type = 'entity' AND to_id = e2.id) DESC, e2.id ASC
        LIMIT 1) AS keep_id
FROM entities e1
WHERE (name, type) IN (
  SELECT name, type FROM entities GROUP BY name, type HAVING COUNT(*) > 1
)
GROUP BY name, type;

-- Step 2: Reassign graph edges from duplicate entities to the kept one
UPDATE graph_edges SET to_id = (
  SELECT keep_id FROM _entity_dedup d
  WHERE d.name = (SELECT name FROM entities WHERE id = graph_edges.to_id)
    AND d.type = (SELECT type FROM entities WHERE id = graph_edges.to_id)
)
WHERE to_type = 'entity'
  AND to_id IN (SELECT id FROM entities e WHERE EXISTS (
    SELECT 1 FROM _entity_dedup d WHERE d.name = e.name AND d.type = e.type AND d.keep_id != e.id
  ));

-- Step 3: Delete duplicate entities (keeping only the designated keep_id)
DELETE FROM entities WHERE id IN (
  SELECT e.id FROM entities e
  INNER JOIN _entity_dedup d ON d.name = e.name AND d.type = e.type
  WHERE e.id != d.keep_id
);

DROP TABLE IF EXISTS _entity_dedup;

-- Step 4: Add the unique constraint
DROP INDEX IF EXISTS idx_entities_name;
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_name_type ON entities(name COLLATE NOCASE, type);
