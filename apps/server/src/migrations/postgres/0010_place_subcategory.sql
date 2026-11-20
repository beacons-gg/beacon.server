-- 0010_place_subcategory (postgres) — the finer place descriptor under a category (`wildlife` → zoo
-- vs aquarium; `apps/atlas/doc/spec/cartographer.md` §1.1). Nullable: list imports and
-- admin-created places may not carry one; connectors always set it from the taxonomy.
ALTER TABLE places ADD COLUMN subcategory TEXT;
