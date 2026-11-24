--
-- PostgreSQL database dump
--

\restrict ITujOxSXKBXhigLIkxmMXz8GUlD3hrnqR5Hw4eJpDy33jln8K530BvPI0VpyP1u

-- Dumped from database version 18.7 (Homebrew)
-- Dumped by pg_dump version 18.7 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounts (
    id text NOT NULL,
    name text NOT NULL,
    password_hash text NOT NULL,
    state text NOT NULL,
    sessions_ended_at text,
    CONSTRAINT accounts_state_check CHECK ((state = ANY (ARRAY['active'::text, 'disabled'::text])))
);


--
-- Name: anchor_deletions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.anchor_deletions (
    tenant text NOT NULL,
    "position" integer NOT NULL,
    entry text NOT NULL
);


--
-- Name: anchors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.anchors (
    tenant text NOT NULL,
    high_water bigint NOT NULL,
    restore_count bigint NOT NULL,
    restore_id text,
    import_id text
);


--
-- Name: base_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.base_sources (
    event_seq bigint NOT NULL,
    row_id text NOT NULL COLLATE pg_catalog."C",
    field_id text NOT NULL COLLATE pg_catalog."C",
    k integer NOT NULL,
    n integer NOT NULL,
    source_kind text NOT NULL COLLATE pg_catalog."C",
    source_seq bigint,
    carried_event bigint,
    carried_field text COLLATE pg_catalog."C",
    carried_k integer,
    schema_const_sv integer,
    status text NOT NULL COLLATE pg_catalog."C",
    valid_from text COLLATE pg_catalog."C",
    valid_to text COLLATE pg_catalog."C",
    corroborated boolean DEFAULT false NOT NULL,
    corroboration_ends text COLLATE pg_catalog."C",
    reverted text COLLATE pg_catalog."C",
    given_seq bigint,
    given_path text COLLATE pg_catalog."C",
    CONSTRAINT base_sources_source_kind_check CHECK ((source_kind = ANY (ARRAY['value'::text, 'operation'::text, 'schema_const'::text, 'interval'::text])))
);


--
-- Name: block_deps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.block_deps (
    seq bigint NOT NULL,
    path text NOT NULL COLLATE pg_catalog."C",
    n integer NOT NULL,
    dep_event bigint NOT NULL,
    dep_field text NOT NULL COLLATE pg_catalog."C",
    dep_k integer NOT NULL,
    dep_kind text NOT NULL COLLATE pg_catalog."C",
    CONSTRAINT block_deps_dep_kind_check CHECK ((dep_kind = ANY (ARRAY['deps'::text, 'carried'::text])))
);


--
-- Name: catalog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.catalog (
    table_id text NOT NULL COLLATE pg_catalog."C",
    sv integer NOT NULL,
    slot_id text NOT NULL COLLATE pg_catalog."C",
    structure text NOT NULL COLLATE pg_catalog."C",
    profile text COLLATE pg_catalog."C",
    samples text COLLATE pg_catalog."C"
);


--
-- Name: content; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.content (
    seq bigint NOT NULL,
    path text NOT NULL COLLATE pg_catalog."C",
    body text COLLATE pg_catalog."C",
    checksum text COLLATE pg_catalog."C",
    removed_by bigint,
    key_id text COLLATE pg_catalog."C",
    placeholder_of bigint,
    CONSTRAINT content_check CHECK (((body IS NULL) = (checksum IS NULL))),
    CONSTRAINT content_check1 CHECK (((removed_by IS NULL) OR (body IS NULL))),
    CONSTRAINT content_check2 CHECK (((placeholder_of IS NULL) OR ((body IS NULL) AND (removed_by IS NULL))))
);


--
-- Name: control_meta; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.control_meta (
    key text NOT NULL,
    value text NOT NULL
);


--
-- Name: counts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.counts (
    table_id text NOT NULL COLLATE pg_catalog."C",
    partition_key text NOT NULL COLLATE pg_catalog."C",
    row_count bigint NOT NULL
);


--
-- Name: credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credentials (
    hash text NOT NULL,
    kind text NOT NULL,
    principal text NOT NULL,
    tenant text NOT NULL,
    expires_at text,
    grant_id text,
    CONSTRAINT credentials_kind_check CHECK ((kind = ANY (ARRAY['session'::text, 'connection'::text])))
);


