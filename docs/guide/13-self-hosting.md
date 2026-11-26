# 13 · Self-hosting

> Translated from docs/zh-CN/guide/13-self-hosting.md, updated in the same commit as this file.
> The Chinese edition is authoritative; where the two differ, the Chinese one holds.

This chapter is for people who run saveslot server mode on their own servers: what to prepare, how to start it, how to create accounts, how agents connect, and what to watch for in backup and restore. Self-hosting and our cloud service are the same code and the same set of configuration items; the differences are in chapter 11, section 1.

Specification: [`../spec/02-architecture.md`](../spec/02-architecture.md) §9 "Tenants and hosting" (including "Prerequisites for self-hosting"); the commands and the configuration are in [`../spec/06-cli.md`](../spec/06-cli.md) §4.1 "Operations commands for self-hosted servers" and "Server mode configuration".

## 1. What to prepare

| What | Description |
|---|---|
| saveslot | `npm install -g @fluxvita/saveslot`, or pull the container image `ghcr.io/fluxvita/saveslot:<version>` (linux/amd64 and linux/arm64, published with the npm packages for every version). The image starts as `saveslot server start`, listens on `0.0.0.0:8080` inside the container, and holds no key or password; [`deploy/compose.yaml`](../../deploy/compose.yaml) is an example of it running with PostgreSQL on one host (set its `image` to the version you use). To build the image yourself, use [`deploy/build-image.sh`](../../deploy/build-image.sh) |
| PostgreSQL 18 | One database per user, plus one control database (it stores accounts, credentials, the tenant catalog and the deletion register). Both can be on the same instance |
| A database role | See below |
| A public address | The HTTPS address that agents and the command line connect to, for example `https://saveslot.example.com`. TLS is handled by the reverse proxy in front of it; the saveslot process itself listens on plain HTTP |
| Outbound connections that can reach the public internet directly | Remote authorization has to fetch the client's document (for example ChatGPT's) from the client's own domain, and saveslot connects only to public addresses. Outbound traffic must not go through a proxy that resolves domain names to reserved addresses such as `198.18.x.x` (fake-IP mode); otherwise every such request is rejected |
| A place to keep keys | The handle signing key is a file that you look after; put it where only the user running saveslot can read it, or mount it in as a container secret |
| Backup | The control database and all tenant databases must be backed up together (section 5) |

### What privileges the database role needs

saveslot does not need a superuser. The role it uses must:

- Own the control database: `saveslot server init` creates tables in it.
- Have `CREATEDB` and be able to connect to the maintenance database (by default `postgres`): for every user created, saveslot creates one database on the instance, and that database is owned by it.

```sql
CREATE ROLE saveslot LOGIN CREATEDB PASSWORD '…';
CREATE DATABASE saveslot_control OWNER saveslot;
```

So some managed PostgreSQL services (database services from cloud vendors) cannot be used: ones that give you a single database and no `CREATEDB` are not supported in the first version.

**Plaintext left behind after a deletion needs four more grants.** After a privacy deletion comes due, saveslot has to make sure the deleted plaintext cannot be found in the database files either (including the write-ahead log). The fastest way is to clean in place; it needs a few more grants for this role, and the instance must also turn off reuse of write-ahead log segments:

```sql
GRANT pg_maintain TO saveslot;
GRANT pg_checkpoint TO saveslot;
GRANT EXECUTE ON FUNCTION pg_switch_wal() TO saveslot;
-- Run as a superuser (or write it into postgresql.conf directly), then reload the configuration:
ALTER SYSTEM SET wal_recycle = off;
SELECT pg_reload_conf();
```

If any one of them is missing, saveslot can still erase everything, but it uses a rebuild instead: it replays this user's log into a new database and then replaces the old one. A rebuild is much slower, and this user's data cannot be written while it runs. saveslot checks these items at startup, and `saveslot doctor` states which method is in use and which item is missing. Managed PostgreSQL (database services from cloud vendors) mostly cannot give these grants, in which case it is a rebuild. These steps act on the whole instance: switching log segments and checkpoints affect other databases on the same instance.

## 2. Configuration

Server mode reads only environment variables; it does not read the `config.toml` of local mode.

