ALTER TABLE scenarios ADD COLUMN brand TEXT;
ALTER TABLE scenarios ADD COLUMN type TEXT;

CREATE INDEX idx_scenarios_brand ON scenarios(brand);
CREATE INDEX idx_scenarios_type ON scenarios(type);