--
-- Name: deletions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deletions (
    id text NOT NULL COLLATE pg_catalog."C",
    kind text NOT NULL COLLATE pg_catalog."C",
    state text NOT NULL COLLATE pg_catalog."C",
    due_at text NOT NULL COLLATE pg_catalog."C",
    confirmed_seq bigint NOT NULL,
    CONSTRAINT deletions_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'cancelled'::text, 'executed'::text])))
);


--
-- Name: derived_reads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.derived_reads (
    derived_seq bigint NOT NULL,
    base_table_id text NOT NULL COLLATE pg_catalog."C",
    partition_id text NOT NULL COLLATE pg_catalog."C",
    rule_version integer NOT NULL,
    read_pos bigint NOT NULL
);


--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events (
    seq bigint NOT NULL,
    header text NOT NULL COLLATE pg_catalog."C",
    header_hash text NOT NULL COLLATE pg_catalog."C",
    type text NOT NULL COLLATE pg_catalog."C",
    actor text NOT NULL COLLATE pg_catalog."C",
    at text NOT NULL COLLATE pg_catalog."C",
    op bigint NOT NULL,
    slot text COLLATE pg_catalog."C",
    target_table text COLLATE pg_catalog."C",
    target_row text COLLATE pg_catalog."C",
    target_event bigint,
    CONSTRAINT events_seq_check CHECK ((seq >= 1))
);


--
-- Name: external_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.external_keys (
    table_id text NOT NULL COLLATE pg_catalog."C",
    key_values text NOT NULL COLLATE pg_catalog."C",
    holder_row text NOT NULL COLLATE pg_catalog."C",
    yielded_row text COLLATE pg_catalog."C",
    state text NOT NULL COLLATE pg_catalog."C",
    frozen_by text COLLATE pg_catalog."C",
    CONSTRAINT external_keys_state_check CHECK ((state = ANY (ARRAY['present'::text, 'frozen'::text])))
);


--
-- Name: field_name_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.field_name_usage (
    actor text NOT NULL COLLATE pg_catalog."C",
    table_id text NOT NULL COLLATE pg_catalog."C",
    field_id text NOT NULL COLLATE pg_catalog."C",
    last_at text NOT NULL COLLATE pg_catalog."C",
    uses bigint NOT NULL
);


--
-- Name: flags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.flags (
    table_id text NOT NULL COLLATE pg_catalog."C",
    row_id text NOT NULL COLLATE pg_catalog."C",
    flag text NOT NULL COLLATE pg_catalog."C",
    item_id text NOT NULL COLLATE pg_catalog."C",
    fields text COLLATE pg_catalog."C",
    spans text COLLATE pg_catalog."C"
);


--
-- Name: last_read; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.last_read (
    actor text NOT NULL COLLATE pg_catalog."C",
    task text DEFAULT ''::text NOT NULL COLLATE pg_catalog."C",
    target text NOT NULL COLLATE pg_catalog."C",
    kind text NOT NULL COLLATE pg_catalog."C",
    op bigint NOT NULL,
    restore_count integer NOT NULL,
    read_id text NOT NULL COLLATE pg_catalog."C",
    CONSTRAINT last_read_kind_check CHECK ((kind = ANY (ARRAY['ver'::text, 'sv'::text, 'item'::text])))
);


--
-- Name: meta; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meta (
    key text NOT NULL COLLATE pg_catalog."C",
    value text NOT NULL COLLATE pg_catalog."C"
);


--
-- Name: migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.migrations (
    id text NOT NULL COLLATE pg_catalog."C",
    slot_id text NOT NULL COLLATE pg_catalog."C",
    draft_id text NOT NULL COLLATE pg_catalog."C",
    from_sv integer NOT NULL,
    target_sv integer NOT NULL,
    state text NOT NULL COLLATE pg_catalog."C"
);


--
-- Name: oauth_clients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_clients (
    client_id text NOT NULL,
    document bytea NOT NULL,
    fetched_at text NOT NULL,
    expires_at text NOT NULL
);


--
-- Name: oauth_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_codes (
    hash text NOT NULL,
    client_id text NOT NULL,
    redirect_uri text NOT NULL,
    code_challenge text NOT NULL,
    resource text NOT NULL,
    user_id text NOT NULL,
    login text NOT NULL,
    tenant text NOT NULL,
    requested_scopes text,
    scopes text NOT NULL,
    name text,
    expires_at text NOT NULL
);