| Variable | Content | Example |
|---|---|---|
| `SAVESLOT_CONTROL_DATABASE_URL` | The control database | `postgres://saveslot@db:5432/saveslot_control` |
| `SAVESLOT_CELL_DATABASE_URL` | The instance that holds the tenant databases; the database name is the maintenance database | `postgres://saveslot@db:5432/postgres` |
| `SAVESLOT_PUBLIC_URL` | The public address: `https://`, with no path and no trailing `/` (`http://` is allowed only for a trial run on the local machine where the host is a loopback address) | `https://saveslot.example.com` |
| `SAVESLOT_HANDLE_KEY_FILE` | The file of the handle signing key: `server init` generates it, and after that saveslot only reads it and never writes it | `/run/secrets/saveslot-handle-key` |
| `SAVESLOT_LISTEN` | The listen address, default `127.0.0.1:8080` | `0.0.0.0:8080` (inside a container) |
| `SAVESLOT_TRUSTED_PROXIES` | The addresses or ranges of your reverse proxy, comma-separated | `127.0.0.1`; `10.0.8.0/24` |
| `SAVESLOT_ALLOWED_ORIGINS` | The web origins that may call the HTTP interface directly from a browser, comma-separated; the default is empty, which allows no web page to make cross-origin calls (`/mcp` never allows them) | `https://console.example.com` |

**By default saveslot listens only on the local loopback address.** It speaks only plain HTTP: if it listened on all network interfaces by default, anyone following the documentation to start an instance with no firewall could capture tokens in plaintext from the network. When the reverse proxy and saveslot are on the same machine, the loopback address is exactly enough. When running in a container, the reverse proxy is outside the container: write `SAVESLOT_LISTEN` explicitly as `0.0.0.0:8080`, and then hand only this port to the reverse proxy (for example, map it only to `127.0.0.1` of the host).

**In a production deployment, do not put origins such as `http://localhost` in `SAVESLOT_ALLOWED_ORIGINS`.** If you do, any web page under development on the local machine can call the interface across origins (although a token is still required).

**Set `SAVESLOT_TRUSTED_PROXIES` for the reverse proxy.** saveslot sees only the reverse proxy connecting to it; where a request really came from depends on the address the proxy writes into `X-Forwarded-For`, and saveslot trusts this header only when the connection comes from a proxy listed here. If it is not set, every request looks to saveslot as if it came from the single address of the proxy: when one person mistypes a password a few times, the login failure limit, which counts by source, blocks everyone.

When the proxy's address changes within a subnet, or there is a CDN in front of it, write ranges in the list: the subnet of the load balancer, and the egress ranges the CDN publishes. **The list must hold only your own proxies.** Any address inside the list can connect to saveslot directly and write `X-Forwarded-For` itself, posing as any source; so nothing else that can reach saveslot may be in those subnets. saveslot does not accept an entry such as `0.0.0.0/0` that covers every address.

**Keep the list up to date with the egress ranges the CDN publishes.** A CDN's egress ranges change; when the list has not caught up, requests from a new egress are no longer skipped, and their source is taken to be that egress's address. This errs on the safe side (the source cannot be forged this way), but the users behind one egress share one allowance counted by source: failed logins and tries on the device code page are counted together.

Rate limiting is off by default in self-hosting. To limit by user, set `SAVESLOT_RATE_LIMIT` (requests per minute for each user); you can also set `SAVESLOT_RATE_BURST` (the most requests that can be sent in a row at one time; by default equal to the former).

**When exposed publicly, add a per-source rate limit on the reverse proxy for the endpoints under `/oauth/` and for the login page.** `SAVESLOT_RATE_LIMIT` counts per tenant and only covers requests that carry a token; these addresses can be reached without a token, so it does not cover them.

Self-hosting logs in with the built-in local accounts, and the three variables `SAVESLOT_IDENTITY_ISSUER`, `SAVESLOT_IDENTITY_LOGIN_URL` and `SAVESLOT_IDENTITY_KEYS_FILE` do not need to be set: they are for our cloud service to connect to its own account system (external login). Either all three are set or none is; if only some are set, saveslot refuses to start and does not quietly fall back to local accounts.

It is best to supply the password in the connection string through the PostgreSQL password file (`.pgpass`) or a container secret, rather than writing it into the variable itself.

**The handle signing key** is written by `server init` to the location that `SAVESLOT_HANDLE_KEY_FILE` points to (that directory must already exist), and after that saveslot only reads it, so it can be mounted read-only. saveslot does not rotate it by itself; to change it, replace the file and restart, and the handles issued before the change, such as paging handles and deletion confirmations, become invalid with it; callers only need to fetch them again.

When mounting, mind the permissions: saveslot refuses a key file that is open to "others". The secret volume of Kubernetes defaults to 0644 and is refused, so set `defaultMode` to 0440 (and configure `fsGroup` when the user inside the container cannot read it); Docker secrets follow the permissions of that file on the host, so set it to 0600 or 0640 on the host.

**Point health checks at `/ready`.** The load balancer's health check and the container's readiness probe both ask `GET /ready` (no token needed): it answers 200 when the process is ready, and 503 while it is starting, stopping or has failed. The image's own health check already points at it. `/health` answers 200 in every state and reports the state only in its body, so it is not meant for a load balancer.

