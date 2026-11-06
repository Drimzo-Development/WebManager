-- Optional custom nginx.conf for static/php websites (NULL = managed default template)
ALTER TABLE sites ADD COLUMN webserver_conf MEDIUMTEXT NULL AFTER build_command;
