-- Adds the 'laravel' application type
ALTER TABLE sites MODIFY type ENUM('static','php','laravel','node','express','next','custom') NOT NULL;
