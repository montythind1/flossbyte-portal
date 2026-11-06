-- People get their own phone number (the customers and locations phones
-- in 0001 belong to the practice, not the person). Shown on admin and
-- team lists; editable by the person under Account & security.
ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT '';
