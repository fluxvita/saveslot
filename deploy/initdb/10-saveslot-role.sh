#!/bin/sh
# Run once by the postgres image on an empty data directory: the role saveslot runs as, no superuser
# (02-architecture §9 «自部署的前提»): owner of the control database, CREATEDB for the tenants'
# databases. Its password is the secret's.
set -eu
password=$(cat /run/secrets/saveslot-db-password)
psql -v ON_ERROR_STOP=1 -v pw="$password" --username "$POSTGRES_USER" --dbname postgres <<'SQL'
CREATE ROLE saveslot LOGIN CREATEDB PASSWORD :'pw';
CREATE DATABASE saveslot_control OWNER saveslot;
SQL