--
-- Name: oauth_device_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_device_codes (
    device_hash text NOT NULL,
    user_code text NOT NULL,
    client_id text NOT NULL,
    resource text NOT NULL,
    state text NOT NULL,
    user_id text,
    login text,
    tenant text,
    expires_at text NOT NULL,
    interval_s integer NOT NULL,
    last_poll_at text,
    CONSTRAINT oauth_device_codes_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text])))
);


--
-- Name: oauth_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_grants (
    id text NOT NULL,
    kind text NOT NULL,
    principal text,
    tenant text NOT NULL,
    client_id text NOT NULL,
    resource text NOT NULL,
    created_at text NOT NULL,
    voided_at text,
    code_hash text,
    CONSTRAINT oauth_grants_kind_check CHECK ((kind = ANY (ARRAY['connection'::text, 'session'::text])))
);


--
-- Name: oauth_refresh_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_refresh_tokens (
    hash text NOT NULL,
    grant_id text NOT NULL,
    issued_at text NOT NULL,
    expires_at text NOT NULL,
    grant_expires_at text,
    replaced_by text
);


--
-- Name: partitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.partitions (
    derived_table_id text NOT NULL COLLATE pg_catalog."C",
    partition_id text NOT NULL COLLATE pg_catalog."C",
    group_key text COLLATE pg_catalog."C"
);


--
-- Name: pending_blocks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pending_blocks (
    seq bigint NOT NULL,
    path text NOT NULL COLLATE pg_catalog."C",
    deletion_seq bigint NOT NULL
);


--
-- Name: pending_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pending_entries (
    item_id text NOT NULL COLLATE pg_catalog."C",
    n integer NOT NULL,
    content_seq bigint NOT NULL,
    content_path text NOT NULL COLLATE pg_catalog."C"
);


--
-- Name: pending_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pending_items (
    id text NOT NULL COLLATE pg_catalog."C",
    type text NOT NULL COLLATE pg_catalog."C",
    slot_id text COLLATE pg_catalog."C",
    target_table text COLLATE pg_catalog."C",
    target_row text COLLATE pg_catalog."C",
    state text NOT NULL COLLATE pg_catalog."C",
    decision text COLLATE pg_catalog."C",
    version_op bigint NOT NULL
);


--
-- Name: possibly_affected; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.possibly_affected (
    read_id bigint NOT NULL,
    actor text NOT NULL COLLATE pg_catalog."C",
    since_op bigint NOT NULL
);


--
-- Name: premise_decls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.premise_decls (
    op bigint NOT NULL,
    op_index integer NOT NULL,
    decl_index integer NOT NULL,
    dep_table text NOT NULL COLLATE pg_catalog."C",
    dep_row text NOT NULL COLLATE pg_catalog."C",
    target_table text NOT NULL COLLATE pg_catalog."C",
    target_row text NOT NULL COLLATE pg_catalog."C",
    fields text COLLATE pg_catalog."C",
    range_kind text NOT NULL COLLATE pg_catalog."C",
    valid text COLLATE pg_catalog."C",
    seen_op bigint NOT NULL,
    seen_restore_count integer NOT NULL,
    state text NOT NULL COLLATE pg_catalog."C",
    reason text COLLATE pg_catalog."C",
    since bigint,
    declarer text NOT NULL COLLATE pg_catalog."C",
    CONSTRAINT premise_decls_range_kind_check CHECK ((range_kind = ANY (ARRAY['whole'::text, 'from_now'::text, 'row_time'::text, 'given'::text]))),
    CONSTRAINT premise_decls_state_check CHECK ((state = ANY (ARRAY['current'::text, 'changed'::text])))
);


--
-- Name: premise_edges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.premise_edges (
    item_event bigint NOT NULL,
    field_id text NOT NULL COLLATE pg_catalog."C",
    k integer NOT NULL,
    target text NOT NULL COLLATE pg_catalog."C",
    decl_op bigint NOT NULL,
    decl_op_index integer NOT NULL,
    decl_index integer
);