**Give stopping enough time.** After a stop signal, saveslot first serves as usual for `SAVESLOT_SHUTDOWN_DRAIN` seconds (10 by default), so that the load balancer takes it out; then it waits for the requests in progress to finish, for at most `SAVESLOT_SHUTDOWN_TIMEOUT` seconds (30 by default); last, it takes at most 10 seconds to close the tenants and release the lock. The container's termination grace period should be no shorter than the sum of the three: Kubernetes defaults `terminationGracePeriodSeconds` to 30 seconds, so with the defaults set it to 50 or more; `docker stop` waits only 10 seconds by default, so lengthen it with compose's `stop_grace_period` (already set in [`deploy/compose.yaml`](../../deploy/compose.yaml)). When the grace period runs out the process is killed, and the read records not yet written are lost with it.

**Update by stopping first, then starting.** Only one server process can run on a control database at a time: a new process cannot start until the old one has released the "server is running" lock, and when it cannot take the lock it exits with code 7, for the process manager to start it again. So update by stopping the old process before starting the new one (`Recreate` on Kubernetes), not with a rolling update.

**Make sure the database has enough connections.** Each open tenant takes one database connection; a process has at most `SAVESLOT_TENANT_CONNECTIONS` open at once (50 by default), and a tenant idle for `SAVESLOT_TENANT_IDLE` seconds (300 by default) is closed. When the limit is reached, the tenant idle for longest is closed first; with none idle, a request waits a little, and one that gets no place is answered "busy for now, retry shortly". Each process also uses 3 connections the limit does not count (the control database, creating a tenant, creating or dropping a database), and each import in progress uses 2 more. So it must hold that:

`SAVESLOT_TENANT_CONNECTIONS × processes + 3 × processes + imports at the same time × 2 ≤ connections available`

The connections available are PostgreSQL's `max_connections` less `superuser_reserved_connections`, `reserved_connections` and what you use for operations yourself. The default `max_connections` is 100, enough for one process with the defaults; with many users, raise `max_connections` before raising the limit.

## 3. Initialization and accounts

```
$ saveslot server init --user alice
```

It creates the tables of the control database, generates the handle signing key, and creates the first account and its data. The password is read from the terminal (not echoed, entered twice); when there is no terminal, use `--password-file <path>`, which takes the first line of the file; the file must be a regular file with no permissions for others at all (for example `chmod 600`). A password is not accepted as a command-line argument: arguments end up in the shell history and the process list. Running it again is safe: steps already done are not done again.

Accounts are managed by you with commands, and saveslot does not open registration:

| To do what | Command |
|---|---|
| Add an account (this also creates a separate set of data for it) | `saveslot server user add <name>` |
| List accounts: name, status, tenant ID (used when restoring a tenant in section 5) | `saveslot server user list` |
| Disable an account: while it is disabled, its login and all the connections it issued to agents cannot be used; the data is untouched, and nothing is revoked | `saveslot server user disable <name>` |
| Enable it again: login and connections are restored as they were | `saveslot server user enable <name>` |
| Change the password: its existing logins and user sessions are invalidated immediately; the connections it issued to agents are not affected | `saveslot server user passwd <name>` |

## 4. Connecting agents and the command line

A person logs in on their own computer with `saveslot login --server <public address>`; the commands after that are the same as in local mode, with `--profile` added to point at this server (chapter 11, section 3). An agent's host goes through remote MCP, at the address `<public address>/mcp`, and authorization goes through OAuth (chapter 11, section 2, "Connecting in server mode").

## 5. Backup and restore

- **What to back up together**: the control database, and all the tenant databases. The control database holds the deletion register and the high-water marks: when an older tenant database is restored, the restore procedure must use them to delete again what was deleted after the backup (chapter 11, section 6, "Why you must go through the restore procedure after a restore"). This version cannot yet do this step: when the deletion register has an entry for a tenant, `server restore` refuses to restore that tenant and changes nothing (exit code 5).
- **Restoring one tenant**: first stop the server; put back from the backup only this tenant's database, and **do not put back the control database**; run `saveslot server restore --tenant <tenant>` (with local accounts you can write `--user <account name>` instead, without looking up the tenant ID first); then start the server. While the server is running this command does nothing. If a database was swapped without going through this command, saveslot notices when it opens it, refuses to serve, and prompts you to run this command.
- **The control database is lost too**: it can only be put back from backup together with the tenant databases; this is disaster recovery: the changes to the deletion register, accounts and credentials since the backup are lost with it, and the restore procedure cannot make them up. So the control database should be backed up more often and stored more safely than the tenant databases.
