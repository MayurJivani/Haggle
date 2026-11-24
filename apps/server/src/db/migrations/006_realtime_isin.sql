-- Tradegate quotes by ISIN, so instruments listed there carry one.
ALTER TABLE rt_instruments ADD COLUMN isin text;