--
-- Name: principals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.principals (
    id text NOT NULL COLLATE pg_catalog."C",
    kind text NOT NULL COLLATE pg_catalog."C",
    name text COLLATE pg_catalog."C",
    scopes text COLLATE pg_catalog."C",
    slots text COLLATE pg_catalog."C",
    via text COLLATE pg_catalog."C",
    client text COLLATE pg_catalog."C",
    state text NOT NULL COLLATE pg_catalog."C",
    registered_seq bigint NOT NULL,
    CONSTRAINT principals_kind_check CHECK ((kind = ANY (ARRAY['user'::text, 'connection'::text, 'system'::text]))),
    CONSTRAINT principals_state_check CHECK ((state = ANY (ARRAY['active'::text, 'revoked'::text, 'disabled'::text])))
);


--
-- Name: read_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.read_log (
    read_id text NOT NULL COLLATE pg_catalog."C",
    n bigint NOT NULL,
    actor text NOT NULL COLLATE pg_catalog."C",
    task text COLLATE pg_catalog."C",
    at text NOT NULL COLLATE pg_catalog."C",
    pos bigint NOT NULL,
    operation text NOT NULL COLLATE pg_catalog."C",
    selfcheck boolean DEFAULT false NOT NULL,
    historical boolean DEFAULT false NOT NULL,
    slot_id text COLLATE pg_catalog."C",
    sv integer,
    table_id text COLLATE pg_catalog."C",
    shape text COLLATE pg_catalog."C",
    valid text COLLATE pg_catalog."C",
    source_id text COLLATE pg_catalog."C",
    rule_version integer,
    evaluated_at text COLLATE pg_catalog."C",
    CONSTRAINT read_log_operation_check CHECK ((operation = ANY (ARRAY['query'::text, 'sql'::text, 'history'::text, 'sources'::text, 'catalog'::text, 'pending'::text, 'deletion_preview'::text])))
);


--
-- Name: read_log_n_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.read_log ALTER COLUMN n ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.read_log_n_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: read_log_rows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.read_log_rows (
    read_id text NOT NULL COLLATE pg_catalog."C",
    k integer NOT NULL,
    table_id text NOT NULL COLLATE pg_catalog."C",
    target text COLLATE pg_catalog."C",
    ver_op bigint,
    ver_restore_count integer
);


--
-- Name: request_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.request_keys (
    key text NOT NULL COLLATE pg_catalog."C",
    op bigint NOT NULL,
    at text NOT NULL COLLATE pg_catalog."C",
    fingerprint text COLLATE pg_catalog."C"
);


--
-- Name: residue_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.residue_progress (
    id integer NOT NULL,
    tombstone_seq bigint NOT NULL,
    CONSTRAINT residue_progress_id_check CHECK ((id = 1))
);


--
-- Name: row_origins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.row_origins (
    row_id text NOT NULL COLLATE pg_catalog."C",
    table_id text NOT NULL COLLATE pg_catalog."C",
    origin_seq bigint NOT NULL
);


--
-- Name: schema_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_versions (
    slot_id text NOT NULL COLLATE pg_catalog."C",
    sv integer NOT NULL,
    compiled_seq bigint NOT NULL,
    draft_id text NOT NULL COLLATE pg_catalog."C",
    switched_seq bigint,
    state text NOT NULL COLLATE pg_catalog."C",
    CONSTRAINT schema_versions_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'current'::text, 'retired'::text, 'rejected'::text, 'superseded'::text, 'failed'::text])))
);


--
-- Name: slots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.slots (
    id text NOT NULL COLLATE pg_catalog."C",
    name text NOT NULL COLLATE pg_catalog."C",
    timezone text NOT NULL COLLATE pg_catalog."C",
    current_sv integer,
    policy_seq bigint,
    policy_version integer
);


--
-- Name: sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sources (
    seq bigint NOT NULL,
    source_id text NOT NULL COLLATE pg_catalog."C",
    kind text NOT NULL COLLATE pg_catalog."C",
    level text COLLATE pg_catalog."C",
    slot_id text NOT NULL COLLATE pg_catalog."C",
    deletion_state text NOT NULL COLLATE pg_catalog."C",
    CONSTRAINT sources_deletion_state_check CHECK ((deletion_state = ANY (ARRAY['present'::text, 'pending_deletion'::text, 'removed'::text])))
);


--
-- Name: task_cursors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_cursors (
    task text NOT NULL COLLATE pg_catalog."C",
    cursor text NOT NULL COLLATE pg_catalog."C"
);


