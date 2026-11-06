-- The "customer" role (accounts that only see assigned websites) was removed. Existing customer accounts are switched off, not
-- deleted and not converted: a converted account would suddenly see every website. An administrator can delete them or give
-- them one of the remaining roles. The role value stays in the column so that this migration cannot fail on existing rows;
-- accounts with it cannot sign in.
UPDATE users SET active = 0 WHERE role = 'customer';
DROP TABLE IF EXISTS site_access;
