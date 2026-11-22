#!/bin/sh
# Run once by the postgres image on an empty data directory: the role saveslot runs as, no superuser
# (02-architecture §9 «自部署的前提»): owner of the control database, CREATEDB for the tenants'
# databases. Its password is the secret's.
#
# Then what the in-place clean-up of plaintext residue needs (02-architecture §7 «残留清理在
# PostgreSQL 上需要的权限»): the three grants, and the instance run with wal_recycle = off. This
# script runs as the image's superuser, so it sets that itself (kept in postgresql.auto.conf, read at
# every start). Without any of them saveslot still removes the residue, by rebuilding the tenant's
# database instead (§7 «残留清理的做法»).
set -eu
password=$(cat /run/secrets/saveslot-db-password)
psql -v ON_ERROR_STOP=1 -v pw="$password" --username "$POSTGRES_USER" --dbname postgres <<'SQL'
CREATE ROLE saveslot LOGIN CREATEDB PASSWORD :'pw';
CREATE DATABASE saveslot_control OWNER saveslot;
GRANT pg_maintain TO saveslot;
GRANT pg_checkpoint TO saveslot;
GRANT EXECUTE ON FUNCTION pg_switch_wal() TO saveslot;
ALTER SYSTEM SET wal_recycle = off;
SQL