--
-- Name: tenants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenants (
    id text NOT NULL,
    owner text NOT NULL,
    cell text NOT NULL,
    database text NOT NULL,
    state text NOT NULL,
    staging_database text,
    CONSTRAINT tenants_state_check CHECK ((state = ANY (ARRAY['creating'::text, 'active'::text])))
);


--
-- Name: web_forms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.web_forms (
    hash text NOT NULL,
    bound_to text NOT NULL,
    expires_at text NOT NULL
);


--
-- Name: web_logins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.web_logins (
    id text NOT NULL,
    cookie_hash text NOT NULL,
    user_id text NOT NULL,
    expires_at text NOT NULL
);


--
-- Data for Name: accounts; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.accounts VALUES ('u_DZEESWD7AKV5KWM10SWNFK03W4', 'sample_one', 'scrypt$32768$8$3$EZY60wYmMoF86zP5jQlYfQ$MLJim47iAIj4IMUCHs0tvEPQ7EXsypsy97t0hqLrQcM', 'active', NULL);
INSERT INTO public.accounts VALUES ('u_AYB8MHJ7TE1NHH45P4YAKJJV6W', 'sample_two', 'scrypt$32768$8$3$yG6yx0VUPmX-8vQIoo8RMQ$mxU9jD_UrbVA8oD1p28r5umaD1BeKIrwH6AXgqoYhpI', 'active', NULL);


--
-- Data for Name: anchor_deletions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: anchors; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.anchors VALUES ('tn_4G0R6JP6QVJW4Z5GD9QYTCYWMR', 69, 0, NULL, NULL);
INSERT INTO public.anchors VALUES ('tn_DEE9VA5MMDGN6S2JZMA9NN3ZNA', 69, 0, NULL, NULL);


--
-- Data for Name: base_sources; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: block_deps; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: catalog; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: content; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: control_meta; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.control_meta VALUES ('format', '1');
INSERT INTO public.control_meta VALUES ('oauth_format', '3');
INSERT INTO public.control_meta VALUES ('accounts_format', '1');


--
-- Data for Name: counts; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: credentials; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.credentials VALUES ('42441d692cc5fbb54a257d0f2f2f9b22c013aa3d007ed4476d5708932d15729e', 'session', 'u_DZEESWD7AKV5KWM10SWNFK03W4', 'tn_4G0R6JP6QVJW4Z5GD9QYTCYWMR', '2099-01-01T00:00:00.000Z', NULL);
INSERT INTO public.credentials VALUES ('449484453e26fc7be2f41988d8a66e5dde967bf9a72c14cbbc911467d949d450', 'connection', 'ci_N02SN6P86V8WERP82PW08Y7K2B', 'tn_4G0R6JP6QVJW4Z5GD9QYTCYWMR', NULL, NULL);
INSERT INTO public.credentials VALUES ('276d24873304ad48896d3016061c788fd86a63ebc63c66c0d57a1c21da09692e', 'connection', 'ci_F63CYN49FCWQBYAZ4TNM60RM86', 'tn_4G0R6JP6QVJW4Z5GD9QYTCYWMR', NULL, NULL);
INSERT INTO public.credentials VALUES ('f912b6fa9d89f532a0bbf3cb7bc48a643a061b67bc4122d43971f5a6e8f54c66', 'session', 'u_AYB8MHJ7TE1NHH45P4YAKJJV6W', 'tn_DEE9VA5MMDGN6S2JZMA9NN3ZNA', '2099-01-01T00:00:00.000Z', NULL);
INSERT INTO public.credentials VALUES ('ec13b114466ee06b4a2fb78f7d116e26d2bdfa90d4fd676c6abff5f58bfc64aa', 'connection', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', 'tn_DEE9VA5MMDGN6S2JZMA9NN3ZNA', NULL, NULL);
INSERT INTO public.credentials VALUES ('2767cd261082447eda4bb77c0487530ddd47a3cd099cfa8fc2241128f7c5f257', 'connection', 'ci_PDVX102QE14MPMRZP4VVYP5Y7B', 'tn_DEE9VA5MMDGN6S2JZMA9NN3ZNA', NULL, NULL);


--
-- Data for Name: deletions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: derived_reads; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: events; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: external_keys; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: field_name_usage; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: flags; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: last_read; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: meta; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.meta VALUES ('storage_format', '5');
INSERT INTO public.meta VALUES ('session_settings', '["SET client_encoding = ''UTF8''","SET TIME ZONE ''UTC''","SET datestyle = ''ISO, YMD''","SET intervalstyle = ''iso_8601''","SET extra_float_digits = 3","SET standard_conforming_strings = on"]');
INSERT INTO public.meta VALUES ('ownership_epoch', '1');


--
-- Data for Name: migrations; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: oauth_clients; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: oauth_codes; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: oauth_device_codes; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: oauth_grants; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: oauth_refresh_tokens; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: partitions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: pending_blocks; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: pending_entries; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: pending_items; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: possibly_affected; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: premise_decls; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: premise_edges; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: principals; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: read_log; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: read_log_rows; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: request_keys; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: residue_progress; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: row_origins; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: schema_versions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: slots; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: sources; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: task_cursors; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: tenants; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.tenants VALUES ('tn_4G0R6JP6QVJW4Z5GD9QYTCYWMR', 'u_DZEESWD7AKV5KWM10SWNFK03W4', 'main', 'tn_4g0r6jp6qvjw4z5gd9qytcywmr', 'active', NULL);
INSERT INTO public.tenants VALUES ('tn_DEE9VA5MMDGN6S2JZMA9NN3ZNA', 'u_AYB8MHJ7TE1NHH45P4YAKJJV6W', 'main', 'tn_dee9va5mmdgn6s2jzma9nn3zna', 'active', NULL);


--
-- Data for Name: web_forms; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: web_logins; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Name: read_log_n_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.read_log_n_seq', 1, false);


--
-- Name: accounts accounts_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_name_key UNIQUE (name);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);


--
-- Name: anchor_deletions anchor_deletions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.anchor_deletions
    ADD CONSTRAINT anchor_deletions_pkey PRIMARY KEY (tenant, "position");


--
-- Name: anchors anchors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.anchors
    ADD CONSTRAINT anchors_pkey PRIMARY KEY (tenant);


--
-- Name: base_sources base_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.base_sources
    ADD CONSTRAINT base_sources_pkey PRIMARY KEY (event_seq, row_id, field_id, k, n);


--
-- Name: block_deps block_deps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.block_deps
    ADD CONSTRAINT block_deps_pkey PRIMARY KEY (seq, path, n);


--
-- Name: catalog catalog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.catalog
    ADD CONSTRAINT catalog_pkey PRIMARY KEY (table_id, sv);


--
-- Name: content content_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content
    ADD CONSTRAINT content_pkey PRIMARY KEY (seq, path);


--
-- Name: control_meta control_meta_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.control_meta
    ADD CONSTRAINT control_meta_pkey PRIMARY KEY (key);


--
-- Name: counts counts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counts
    ADD CONSTRAINT counts_pkey PRIMARY KEY (table_id, partition_key);


--
-- Name: credentials credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credentials
    ADD CONSTRAINT credentials_pkey PRIMARY KEY (hash);


--
-- Name: deletions deletions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deletions
    ADD CONSTRAINT deletions_pkey PRIMARY KEY (id);


--
-- Name: derived_reads derived_reads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.derived_reads
    ADD CONSTRAINT derived_reads_pkey PRIMARY KEY (derived_seq, base_table_id, partition_id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (seq);


--
-- Name: external_keys external_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.external_keys
    ADD CONSTRAINT external_keys_pkey PRIMARY KEY (table_id, key_values);


--
-- Name: field_name_usage field_name_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.field_name_usage
    ADD CONSTRAINT field_name_usage_pkey PRIMARY KEY (actor, table_id, field_id);


--
-- Name: flags flags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flags
    ADD CONSTRAINT flags_pkey PRIMARY KEY (table_id, row_id, flag, item_id);


--
-- Name: last_read last_read_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.last_read
    ADD CONSTRAINT last_read_pkey PRIMARY KEY (actor, task, target, kind);


--
-- Name: meta meta_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meta
    ADD CONSTRAINT meta_pkey PRIMARY KEY (key);


--
-- Name: migrations migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.migrations
    ADD CONSTRAINT migrations_pkey PRIMARY KEY (id);


--
-- Name: oauth_clients oauth_clients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_clients
    ADD CONSTRAINT oauth_clients_pkey PRIMARY KEY (client_id);


--
-- Name: oauth_codes oauth_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_codes
    ADD CONSTRAINT oauth_codes_pkey PRIMARY KEY (hash);


--
-- Name: oauth_device_codes oauth_device_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_device_codes
    ADD CONSTRAINT oauth_device_codes_pkey PRIMARY KEY (device_hash);


--
-- Name: oauth_device_codes oauth_device_codes_user_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_device_codes
    ADD CONSTRAINT oauth_device_codes_user_code_key UNIQUE (user_code);


--
-- Name: oauth_grants oauth_grants_code_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_grants
    ADD CONSTRAINT oauth_grants_code_hash_key UNIQUE (code_hash);


--
-- Name: oauth_grants oauth_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_grants
    ADD CONSTRAINT oauth_grants_pkey PRIMARY KEY (id);


--
-- Name: oauth_refresh_tokens oauth_refresh_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_refresh_tokens
    ADD CONSTRAINT oauth_refresh_tokens_pkey PRIMARY KEY (hash);


--
-- Name: partitions partitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partitions
    ADD CONSTRAINT partitions_pkey PRIMARY KEY (derived_table_id, partition_id);


--
-- Name: pending_blocks pending_blocks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_blocks
    ADD CONSTRAINT pending_blocks_pkey PRIMARY KEY (seq, path, deletion_seq);


--
-- Name: pending_entries pending_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_entries
    ADD CONSTRAINT pending_entries_pkey PRIMARY KEY (item_id, n);


--
-- Name: pending_items pending_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_items
    ADD CONSTRAINT pending_items_pkey PRIMARY KEY (id);


--
-- Name: possibly_affected possibly_affected_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.possibly_affected
    ADD CONSTRAINT possibly_affected_pkey PRIMARY KEY (read_id);


--
-- Name: premise_decls premise_decls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.premise_decls
    ADD CONSTRAINT premise_decls_pkey PRIMARY KEY (op, op_index, decl_index);


--
-- Name: premise_edges premise_edges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.premise_edges
    ADD CONSTRAINT premise_edges_pkey PRIMARY KEY (item_event, field_id, k, target);


--
-- Name: principals principals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.principals
    ADD CONSTRAINT principals_pkey PRIMARY KEY (id);


--
-- Name: read_log read_log_n_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.read_log
    ADD CONSTRAINT read_log_n_key UNIQUE (n);


--
-- Name: read_log read_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.read_log
    ADD CONSTRAINT read_log_pkey PRIMARY KEY (read_id);


--
-- Name: read_log_rows read_log_rows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.read_log_rows
    ADD CONSTRAINT read_log_rows_pkey PRIMARY KEY (read_id, k);


--
-- Name: request_keys request_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_keys
    ADD CONSTRAINT request_keys_pkey PRIMARY KEY (key);


--
-- Name: residue_progress residue_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.residue_progress
    ADD CONSTRAINT residue_progress_pkey PRIMARY KEY (id);


--
-- Name: row_origins row_origins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.row_origins
    ADD CONSTRAINT row_origins_pkey PRIMARY KEY (row_id);


--
-- Name: schema_versions schema_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_versions
    ADD CONSTRAINT schema_versions_pkey PRIMARY KEY (slot_id, sv);


--
-- Name: slots slots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slots
    ADD CONSTRAINT slots_pkey PRIMARY KEY (id);


--
-- Name: sources sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sources
    ADD CONSTRAINT sources_pkey PRIMARY KEY (seq);


--
-- Name: sources sources_source_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sources
    ADD CONSTRAINT sources_source_id_key UNIQUE (source_id);


--
-- Name: task_cursors task_cursors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_cursors
    ADD CONSTRAINT task_cursors_pkey PRIMARY KEY (task);


--
-- Name: tenants tenants_cell_database_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_cell_database_key UNIQUE (cell, database);


--
-- Name: tenants tenants_cell_staging_database_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_cell_staging_database_key UNIQUE (cell, staging_database);


--
-- Name: tenants tenants_owner_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_owner_key UNIQUE (owner);


--
-- Name: tenants tenants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);


--
-- Name: web_forms web_forms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.web_forms
    ADD CONSTRAINT web_forms_pkey PRIMARY KEY (hash);


--
-- Name: web_logins web_logins_cookie_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.web_logins
    ADD CONSTRAINT web_logins_cookie_hash_key UNIQUE (cookie_hash);


--
-- Name: web_logins web_logins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.web_logins
    ADD CONSTRAINT web_logins_pkey PRIMARY KEY (id);


--
-- Name: base_sources_carried; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX base_sources_carried ON public.base_sources USING btree (carried_event, carried_field, carried_k);


--
-- Name: base_sources_row; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX base_sources_row ON public.base_sources USING btree (row_id, field_id);


--
-- Name: base_sources_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX base_sources_source ON public.base_sources USING btree (source_seq);


--
-- Name: block_deps_dep; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX block_deps_dep ON public.block_deps USING btree (dep_event, dep_field, dep_k);


--
-- Name: credentials_principal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX credentials_principal ON public.credentials USING btree (tenant, principal);


--
-- Name: deletions_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deletions_due ON public.deletions USING btree (state, due_at);


--
-- Name: events_op; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_op ON public.events USING btree (op);


--
-- Name: events_slot; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_slot ON public.events USING btree (slot, seq);


--
-- Name: events_target_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_target_event ON public.events USING btree (target_event);


--
-- Name: events_target_row; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_target_row ON public.events USING btree (target_table, target_row, seq);


--
-- Name: events_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_type ON public.events USING btree (type);


--
-- Name: external_keys_holder; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX external_keys_holder ON public.external_keys USING btree (holder_row);


--
-- Name: oauth_grants_principal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oauth_grants_principal ON public.oauth_grants USING btree (principal);


--
-- Name: oauth_refresh_tokens_grant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oauth_refresh_tokens_grant ON public.oauth_refresh_tokens USING btree (grant_id);


--
-- Name: pending_blocks_deletion; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pending_blocks_deletion ON public.pending_blocks USING btree (deletion_seq);


--
-- Name: pending_items_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pending_items_target ON public.pending_items USING btree (target_table, target_row);


--
-- Name: possibly_affected_actor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX possibly_affected_actor ON public.possibly_affected USING btree (actor);


--
-- Name: premise_decls_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX premise_decls_target ON public.premise_decls USING btree (target_row);


--
-- Name: premise_edges_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX premise_edges_target ON public.premise_edges USING btree (target);


--
-- Name: read_log_actor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX read_log_actor ON public.read_log USING btree (actor, n);


--
-- Name: read_log_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX read_log_at ON public.read_log USING btree (at);


--
-- Name: read_log_rows_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX read_log_rows_target ON public.read_log_rows USING btree (table_id, target);


--
-- Name: request_keys_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX request_keys_at ON public.request_keys USING btree (at);


--
-- Name: web_logins_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX web_logins_user ON public.web_logins USING btree (user_id);


--
-- Name: anchor_deletions anchor_deletions_tenant_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.anchor_deletions
    ADD CONSTRAINT anchor_deletions_tenant_fkey FOREIGN KEY (tenant) REFERENCES public.anchors(tenant);


--
-- Name: credentials credentials_tenant_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credentials
    ADD CONSTRAINT credentials_tenant_fkey FOREIGN KEY (tenant) REFERENCES public.tenants(id);


--
-- Name: oauth_codes oauth_codes_tenant_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_codes
    ADD CONSTRAINT oauth_codes_tenant_fkey FOREIGN KEY (tenant) REFERENCES public.tenants(id);


--
-- Name: oauth_device_codes oauth_device_codes_tenant_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_device_codes
    ADD CONSTRAINT oauth_device_codes_tenant_fkey FOREIGN KEY (tenant) REFERENCES public.tenants(id);


--
-- Name: oauth_grants oauth_grants_tenant_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_grants
    ADD CONSTRAINT oauth_grants_tenant_fkey FOREIGN KEY (tenant) REFERENCES public.tenants(id);


--
-- Name: oauth_refresh_tokens oauth_refresh_tokens_grant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_refresh_tokens
    ADD CONSTRAINT oauth_refresh_tokens_grant_id_fkey FOREIGN KEY (grant_id) REFERENCES public.oauth_grants(id);


--
-- Name: web_logins web_logins_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.web_logins
    ADD CONSTRAINT web_logins_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.accounts(id);


--
-- PostgreSQL database dump complete
--

\unrestrict ITujOxSXKBXhigLIkxmMXz8GUlD3hrnqR5Hw4eJpDy33jln8K530BvPI0VpyP1u

