--
-- PostgreSQL database dump
--

\restrict 7nGq6jdYCTuREbqdTBmb6ffhaw4d0KJ2Kk4OoVOffq7jeYH5jMd3jV1djDCYQjS

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
-- Name: counts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.counts (
    table_id text NOT NULL COLLATE pg_catalog."C",
    partition_key text NOT NULL COLLATE pg_catalog."C",
    row_count bigint NOT NULL
);


--
-- Name: d_t5_v1; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.d_t5_v1 (
    partition_id text NOT NULL COLLATE pg_catalog."C",
    f_f1 date,
    f_f2 bigint,
    f_f3 bigint,
    ver bigint NOT NULL
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
-- Name: t_t1_v1; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.t_t1_v1 (
    row_id text NOT NULL COLLATE pg_catalog."C",
    revoked boolean DEFAULT false NOT NULL,
    f_f1 date,
    f_f2 bigint,
    f_f3 text COLLATE pg_catalog."C"
);


--
-- Name: t_t1_v1__ver; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.t_t1_v1__ver (
    row_id text NOT NULL COLLATE pg_catalog."C",
    field_id text NOT NULL COLLATE pg_catalog."C",
    rec_from bigint NOT NULL,
    rec_to bigint,
    intent text NOT NULL COLLATE pg_catalog."C",
    src_event bigint,
    src_field text COLLATE pg_catalog."C",
    src_k integer,
    revoked boolean,
    no_value boolean,
    f_f1 date,
    f_f2 bigint,
    f_f3 text COLLATE pg_catalog."C"
);


--
-- Name: t_t2_v1; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.t_t2_v1 (
    entity_id text NOT NULL COLLATE pg_catalog."C",
    valid_from date NOT NULL,
    valid_to date,
    f_f1 text COLLATE pg_catalog."C",
    f_f2 bigint
);


--
-- Name: t_t2_v1__ver; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.t_t2_v1__ver (
    row_id text NOT NULL COLLATE pg_catalog."C",
    field_id text NOT NULL COLLATE pg_catalog."C",
    valid_from date NOT NULL,
    valid_to date,
    rec_from bigint NOT NULL,
    rec_to bigint,
    intent text NOT NULL COLLATE pg_catalog."C",
    src_event bigint,
    src_field text COLLATE pg_catalog."C",
    src_k integer,
    revoked boolean,
    no_value boolean,
    f_f1 text COLLATE pg_catalog."C",
    f_f2 bigint
);


--
-- Name: t_t3_v1; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.t_t3_v1 (
    row_id text NOT NULL COLLATE pg_catalog."C",
    revoked boolean DEFAULT false NOT NULL,
    f_f1 text COLLATE pg_catalog."C",
    f_f2 text COLLATE pg_catalog."C",
    f_f3 bigint
);


--
-- Name: t_t3_v1__ver; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.t_t3_v1__ver (
    row_id text NOT NULL COLLATE pg_catalog."C",
    field_id text NOT NULL COLLATE pg_catalog."C",
    rec_from bigint NOT NULL,
    rec_to bigint,
    intent text NOT NULL COLLATE pg_catalog."C",
    src_event bigint,
    src_field text COLLATE pg_catalog."C",
    src_k integer,
    revoked boolean,
    no_value boolean,
    f_f1 text COLLATE pg_catalog."C",
    f_f2 text COLLATE pg_catalog."C",
    f_f3 bigint
);


--
-- Name: t_t4_v1; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.t_t4_v1 (
    row_id text NOT NULL COLLATE pg_catalog."C",
    revoked boolean DEFAULT false NOT NULL,
    f_f1 text COLLATE pg_catalog."C",
    f_f2 text COLLATE pg_catalog."C"
);


--
-- Name: t_t4_v1__ver; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.t_t4_v1__ver (
    row_id text NOT NULL COLLATE pg_catalog."C",
    field_id text NOT NULL COLLATE pg_catalog."C",
    rec_from bigint NOT NULL,
    rec_to bigint,
    intent text NOT NULL COLLATE pg_catalog."C",
    src_event bigint,
    src_field text COLLATE pg_catalog."C",
    src_k integer,
    revoked boolean,
    no_value boolean,
    f_f1 text COLLATE pg_catalog."C",
    f_f2 text COLLATE pg_catalog."C"
);


--
-- Name: task_cursors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_cursors (
    task text NOT NULL COLLATE pg_catalog."C",
    cursor text NOT NULL COLLATE pg_catalog."C"
);


--
-- Data for Name: base_sources; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.base_sources VALUES (11, 'r_V6RH9FFY9J354M7G13BA6D3XHV', 'f1', 0, 0, 'value', 10, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (11, 'r_V6RH9FFY9J354M7G13BA6D3XHV', 'f2', 0, 0, 'value', 10, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (11, 'r_V6RH9FFY9J354M7G13BA6D3XHV', 'f3', 0, 0, 'value', 10, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (15, 'r_0HX0BEZ3J96GW8CYMYXVCKKK7Y', 'f1', 0, 0, 'value', 14, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (15, 'r_0HX0BEZ3J96GW8CYMYXVCKKK7Y', 'f2', 0, 0, 'value', 14, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (15, 'r_0HX0BEZ3J96GW8CYMYXVCKKK7Y', 'f3', 0, 0, 'value', 14, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (19, 'r_WYXV2M27PD1JYV4HN68E5VAM13', 'f1', 0, 0, 'value', 18, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (19, 'r_WYXV2M27PD1JYV4HN68E5VAM13', 'f2', 0, 0, 'value', 18, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (19, 'r_WYXV2M27PD1JYV4HN68E5VAM13', 'f3', 0, 0, 'value', 18, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (23, 'r_V6RH9FFY9J354M7G13BA6D3XHV', 'f2', 0, 0, 'value', 22, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (27, 'r_WYXV2M27PD1JYV4HN68E5VAM13', 'existence', 0, 0, 'operation', 26, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (31, 'r_P6M68GZNRN8N73T04M6G6NQC2W', 'f1', 0, 0, 'value', 30, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (31, 'r_P6M68GZNRN8N73T04M6G6NQC2W', 'f2', 0, 0, 'value', 30, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (31, 'r_P6M68GZNRN8N73T04M6G6NQC2W', 'f3', 0, 0, 'value', 30, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (35, 'r_P6M68GZNRN8N73T04M6G6NQC2W', 'existence', 0, 0, 'operation', 34, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[{"op":37,"valid":[{"from":null,"to":null}]}]', NULL, NULL);
INSERT INTO public.base_sources VALUES (39, 'r_P6M68GZNRN8N73T04M6G6NQC2W', 'existence', 0, 0, 'operation', 38, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (43, 'r_0HX0BEZ3J96GW8CYMYXVCKKK7Y', 'f2', 0, 0, 'value', 42, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (51, 'r_JR16J09DDPW9EX54GFQVWTQGBJ', 'f1', 0, 0, 'value', 50, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (51, 'r_JR16J09DDPW9EX54GFQVWTQGBJ', 'f2', 0, 0, 'value', 50, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (54, 'e_TN6Z27K0HG01R6Y4YKV6W64XSN', 'f1', 0, 0, 'value', 53, NULL, NULL, NULL, NULL, 'applied', '2026-10-01', NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (54, 'e_TN6Z27K0HG01R6Y4YKV6W64XSN', 'f1', 0, 1, 'interval', 53, NULL, NULL, NULL, NULL, 'applied', '2026-10-01', NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (54, 'e_TN6Z27K0HG01R6Y4YKV6W64XSN', 'f2', 0, 0, 'value', 53, NULL, NULL, NULL, NULL, 'applied', '2026-10-01', NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (54, 'e_TN6Z27K0HG01R6Y4YKV6W64XSN', 'f2', 0, 1, 'interval', 53, NULL, NULL, NULL, NULL, 'applied', '2026-10-01', NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (57, 'e_TN6Z27K0HG01R6Y4YKV6W64XSN', 'f2', 0, 0, 'value', 56, NULL, NULL, NULL, NULL, 'applied', '2026-11-10', NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (57, 'e_TN6Z27K0HG01R6Y4YKV6W64XSN', 'f2', 0, 1, 'interval', 56, NULL, NULL, NULL, NULL, 'applied', '2026-11-10', NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (65, 'r_KNQKC0R2AV1WCSEBTX0FEV6DGV', 'f1', 0, 0, 'value', 63, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (65, 'r_KNQKC0R2AV1WCSEBTX0FEV6DGV', 'f2', 0, 0, 'value', 63, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (65, 'r_KNQKC0R2AV1WCSEBTX0FEV6DGV', 'f3', 0, 0, 'value', 63, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (66, 'r_F9TJVJHQ32G09A15Z9520CN9CN', 'f1', 0, 0, 'value', 64, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (66, 'r_F9TJVJHQ32G09A15Z9520CN9CN', 'f2', 0, 0, 'value', 64, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (66, 'r_F9TJVJHQ32G09A15Z9520CN9CN', 'f3', 0, 0, 'value', 64, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (69, 'r_KNQKC0R2AV1WCSEBTX0FEV6DGV', 'f3', 0, 0, 'value', 68, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);


--
-- Data for Name: block_deps; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.block_deps VALUES (48, 'candidates/0', 0, 47, 'f2', 0, 'deps');
INSERT INTO public.block_deps VALUES (48, 'current/0', 0, 43, 'f2', 0, 'deps');
INSERT INTO public.block_deps VALUES (48, 'impact/0', 0, 43, 'f2', 0, 'deps');
INSERT INTO public.block_deps VALUES (48, 'previous/0', 0, 15, 'f2', 0, 'deps');
INSERT INTO public.block_deps VALUES (61, 'current/0', 0, 54, 'f2', 0, 'deps');
INSERT INTO public.block_deps VALUES (61, 'current/0', 1, 57, 'f2', 0, 'deps');
INSERT INTO public.block_deps VALUES (61, 'current/0', 2, 60, 'f2', 0, 'deps');
INSERT INTO public.block_deps VALUES (61, 'current/1', 0, 57, 'f2', 0, 'deps');
INSERT INTO public.block_deps VALUES (61, 'current/1', 1, 60, 'f2', 0, 'deps');
INSERT INTO public.block_deps VALUES (61, 'impact/0', 0, 54, 'f2', 0, 'deps');
INSERT INTO public.block_deps VALUES (61, 'impact/0', 1, 57, 'f2', 0, 'deps');
INSERT INTO public.block_deps VALUES (61, 'impact/1', 0, 57, 'f2', 0, 'deps');
INSERT INTO public.block_deps VALUES (61, 'proposed/0', 0, 60, 'f2', 0, 'deps');
INSERT INTO public.block_deps VALUES (61, 'scope_valid', 0, 60, 'f2', 0, 'deps');


--
-- Data for Name: catalog; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.catalog VALUES ('t5', 1, 'sl_ESNC5VC50A2EC6GF', '{"description":"what was spent each day","fields":[{"description":"the day","id":"f1","name":"day","type":"date"},{"description":"the sum","id":"f2","name":"total","type":"integer"},{"description":"how many","id":"f3","name":"n","type":"integer"}],"id":"t5","kind":"derived","name":"spent_by_day","rule":{"depends_on":[{"field":"f1","table":"t1"},{"field":"f2","table":"t1"}],"id":"r1","rsql":"rsql@1","scope":{"key":["f1"],"key_from_free_text":false,"kind":"group"},"sql":"SELECT \"t1\".\"f1\" AS \"f1\", CAST(sum(\"t1\".\"f2\") AS bigint) AS \"f2\", count(*) AS \"f3\" FROM \"t1\" GROUP BY 1","time_dependency":"bucketed","version":1}}', NULL, NULL);
INSERT INTO public.catalog VALUES ('t1', 1, 'sl_ESNC5VC50A2EC6GF', '{"description":"one row per expense","fields":[{"description":"the day","id":"f1","name":"date","required":true,"type":"date"},{"description":"how much, in yuan","id":"f2","name":"amount","type":"integer"},{"description":"what for","id":"f3","name":"note","type":"text"}],"id":"t1","kind":"base","name":"expenses","time":{"field":"f1","type":"event"}}', NULL, NULL);
INSERT INTO public.catalog VALUES ('t2', 1, 'sl_ESNC5VC50A2EC6GF', '{"description":"a monthly budget by kind","entity_key":["f1"],"fields":[{"description":"what the budget is for","id":"f1","name":"kind","required":true,"type":"text"},{"description":"the budget, in yuan","id":"f2","name":"amount","required":true,"type":"integer"}],"id":"t2","kind":"base","name":"budgets","time":{"granularity":"date","type":"state"}}', NULL, NULL);
INSERT INTO public.catalog VALUES ('t3', 1, 'sl_ESNC5VC50A2EC6GF', '{"description":"rides from an app","external_key":["f1","f2"],"fields":[{"description":"the app","id":"f1","name":"origin","type":"text"},{"description":"its ID there","id":"f2","name":"external_id","type":"text"},{"description":"how much","id":"f3","name":"fare","type":"integer"}],"id":"t3","kind":"base","name":"rides","time":{"type":"none"}}', NULL, NULL);
INSERT INTO public.catalog VALUES ('t4', 1, 'sl_ESNC5VC50A2EC6GF', '{"description":"one row per refund of an expense","fields":[{"description":"why","id":"f1","name":"note","required":true,"type":"text"},{"description":"the expense refunded","id":"f2","name":"expense","ref":{"table":"t1","target":"row"},"type":"ref"}],"id":"t4","kind":"base","name":"refunds","time":{"type":"none"}}', NULL, NULL);


--
-- Data for Name: content; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.content VALUES (1, 'system', '{"kind":"system","principal":"system"}', 'a2a35fe2925b9b16c34e619069b782461a1ed680a95a60d70eeb5ce5f88ce770', NULL, NULL, NULL);
INSERT INTO public.content VALUES (1, 'tenant', '{"event_format":1,"storage_format":5,"tenant_id":"tn_DEE9VA5MMDGN6S2JZMA9NN3ZNA"}', '51623cea211d506b4e1b62895aa0226f75065235a1036e5451e1e7e35b5b2754', NULL, NULL, NULL);
INSERT INTO public.content VALUES (1, 'user', '{"kind":"user","principal":"u_AYB8MHJ7TE1NHH45P4YAKJJV6W"}', 'b3dab71e14fbf24fa83aca2047c35a6176c265a2a8bee84284776cbfe2eff53d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (2, 'ctx', '{"now":"2026-11-24T13:37:53.802Z","policy_version":1,"ruleset_version":1,"today":"2026-11-24"}', '16b7fdc3f5fef9f83e0a3c76117f305e9b158888cba9e8e319234703c0c44e44', NULL, NULL, NULL);
INSERT INTO public.content VALUES (2, 'draft', '{"base_version":null,"slot":"household","tables":[{"description":"one row per expense","fields":[{"description":"the day","name":"date","required":true,"type":"date"},{"description":"how much, in yuan","name":"amount","type":"integer"},{"description":"what for","name":"note","type":"text"}],"kind":"base","name":"expenses","time":{"field":"date","type":"event"}},{"description":"a monthly budget by kind","entity_key":["kind"],"fields":[{"description":"what the budget is for","name":"kind","required":true,"type":"text"},{"description":"the budget, in yuan","name":"amount","required":true,"type":"integer"}],"kind":"base","name":"budgets","time":{"granularity":"date","type":"state"}},{"description":"rides from an app","external_key":["origin","external_id"],"fields":[{"description":"the app","name":"origin","type":"text"},{"description":"its ID there","name":"external_id","type":"text"},{"description":"how much","name":"fare","type":"integer"}],"kind":"base","name":"rides","time":{"type":"none"}},{"description":"one row per refund of an expense","fields":[{"description":"why","name":"note","required":true,"type":"text"},{"description":"the expense refunded","name":"expense","ref":{"table":"expenses","target":"row"},"type":"ref"}],"kind":"base","name":"refunds","time":{"type":"none"}},{"description":"what was spent each day","fields":[{"description":"the day","name":"day"},{"description":"the sum","name":"total"},{"description":"how many","name":"n"}],"kind":"derived","name":"spent_by_day","rule":{"sql":"SELECT date AS day, sum(amount) AS total, count(*) AS n FROM expenses GROUP BY 1","time_dependency":"bucketed"}}],"timezone":"Asia/Shanghai"}', '6445068c0f251c0434a5deb3094dc975f2eabd6b2db0798f06876a7f4497f1b6', NULL, NULL, NULL);
INSERT INTO public.content VALUES (2, 'request_key', '{"key":"d67707fd634dbb62962b4e6017f6c302ce8efa552d586cb674d213b721fb6fce"}', 'cb02360883068f2796a82a75269dc35eb39435d713752e78ff0cf8beff4dca6c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (2, 'target', '{"creates_slot":true,"draft_id":"d_MQ7WG6HXZNZRCP5H"}', '860b2889e56901721622fd6fb23c5afe611bdf07c3564c949840d0f992c3dae7', NULL, NULL, NULL);
INSERT INTO public.content VALUES (3, 'changes', '[{"auto":true,"change":"create_slot","class":"create","compatible_with_old_writes":true,"destructive":false,"target":{"slot":true}},{"auto":true,"change":"add_table","class":"create","compatible_with_old_writes":true,"destructive":false,"target":{"table":"t1"}},{"auto":true,"change":"add_table","class":"create","compatible_with_old_writes":true,"destructive":false,"target":{"table":"t2"}},{"auto":true,"change":"add_table","class":"create","compatible_with_old_writes":true,"destructive":false,"target":{"table":"t3"}},{"auto":true,"change":"add_table","class":"create","compatible_with_old_writes":true,"destructive":false,"target":{"table":"t4"}},{"auto":true,"change":"add_derived_table","class":"create","compatible_with_old_writes":true,"destructive":false,"target":{"table":"t5"}}]', '7693e6615a0b0b02e421cfc07d012ee09421e5b1c3597b0698dcf4214e131875', NULL, NULL, NULL);
INSERT INTO public.content VALUES (3, 'compiled', '{"compiler":1,"name":"household","rsql":"rsql@1","slot":"sl_ESNC5VC50A2EC6GF","sv":1,"tables":[{"description":"one row per expense","fields":[{"description":"the day","id":"f1","name":"date","required":true,"type":"date"},{"description":"how much, in yuan","id":"f2","name":"amount","type":"integer"},{"description":"what for","id":"f3","name":"note","type":"text"}],"id":"t1","kind":"base","name":"expenses","physical":{"table":"t_t1_v1"},"time":{"field":"f1","type":"event"}},{"description":"a monthly budget by kind","entity_key":["f1"],"fields":[{"description":"what the budget is for","id":"f1","name":"kind","required":true,"type":"text"},{"description":"the budget, in yuan","id":"f2","name":"amount","required":true,"type":"integer"}],"id":"t2","kind":"base","name":"budgets","physical":{"table":"t_t2_v1"},"time":{"granularity":"date","type":"state"}},{"description":"rides from an app","external_key":["f1","f2"],"fields":[{"description":"the app","id":"f1","name":"origin","type":"text"},{"description":"its ID there","id":"f2","name":"external_id","type":"text"},{"description":"how much","id":"f3","name":"fare","type":"integer"}],"id":"t3","kind":"base","name":"rides","physical":{"table":"t_t3_v1"},"time":{"type":"none"}},{"description":"one row per refund of an expense","fields":[{"description":"why","id":"f1","name":"note","required":true,"type":"text"},{"description":"the expense refunded","id":"f2","name":"expense","ref":{"table":"t1","target":"row"},"type":"ref"}],"id":"t4","kind":"base","name":"refunds","physical":{"table":"t_t4_v1"},"time":{"type":"none"}},{"description":"what was spent each day","fields":[{"description":"the day","id":"f1","name":"day","type":"date"},{"description":"the sum","id":"f2","name":"total","type":"integer"},{"description":"how many","id":"f3","name":"n","type":"integer"}],"id":"t5","kind":"derived","name":"spent_by_day","physical":{"table":"d_t5_v1"},"rule":{"depends_on":[{"field":"f1","table":"t1"},{"field":"f2","table":"t1"}],"id":"r1","rsql":"rsql@1","scope":{"key":["f1"],"key_from_free_text":false,"kind":"group"},"sql":"SELECT \"t1\".\"f1\" AS \"f1\", CAST(sum(\"t1\".\"f2\") AS bigint) AS \"f2\", count(*) AS \"f3\" FROM \"t1\" GROUP BY 1","time_dependency":"bucketed","version":1}}],"timezone":"Asia/Shanghai"}', 'b2c1b918ca2fce3676fb0adbc80879746c1ed6998f163e217bc0e31e8cd62a2b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (3, 'target', '{"draft_id":"d_MQ7WG6HXZNZRCP5H","outcome":"applied","target_version":1}', '37b377baf3a1f5e76d61f45e63bafe63b44b33e5e88b21daa1e63fddb6d337a3', NULL, NULL, NULL);
INSERT INTO public.content VALUES (4, 'target', '{"by":"auto","draft_id":"d_MQ7WG6HXZNZRCP5H","target_version":1}', 'eb23ce9c4ab512fe773a7c426e31abf48e6e89b1bbfa69f154e85f3da80290fc', NULL, NULL, NULL);
INSERT INTO public.content VALUES (5, 'policy', '{"auto_apply":["add_table","add_derived_table","add_optional_field","description","rename_unused","loosen_constraint","duplicate_keys","restructure_unused"],"effective_value_rule":"keep_current","high_impact":[],"policy_version":1,"rank":{"agent_inferred":1,"miss":0,"user_stated":2},"user_session_only":[]}', '41f24c1878d2f9158397f7d9f675bdff962fb35398d8e890b3c0189f76a21363', NULL, NULL, NULL);
INSERT INTO public.content VALUES (6, 'target', '{"draft_id":"d_MQ7WG6HXZNZRCP5H","rebuilt_tables":[],"to_version":1}', 'ab573fd568ddde32b89d373130292c6f258c68541945969c3f92f6c6b05478a7', NULL, NULL, NULL);
INSERT INTO public.content VALUES (7, 'ctx', '{"now":"2026-11-24T13:37:53.816Z","ruleset_version":1}', '071324dbd6bb4c4112505760aa14515061bfde2a6efb155a1dc06cdea0139573', NULL, NULL, NULL);
INSERT INTO public.content VALUES (7, 'name', '{"name":"sample agent"}', '0957e5e5000dc767fb05ce8147d97d2657ac9a78f515adbc977be857b71de0d1', NULL, NULL, NULL);
INSERT INTO public.content VALUES (7, 'principal', '{"kind":"connection","principal":"ci_N7MTZZE9VD8HEN6Y533VE628P4","scopes":["saveslot.read","saveslot.write","saveslot.schema"],"via":"token"}', 'aef271c5658b6e5d0b37887452bdd5a0042db42e2b75022bfb5af40e73c13f6d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (8, 'ctx', '{"now":"2026-11-24T13:37:53.819Z","ruleset_version":1}', '5bd49ecdb660fca70b173aebbeec6ac29ce631f3d2f816ff867aaf38e9b1d7d2', NULL, NULL, NULL);
INSERT INTO public.content VALUES (8, 'name', '{"name":"another agent"}', '95f97e5914d91f1ab0571d876aed20feb5977513c223d29b3d6c4ecf9f84847e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (8, 'principal', '{"kind":"connection","principal":"ci_PDVX102QE14MPMRZP4VVYP5Y7B","scopes":["saveslot.read","saveslot.write","saveslot.schema"],"via":"token"}', '816cdc62ac4544edcb70eea73f9c6e4966f1d757fef97a35d1d6d933ae529b4a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (9, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-24T13:37:53.821Z","policy_version":1,"ruleset_version":1,"today":"2026-11-24"}', '35aaa39b7501096fcc9401b1cfc6cb526bdc41024592b77f9e3640241c2d470a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (9, 'ops/0/set/f1', '"2026-11-02"', 'bb1de3879fc3904da5b8b20834d8d58eac44c618f8305a7357557ae506daf77f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (9, 'ops/0/set/f2', '"45"', '2eecac45827ede372449b7bd78a82139db639d810ebce98caef91e5d1a2fe422', NULL, NULL, NULL);
INSERT INTO public.content VALUES (9, 'ops/0/set/f3', '"lunch"', '861315d6dc2fae3332121172cefb27dbbc4f45d0422d6c7a700e861baadf4f8d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (9, 'ops/0/target', '{"created":true,"intent":"insert","row":"r_V6RH9FFY9J354M7G13BA6D3XHV","table":"t1"}', 'ff6b1c93bb34e7265bfa2eef59531c4266588538a31ed31fc24b207ba22c924b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (9, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (9, 'request_key', '{"key":"6a8b420993d1943c6d40ac58899a69206748b1b3de8b29cfb2f09ddcf546ffbe"}', 'a066de97cba62f26af1d2ffe461f6f5644c91551ca1b8222a6408f86832e0e48', NULL, NULL, NULL);
INSERT INTO public.content VALUES (10, 'target', '{"kind":"user_message","level":"user_stated","source_id":"s_NC5PXS7Q71SZQYHV"}', 'c713a47a5b17a47895d5b469938636b0d8ca47f29550445a475c55c049c717cb', NULL, NULL, NULL);
INSERT INTO public.content VALUES (10, 'text', '{"text":"lunch today was 45"}', '05764f12b83ee14c7656f6c9318bcbf3263b9ff62c3978b5ca981345c32d77fe', NULL, NULL, NULL);
INSERT INTO public.content VALUES (11, 'fields/f1/0', '{"status":"applied","value":"2026-11-02"}', '96a119bb0a7bc53bfaa2b66ba49a944c8959ef63f8218c5af954c7f093c803a2', NULL, NULL, NULL);
INSERT INTO public.content VALUES (11, 'fields/f2/0', '{"status":"applied","value":"45"}', '722970ab881557000fdee70432bcc50947f6ebc34f3ef6471ec92cdb8f584098', NULL, NULL, NULL);
INSERT INTO public.content VALUES (11, 'fields/f3/0', '{"status":"applied","value":"lunch"}', 'a8db5f8cb5beb8cfabf3f12f93582fbff4f01c4d1eb78418794404af42f5b882', NULL, NULL, NULL);
INSERT INTO public.content VALUES (11, 'literal/f1/0', '{"segments":[{"result":"miss","source":10}]}', 'd40163ea50886b735cebae711da4775770d9d3f7c631548604491e586af0abe5', NULL, NULL, NULL);
INSERT INTO public.content VALUES (11, 'literal/f2/0', '{"segments":[{"result":"hit","source":10}]}', '7946502cc03816811ce8af0d783ff68b150108a3f193a859678565aaacbdd8bd', NULL, NULL, NULL);
INSERT INTO public.content VALUES (11, 'literal/f3/0', '{"segments":[{"result":"hit","source":10}]}', '7946502cc03816811ce8af0d783ff68b150108a3f193a859678565aaacbdd8bd', NULL, NULL, NULL);
INSERT INTO public.content VALUES (11, 'sources/f1/0', '[{"kind":"value","source":10}]', 'ddb9f4e65988011f996dc2904d2daf9f005473ece6547b5cc824419535896e5d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (11, 'sources/f2/0', '[{"kind":"value","source":10}]', 'ddb9f4e65988011f996dc2904d2daf9f005473ece6547b5cc824419535896e5d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (11, 'sources/f3/0', '[{"kind":"value","source":10}]', 'ddb9f4e65988011f996dc2904d2daf9f005473ece6547b5cc824419535896e5d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (11, 'target', '{"cause":"request","created":true,"intent":"insert","op_index":0,"row":"r_V6RH9FFY9J354M7G13BA6D3XHV","sv":1,"table":"t1"}', '054c376eee4474f69e4f87d088264ac51c5204106391e0c34a6efd3ada90e385', NULL, NULL, NULL);
INSERT INTO public.content VALUES (12, 'checksum', '{"checksum":"47747ef5d44f61b2b8d2bca0722b3bccbd836a4860e44353c624370fb2e57386"}', '527f6e06439803548234e5f825f437597b39c7ff2a494893e5c624bef97bfb98', NULL, NULL, NULL);
INSERT INTO public.content VALUES (12, 'key', '{"values":["2026-11-02"]}', 'cc51a7db3e7d0a58c48bf5231237b844def245dd03281bd3f72ded939cff012c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (12, 'target', '{"emptied":false,"partition":"p_KNKSNAFMV8WDJAX9","read_pos":11,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', '93eb9e28a36c0d3d1c8dc73ade504f99567d95a035821610261251ced2838ca9', NULL, NULL, NULL);
INSERT INTO public.content VALUES (13, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-24T13:37:53.832Z","policy_version":1,"ruleset_version":1,"today":"2026-11-24"}', 'b77612c7b1fe27219f4261fe414abc17cdd164896ff7dcb2248f95b8a71b24d5', NULL, NULL, NULL);
INSERT INTO public.content VALUES (13, 'ops/0/set/f1', '"2026-11-02"', 'bb1de3879fc3904da5b8b20834d8d58eac44c618f8305a7357557ae506daf77f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (13, 'ops/0/set/f2', '"30"', 'f20e4586c63ba3b2c06a97c4e585acea4a2977c3d8d81dc2d1f2275439ad90a7', NULL, NULL, NULL);
INSERT INTO public.content VALUES (13, 'ops/0/set/f3', '"taxi"', '7a064c2491cc802c8ed3d43507560ab951779574b21991954294405e57be3745', NULL, NULL, NULL);
INSERT INTO public.content VALUES (13, 'ops/0/target', '{"created":true,"intent":"insert","row":"r_0HX0BEZ3J96GW8CYMYXVCKKK7Y","table":"t1"}', '7204b38132cf0947f5f19cab7cc16c323bdb620ae27838b541b75e71d65ac290', NULL, NULL, NULL);
INSERT INTO public.content VALUES (13, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (13, 'request_key', '{"key":"9d0fc59c1461911fc73b01c297101e41711f988d7c2e4c10dbd46aa2b33b1e0a"}', '4c4bb8bbfd5c30749cc11ba6fd3087b71f346bde68963b7b55bd7712fb846227', NULL, NULL, NULL);
INSERT INTO public.content VALUES (14, 'request', '{"intent":"insert","set":{"amount":30,"date":"2026-11-02","note":"taxi"},"table":"household.expenses"}', 'd9e9ed8dd8d23adf88d6185adafe2254e272a0ecd451d4e2f45bce543f3bfada', NULL, NULL, NULL);
INSERT INTO public.content VALUES (14, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_EGKTGA593MKWQ9DY"}', '2127015db6783a48df3d30a694342d7b9c619fd027ecac368b5e6a93e9586714', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'fields/f1/0', '{"status":"applied","value":"2026-11-02"}', '96a119bb0a7bc53bfaa2b66ba49a944c8959ef63f8218c5af954c7f093c803a2', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'fields/f2/0', '{"status":"applied","value":"30"}', '1712bdc8cfafa74ec9f72dc98448d3d1c62b78b6a7e3151d98154cd62872d59e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'fields/f3/0', '{"status":"applied","value":"taxi"}', 'ca8af995f357da958ad27752fa8f8064ea0cccc9ebbc49097f1b971e69a186d4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'literal/f1/0', '{"segments":[{"result":"na","source":14}]}', 'e05b307243777b6813b055f65fdf8e07b3fc003f3f4cfe5c8d252c266a522d97', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'literal/f2/0', '{"segments":[{"result":"na","source":14}]}', 'e05b307243777b6813b055f65fdf8e07b3fc003f3f4cfe5c8d252c266a522d97', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'literal/f3/0', '{"segments":[{"result":"na","source":14}]}', 'e05b307243777b6813b055f65fdf8e07b3fc003f3f4cfe5c8d252c266a522d97', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'sources/f1/0', '[{"kind":"value","source":14}]', '0c2e432acf8d5e0ebb8b3ccff0fa23f57b1788d2c11a8b7dd55c5a4df69c37b0', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'sources/f2/0', '[{"kind":"value","source":14}]', '0c2e432acf8d5e0ebb8b3ccff0fa23f57b1788d2c11a8b7dd55c5a4df69c37b0', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'sources/f3/0', '[{"kind":"value","source":14}]', '0c2e432acf8d5e0ebb8b3ccff0fa23f57b1788d2c11a8b7dd55c5a4df69c37b0', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'target', '{"cause":"request","created":true,"intent":"insert","op_index":0,"row":"r_0HX0BEZ3J96GW8CYMYXVCKKK7Y","sv":1,"table":"t1"}', '32445e94ab9389f6458853d03926040bd87e9658cbd3bd3267f0afdc49b7c1cb', NULL, NULL, NULL);
INSERT INTO public.content VALUES (16, 'checksum', '{"checksum":"02cfce4fdae133910f70340dd233e8f0bba42d37f0c5d998442390dfdbb426f0"}', '8466d6b60445e9f1e7b0d5a4efd5d66ec181a0111ebfbce9da69eff2891cc0b3', NULL, NULL, NULL);
INSERT INTO public.content VALUES (16, 'target', '{"emptied":false,"partition":"p_KNKSNAFMV8WDJAX9","read_pos":15,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', '2a6f9fe51289392c0b80f7d925224b85c8957d491c2c797ccba9a8fc2d9e78b2', NULL, NULL, NULL);
INSERT INTO public.content VALUES (17, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-24T13:37:53.839Z","policy_version":1,"ruleset_version":1,"today":"2026-11-24"}', '7b42b1701758f2dcb880cd23d0c737214d89fea9dcddb7c3fcebf14382688ac3', NULL, NULL, NULL);
INSERT INTO public.content VALUES (17, 'ops/0/set/f1', '"2026-11-03"', 'd658e2a3b5597fab6e1c619fb80cdf08d37763c2d403667798cddcf65eeccb97', NULL, NULL, NULL);
INSERT INTO public.content VALUES (17, 'ops/0/set/f2', '"18"', '0234a350f4d56ae45c5ece57b08c54496f372bc570bd83a465fb6d2d85531479', NULL, NULL, NULL);
INSERT INTO public.content VALUES (17, 'ops/0/set/f3', '"coffee"', '0f52baaa23b045e196e5c8bffd06442c98eca166ca9d77582ce939d5f1b67a7d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (17, 'ops/0/target', '{"created":true,"intent":"insert","row":"r_WYXV2M27PD1JYV4HN68E5VAM13","table":"t1"}', '0aaf09d4629f2559bcf03c72c6f302bf5aa27d1e19c4b5bcfc047363ddaa0801', NULL, NULL, NULL);
INSERT INTO public.content VALUES (17, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (17, 'request_key', '{"key":"c25320bd27af0a62a11bcde927921b9841abc24b8ea2d1c4cf5cfd2ceb04f95e"}', 'd98f63bac8d51ea4d80bbffe545e8b0fa60d9ee74cb868ddaf8fcba9906fbb2b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (18, 'request', '{"intent":"insert","set":{"amount":18,"date":"2026-11-03","note":"coffee"},"table":"household.expenses"}', '6da0ef3e89920647fdb115c80b2a013c88124bcb6196612e78670c5eae4d9692', NULL, NULL, NULL);
INSERT INTO public.content VALUES (18, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_N7BVK223HD50Z7MW"}', '09f324aed73e363fe89ef315005f73224bb4219742d3011d7bda3b63d502560d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'fields/f1/0', '{"status":"applied","value":"2026-11-03"}', '54dff293fa73477624b85fd869155a45261fa9df38233ae3c67233b985538f91', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'fields/f2/0', '{"status":"applied","value":"18"}', '751b79871b4d159bc5c227b5a148469189fbce2f626be069f2569073af35daaa', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'fields/f3/0', '{"status":"applied","value":"coffee"}', '24ee69f41a25745b6cdb4e2910f9a6041cd302067b02f167fdc0e0e95f137c02', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'literal/f1/0', '{"segments":[{"result":"na","source":18}]}', '4a58ed960a93a8baf068beb9c9dc53968928ddc2e4c32292bb87467a49116653', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'literal/f2/0', '{"segments":[{"result":"na","source":18}]}', '4a58ed960a93a8baf068beb9c9dc53968928ddc2e4c32292bb87467a49116653', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'literal/f3/0', '{"segments":[{"result":"na","source":18}]}', '4a58ed960a93a8baf068beb9c9dc53968928ddc2e4c32292bb87467a49116653', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'sources/f1/0', '[{"kind":"value","source":18}]', '319b9de0cbecc6b80f3925d4ca8167b0a3934443f98d4627237125576b1ae684', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'sources/f2/0', '[{"kind":"value","source":18}]', '319b9de0cbecc6b80f3925d4ca8167b0a3934443f98d4627237125576b1ae684', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'sources/f3/0', '[{"kind":"value","source":18}]', '319b9de0cbecc6b80f3925d4ca8167b0a3934443f98d4627237125576b1ae684', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'target', '{"cause":"request","created":true,"intent":"insert","op_index":0,"row":"r_WYXV2M27PD1JYV4HN68E5VAM13","sv":1,"table":"t1"}', '8dc7d7c5fd3622a3ddfc0c94db7f434ac58d0d2827c27110000a3cbf24762f6e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (20, 'checksum', '{"checksum":"2fdb99b9e376a0eeb9374c90106ded3f433d35bc1a11400eea77fa992ffc1b74"}', '2b6486c5a4c6121ac9f7a151dd594635971ef3202c83a53472eee255f03746ef', NULL, NULL, NULL);
INSERT INTO public.content VALUES (20, 'key', '{"values":["2026-11-03"]}', '197cbb7c11daaeba4de02e882703c19e248a409995fb839b5ad392c09d93f8dd', NULL, NULL, NULL);
INSERT INTO public.content VALUES (20, 'target', '{"emptied":false,"partition":"p_MRN4XWHC2TN0RDW5","read_pos":19,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', '47de49ad5ab50dc9fa5a75e2a89bf06a1685d8ab1a30b55af46d133245dd7eec', NULL, NULL, NULL);
INSERT INTO public.content VALUES (21, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-24T13:37:53.846Z","policy_version":1,"ruleset_version":1,"today":"2026-11-24"}', 'a922c1b27f84bbf50f0adb993505043689a246a04f4fd0e034b062b73a3ef767', NULL, NULL, NULL);
INSERT INTO public.content VALUES (21, 'ops/0/set/f2', '"54"', '6ce1ced1ac1f56f8cd7ee5c55d117fe99c805b89a603e36c41852fea49853068', NULL, NULL, NULL);
INSERT INTO public.content VALUES (21, 'ops/0/target', '{"intent":"correct","row":"r_V6RH9FFY9J354M7G13BA6D3XHV","table":"t1","ver":{"basis":"explicit","current":true,"op":9,"restore_count":0}}', '4ab29ebdb8685bf75b276b3ce29e7aadfebe13ac3db181466331f63fd38d33b9', NULL, NULL, NULL);
INSERT INTO public.content VALUES (21, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (21, 'request_key', '{"key":"29aa15fa354edd9be39fe5f7eb1a7bac29e70078ed23a9f047d0de888cc75671"}', '0642a32bd8e3efa6b311b81e2126bf7a2c8793f23e700a569508d84b63735027', NULL, NULL, NULL);
INSERT INTO public.content VALUES (22, 'target', '{"kind":"user_message","level":"user_stated","source_id":"s_54CJ89JJQGQR0BEK"}', '11ef349acb086fbbdac648e9b3b4985b7d9f23e001187522e628067f69cdc347', NULL, NULL, NULL);
INSERT INTO public.content VALUES (22, 'text', '{"text":"sorry, lunch was 54"}', '09db22c6ce9b888483906e0876b820f9021653c803cd9a16790a11f4e740081b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (23, 'fields/f2/0', '{"status":"applied","value":"54"}', '3066d5922eca1709cab4c55d047596dc085c9289eb0e69902f10bdafc414ee89', NULL, NULL, NULL);
INSERT INTO public.content VALUES (23, 'literal/f2/0', '{"segments":[{"result":"hit","source":22}]}', '4f71b5712c5b41e18380034068b347aebb77c5689a10fd56ecdb06563ff837e8', NULL, NULL, NULL);
INSERT INTO public.content VALUES (23, 'sources/f2/0', '[{"kind":"value","source":22}]', '6dbed4dff6a4840169d6cfbd4eb235fde4756a6ffdd1b298f89c0adababc0022', NULL, NULL, NULL);
INSERT INTO public.content VALUES (23, 'target', '{"cause":"request","intent":"correct","op_index":0,"row":"r_V6RH9FFY9J354M7G13BA6D3XHV","sv":1,"table":"t1"}', 'e62c78fc71eec8f7353e460e6d876badc9266fa54c0cba49a477379356bfbd0f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (24, 'checksum', '{"checksum":"3eaa57f629c2a16acdfd512fb6ff4bec8d27f9ae97841034db8e35931425ff82"}', '39adea92dc1a7ba45beaca0e29d34ad976f8b8c60620a2631154d90778de98cb', NULL, NULL, NULL);
INSERT INTO public.content VALUES (24, 'target', '{"emptied":false,"partition":"p_KNKSNAFMV8WDJAX9","read_pos":23,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', '8eac03a8c70e5e2089c1753fdef3604bc161f445337cb3e6fb23eb44b52f41c7', NULL, NULL, NULL);
INSERT INTO public.content VALUES (25, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-24T13:37:53.855Z","policy_version":1,"ruleset_version":1,"today":"2026-11-24"}', '246f04fd7ca88c972351f486d58f45a69ccee3572c5a87bc5b5d12576cc6e544', NULL, NULL, NULL);
INSERT INTO public.content VALUES (25, 'ops/0/target', '{"intent":"revoke","row":"r_WYXV2M27PD1JYV4HN68E5VAM13","table":"t1","ver":{"basis":"explicit","current":true,"op":17,"restore_count":0}}', 'c4e442fbce2fff6cae25598ab5c29f574dd88d6ecd516dee46f569bf7be62844', NULL, NULL, NULL);
INSERT INTO public.content VALUES (25, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (25, 'request_key', '{"key":"be064ce8a2041c9cba5d9fa50ad44bd107ca8af4c7361202764bf832b3f5539d"}', 'f65000c0ef0dd046706fc9eff0f389cb1cb58f8d8f620add2281381aa306e858', NULL, NULL, NULL);
INSERT INTO public.content VALUES (26, 'request', '{"intent":"revoke","row":"r_WYXV2M27PD1JYV4HN68E5VAM13","table":"household.expenses","ver":"v17.0"}', 'd115d0dfc80ffa8542ad5a67eaeebd22c3369537ccb45fb0deb9c2bc93a50ec2', NULL, NULL, NULL);
INSERT INTO public.content VALUES (26, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_6CESSAB8MX52ZN25"}', '1a0305eba834fd962580ab97596620d5d3188b3637f99ea35e73cf9dd846089d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (27, 'existence/0', '{"scope":"whole","status":"applied"}', '2f44b7beb399a814e1e20abc7d4ccfb73d0038177fbe9f78c3a9f6d7c497e5a2', NULL, NULL, NULL);
INSERT INTO public.content VALUES (27, 'op_sources', '[26]', '9cab0519f56f13acec86572516e8ebe7b99aa40011ec3171c9c8af90c08cae7a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (27, 'target', '{"cause":"request","intent":"revoke","op_index":0,"row":"r_WYXV2M27PD1JYV4HN68E5VAM13","sv":1,"table":"t1"}', '860e5e2a3a9ca26d47b1250b3084a82548415e748eeb2505772488b4cfb89133', NULL, NULL, NULL);
INSERT INTO public.content VALUES (28, 'target', '{"emptied":true,"partition":"p_MRN4XWHC2TN0RDW5","read_pos":27,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', 'cfe772ec9c238d2027e7444cbe20ab07162f3e9d412dc6ec1fd001a854e30c58', NULL, NULL, NULL);
INSERT INTO public.content VALUES (29, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-24T13:37:53.864Z","policy_version":1,"ruleset_version":1,"today":"2026-11-24"}', '2a3cd1552e86c5ca00ccb00398a91a10cc4202e5fe698290bc876d537e1f4b17', NULL, NULL, NULL);
INSERT INTO public.content VALUES (29, 'ops/0/set/f1', '"2026-11-04"', 'ba9fc93c7ed70a8b525f0a62023d41e1344542f7d58b17385ccc81443bf5421c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (29, 'ops/0/set/f2', '"9"', '986b79d4b69dffb1d19836f47b27073d95bf55201b3385aceb7e0687a21d8667', NULL, NULL, NULL);
INSERT INTO public.content VALUES (29, 'ops/0/set/f3', '"snack"', '176fabc59f5999b35a637537307adcad5b993e0c555bf86e403953b5bdd86a7e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (29, 'ops/0/target', '{"created":true,"intent":"insert","row":"r_P6M68GZNRN8N73T04M6G6NQC2W","table":"t1"}', '9f9ae3d8d33ebce448d0a275e316c823e7ca41f8fd1a6d3923a89971c5140945', NULL, NULL, NULL);
INSERT INTO public.content VALUES (29, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (29, 'request_key', '{"key":"ca36b33f30cfd5aa63f0d221efb6230516fb65d6831d9b27f61a6df2209ddd16"}', '91f7902e0cb54376b6609d06acdbc78bc46040491a5813537fa8fa83064b11d2', NULL, NULL, NULL);
INSERT INTO public.content VALUES (30, 'request', '{"intent":"insert","set":{"amount":9,"date":"2026-11-04","note":"snack"},"table":"household.expenses"}', '1e6e090a868923bafd27c360a50ab1d8bf00f4cedd7b02ccf64f898deee5a144', NULL, NULL, NULL);
INSERT INTO public.content VALUES (30, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_TMCNS0780BRHTVN6"}', 'c20b097e2697978288f161f9413c45ab054f29adbdc4930f092d136701457ac9', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'fields/f1/0', '{"status":"applied","value":"2026-11-04"}', '44b6698d9440c789295afb873b3ac44d7074d41b719e4df1a846a31176d561ca', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'fields/f2/0', '{"status":"applied","value":"9"}', '61a0d6511cffcfb500d40f4e295289bdaef54675ed7241046e86da526085d56b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'fields/f3/0', '{"status":"applied","value":"snack"}', '79e9d32653ca14f4fdcec42e8e4b56080f01c897eeec3b97c1e7f22fc968a812', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'literal/f1/0', '{"segments":[{"result":"na","source":30}]}', '7af69cfa023aa24d18ec68e07573f47a474e1d13da839998df0e1c363cf6f334', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'literal/f2/0', '{"segments":[{"result":"na","source":30}]}', '7af69cfa023aa24d18ec68e07573f47a474e1d13da839998df0e1c363cf6f334', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'literal/f3/0', '{"segments":[{"result":"na","source":30}]}', '7af69cfa023aa24d18ec68e07573f47a474e1d13da839998df0e1c363cf6f334', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'sources/f1/0', '[{"kind":"value","source":30}]', '75e656324aefbcea4bd4431d6f5bedfcd073b73471966079df82048672fc3d66', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'sources/f2/0', '[{"kind":"value","source":30}]', '75e656324aefbcea4bd4431d6f5bedfcd073b73471966079df82048672fc3d66', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'sources/f3/0', '[{"kind":"value","source":30}]', '75e656324aefbcea4bd4431d6f5bedfcd073b73471966079df82048672fc3d66', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'target', '{"cause":"request","created":true,"intent":"insert","op_index":0,"row":"r_P6M68GZNRN8N73T04M6G6NQC2W","sv":1,"table":"t1"}', '6187e5eae4699b73270477982c4ece066b80a6b19336702bb811a2b54e2ab09f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (32, 'checksum', '{"checksum":"352a37dda5548e17e41bc41d1faa41d33dfcf315b1b402cb40e86eb72eb109d9"}', 'f90a6949e3b50c947cbebb1eae26b3cd72eaadbef3fc613c8acfa2681db8358b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (32, 'key', '{"values":["2026-11-04"]}', '604bbd9e49c4a6737a3e5339db270d2778e5ed0ba7e814c136b4310d52da0b40', NULL, NULL, NULL);
INSERT INTO public.content VALUES (32, 'target', '{"emptied":false,"partition":"p_Y5VYNKS7DXE6MB8P","read_pos":31,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', 'c1b1cc416f2fd5801d7f3685ef433f5db93cb1415bba923d7e97c080ee5f7494', NULL, NULL, NULL);
INSERT INTO public.content VALUES (33, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-24T13:37:53.873Z","policy_version":1,"ruleset_version":1,"today":"2026-11-24"}', '2f4efc47cc90db9188f465a8bdc0b93190526d02edffaa3ede50bcc844e97865', NULL, NULL, NULL);
INSERT INTO public.content VALUES (33, 'ops/0/target', '{"intent":"revoke","row":"r_P6M68GZNRN8N73T04M6G6NQC2W","table":"t1","ver":{"basis":"explicit","current":true,"op":29,"restore_count":0}}', 'fd9d9946fe4ade8df434c011cdf11445ef62e24099d3189c1057f27c0fee850d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (33, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (33, 'request_key', '{"key":"0675fde3ddd9c52fd587c1f5a73cd4d4ecc7315f29b6312491c0660a06344a68"}', '55bba6385d373636ed40a5508a7920ac0db1cb5c5b61d9870c2cd118e5431bfe', NULL, NULL, NULL);
INSERT INTO public.content VALUES (34, 'request', '{"intent":"revoke","row":"r_P6M68GZNRN8N73T04M6G6NQC2W","table":"household.expenses","ver":"v29.0"}', 'bfce82dc1cc2962812b487274d69a9fd78b276dd84f0e3968ede26b7e0f1b44b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (34, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_5VWG38VSJWYKT3BV"}', 'a4d4fb3cea83661c078c67d94fc45b3f0ced8fa9326b4d0332d91a756366ff43', NULL, NULL, NULL);
INSERT INTO public.content VALUES (35, 'existence/0', '{"scope":"whole","status":"applied"}', '2f44b7beb399a814e1e20abc7d4ccfb73d0038177fbe9f78c3a9f6d7c497e5a2', NULL, NULL, NULL);
INSERT INTO public.content VALUES (35, 'op_sources', '[34]', 'cf898e079ee71e303468636c3d556a4b0748b4d896c226e31cbdc1f1c20932e5', NULL, NULL, NULL);
INSERT INTO public.content VALUES (35, 'target', '{"cause":"request","intent":"revoke","op_index":0,"row":"r_P6M68GZNRN8N73T04M6G6NQC2W","sv":1,"table":"t1"}', '2b06888ab1bff918511c9660885e341d60d3b60cc4dfc948fe05fe46f9cea9ff', NULL, NULL, NULL);
INSERT INTO public.content VALUES (36, 'target', '{"emptied":true,"partition":"p_Y5VYNKS7DXE6MB8P","read_pos":35,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', '34b7753e6f2b033caf98f7bde9dc56fd2e04ab39dba36df7ff7f5f099afaf9f3', NULL, NULL, NULL);
INSERT INTO public.content VALUES (37, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-24T13:37:53.881Z","policy_version":1,"ruleset_version":1,"today":"2026-11-24"}', '86f194e34addb7f719285d0a762f20031087192929b4e760d2449c0c906fb049', NULL, NULL, NULL);
INSERT INTO public.content VALUES (37, 'ops/0/revert', '{"include_later":false,"undo_op":33}', '79752873190e2f65f33153cf3fb49caa616976cd990b5b33a7504ff220add01b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (37, 'ops/0/target', '{"intent":"revoke","row":"r_P6M68GZNRN8N73T04M6G6NQC2W","table":"t1"}', '6a1253f77b03ddbfd3afa3a4c2266650a583378a61b2c985085d4806e60b4aa9', NULL, NULL, NULL);
INSERT INTO public.content VALUES (37, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (37, 'request_key', '{"key":"6a54f87a7030d20a8a7f649541a09c0e00c1de197adf775e1107c3733cc77897"}', '0eaf20cb2f1608dcc7f348b95190a4241f802d78dec9590342e29117dc77adb3', NULL, NULL, NULL);
INSERT INTO public.content VALUES (38, 'request', '{"revert":{"undo":33},"row":"r_P6M68GZNRN8N73T04M6G6NQC2W","table":"household.expenses"}', 'f7ef66cb02c3ba409395039ac122cc7209b47a3fc1c6b66789c77e1dcad04fde', NULL, NULL, NULL);
INSERT INTO public.content VALUES (38, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_96RAFB07HEXD0K55"}', 'da30460f3a1b1bc19de587fcd9dd38cf575749e9337696444b0c3eaebfaed510', NULL, NULL, NULL);
INSERT INTO public.content VALUES (39, 'existence/0', '{"restored":true,"scope":"whole","status":"applied"}', '989e2e5071049ed6593c6ff63c96b6521f8c23fc8e1bfa4eb479dfb610f5a74f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (39, 'op_sources', '[38]', '3c2487b1e732eb168accd2f394b776519932cd77d5b74840e575428a0e87b71d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (39, 'revert', '{"before_op":33,"items":[{"event":35,"existence":true}]}', 'dcab9f5b1aecea8241e226a5962f39fff3421dc142c03c109ddf69dd08a2f9cd', NULL, NULL, NULL);
INSERT INTO public.content VALUES (39, 'target', '{"cause":"request","intent":"revoke","op_index":0,"row":"r_P6M68GZNRN8N73T04M6G6NQC2W","sv":1,"table":"t1"}', '2b06888ab1bff918511c9660885e341d60d3b60cc4dfc948fe05fe46f9cea9ff', NULL, NULL, NULL);
INSERT INTO public.content VALUES (40, 'checksum', '{"checksum":"352a37dda5548e17e41bc41d1faa41d33dfcf315b1b402cb40e86eb72eb109d9"}', 'f90a6949e3b50c947cbebb1eae26b3cd72eaadbef3fc613c8acfa2681db8358b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (40, 'target', '{"emptied":false,"partition":"p_Y5VYNKS7DXE6MB8P","read_pos":39,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', '770b091929fcb14b386a167d633af5f2d5ac9d69de3371df7574ee13990d19bc', NULL, NULL, NULL);
INSERT INTO public.content VALUES (41, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-24T13:37:53.890Z","policy_version":1,"ruleset_version":1,"today":"2026-11-24"}', '4402088a7bd6b64c25c43e7766e264fe53213787c20705bdc5cdf9354b9ac2e1', NULL, NULL, NULL);
INSERT INTO public.content VALUES (41, 'ops/0/set/f2', '"32"', 'ca30de1c42bd3e0fdbeb7fb612cbf42e8e757b6948b7a51a67827df28b65107b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (41, 'ops/0/target', '{"intent":"update","row":"r_0HX0BEZ3J96GW8CYMYXVCKKK7Y","table":"t1","ver":{"basis":"explicit","current":true,"op":13,"restore_count":0}}', '4022d6f0d70428358e3a7f313d168cd4d2efc6871dc079b325b266cd8514a845', NULL, NULL, NULL);
INSERT INTO public.content VALUES (41, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (41, 'request_key', '{"key":"3f3dbbc2a762de62af9c68c543e72c45a4dc853ca86046c0e84c75fc0792edc7"}', 'ce23c7fed382c117518783d2b7c2f44ee212da9e5143204a49883a188d06ad8c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (42, 'request', '{"intent":"update","row":"r_0HX0BEZ3J96GW8CYMYXVCKKK7Y","set":{"amount":32},"table":"household.expenses","ver":"v13.0"}', '5e9a61f6c35e6a541793c7863b2d1fcae514ad02cdfbf3d93c2c5d7622675cad', NULL, NULL, NULL);
INSERT INTO public.content VALUES (42, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_F0CVVBSPRXMN912X"}', '7da66e97520b809ad521a23614c29deb225e37ddfabb2be3451614b4d6e117fa', NULL, NULL, NULL);
INSERT INTO public.content VALUES (43, 'fields/f2/0', '{"status":"applied","value":"32"}', 'd01ac326febf20813c49818b031035331a6f1e7ded0b73a8b97106cec8d47823', NULL, NULL, NULL);
INSERT INTO public.content VALUES (43, 'literal/f2/0', '{"segments":[{"result":"na","source":42}]}', '1a687bdc91fa9ef800597fc2cd0f41c7108d749595bed18fb74240e3f9ea68ad', NULL, NULL, NULL);
INSERT INTO public.content VALUES (43, 'sources/f2/0', '[{"kind":"value","source":42}]', '3e7a7b48647625cc8a330c1532e3369fce25d168ab0f7550f5277aa9ece719ea', NULL, NULL, NULL);
INSERT INTO public.content VALUES (43, 'target', '{"cause":"request","intent":"update","op_index":0,"row":"r_0HX0BEZ3J96GW8CYMYXVCKKK7Y","sv":1,"table":"t1"}', '75bd39aaf18c6c05c335644dcd821d439139a26df3eb6c54000f1049aa79ff2e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (44, 'checksum', '{"checksum":"5aa3eee0bb3c73e7b833ae4779c454cd1706ac1c695777f62fbac858f284a139"}', 'a21a42a61794912949d594a6d2bf584300603cc131bfa770b320ee28bf982b08', NULL, NULL, NULL);
INSERT INTO public.content VALUES (44, 'target', '{"emptied":false,"partition":"p_KNKSNAFMV8WDJAX9","read_pos":43,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', 'dbb3072f7b053a9066a42b7ea10a0726ca26e0ac746530ab3f9b8e11ceea519e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (45, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-24T13:37:53.899Z","policy_version":1,"ruleset_version":1,"today":"2026-11-24"}', 'c33ec89df446499173d1846d00e2a6870fa1e7481057842093e2f18ddac938cf', NULL, NULL, NULL);
INSERT INTO public.content VALUES (45, 'ops/0/set/f2', '"35"', '4bf17f4cd842cc1812f81a696010ee962c1c6f4db784a26b47cfde3144db8ae4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (45, 'ops/0/target', '{"intent":"update","row":"r_0HX0BEZ3J96GW8CYMYXVCKKK7Y","table":"t1","ver":{"basis":"explicit","op":13,"restore_count":0}}', '92a9d0a8e8f5ebce569787f42c9944a126d6dc1c5b4f85cc4a6754403bc54a31', NULL, NULL, NULL);
INSERT INTO public.content VALUES (45, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (45, 'request_key', '{"key":"cf0b7cf66e1e0e49d55f2731a118f9c3fbd03cc826c97585ca69415b7f9bdb97"}', '41a0722d9eebfdb418f3f375c1552a1ce9b9d3695daddb2254111b6922e92ebe', NULL, NULL, NULL);
INSERT INTO public.content VALUES (46, 'request', '{"intent":"update","row":"r_0HX0BEZ3J96GW8CYMYXVCKKK7Y","set":{"amount":35},"table":"household.expenses","ver":"v13.0"}', '7d733f577c0c1d5d0a216b93ce4bcffe9f7dacbc8b8fd83c7cb9c34e00219502', NULL, NULL, NULL);
INSERT INTO public.content VALUES (46, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_830SRXDQRW12W5RS"}', '33aef35b39b523cccc253329763e12dd5eb85fac88933228740b7fbb8135c7f9', NULL, NULL, NULL);
INSERT INTO public.content VALUES (47, 'fields/f2/0', '{"status":"candidate","value":"35"}', '0a46b36e4a8dcb521e89b693b64fb7ed71b710c7c253e001ab2d859ae7e6c13c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (47, 'literal/f2/0', '{"segments":[{"result":"na","source":46}]}', 'ec9a7df5f7d36e2816c86bda732347207da16137a062374518ad63eab7918133', NULL, NULL, NULL);
INSERT INTO public.content VALUES (47, 'sources/f2/0', '[{"kind":"value","source":46}]', 'b073fca649b906c9bf85d19138aa9815cd7bdf17d1dc4c51b535ded225066ef9', NULL, NULL, NULL);
INSERT INTO public.content VALUES (47, 'target', '{"cause":"request","intent":"update","op_index":0,"row":"r_0HX0BEZ3J96GW8CYMYXVCKKK7Y","sv":1,"table":"t1"}', '75bd39aaf18c6c05c335644dcd821d439139a26df3eb6c54000f1049aa79ff2e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (48, 'candidates/0', '{"cause":"stale_write","deps":[{"event":47,"field":"f2","k":0}],"event":47,"intent":"update","items":[{"field":"f2","k":0,"value":"35"}],"seen":{"op":13,"restore_count":0}}', '065fc524c2f0fbb871cfbd39e9ee0066e0b87479a0bff27648841667910e752f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (48, 'current/0', '{"deps":[{"event":43,"field":"f2","k":0}],"field":"f2","op":41,"value":"32"}', '0c88032ef80c150050b77d11b9327972c67ab4ea3a6fbb5b5b8949dc6ef4dbb2', NULL, NULL, NULL);
INSERT INTO public.content VALUES (48, 'impact/0', '{"deps":[{"event":43,"field":"f2","k":0}],"kind":"reverted_write","op":41}', '781a112cf029985289bd07f26a2dea668fd6e9323c41b08e9dd99a5e79592e45', NULL, NULL, NULL);
INSERT INTO public.content VALUES (48, 'previous/0', '{"deps":[{"event":15,"field":"f2","k":0}],"field":"f2","value":"30"}', 'fae62666626a12c8b83c7a340e9588ee0da9a0d3a64b6136433e8578e60f82cc', NULL, NULL, NULL);
INSERT INTO public.content VALUES (48, 'target', '{"item":"pi_12CVJYSZ2KWRQ1BM","merge_base_op":13,"origin_event":47,"policy_version":1,"reason":"stale_write","row":"r_0HX0BEZ3J96GW8CYMYXVCKKK7Y","ruleset_version":1,"table":"t1","type":"conflict","unit":["f2"]}', '759388327f8b2b19c2229bfda57ba29ab99ab107d7e2e1bd3b6d7f750cd52e2c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (49, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-24T13:37:53.908Z","policy_version":1,"ruleset_version":1,"today":"2026-11-24"}', '6e870014ccaf2ec6e104724018af3980b20ed1f119afd7f1395daa983adcbc86', NULL, NULL, NULL);
INSERT INTO public.content VALUES (49, 'ops/0/premises/0', '{"fields":["f2"],"range":"whole","row":"r_V6RH9FFY9J354M7G13BA6D3XHV","state":"current","table":"t1","ver":{"basis":"explicit","op":21,"restore_count":0}}', '18f73138039b7afb4ea20fc4d832c18b4a7e8134f97aa0f8c7ac57ee7b1fece9', NULL, NULL, NULL);
INSERT INTO public.content VALUES (49, 'ops/0/set/f1', '"half of lunch"', 'c41224c57a8fe82b0d2e8c579ce6599dedf399a406007932a8013d383f495748', NULL, NULL, NULL);
INSERT INTO public.content VALUES (49, 'ops/0/set/f2', '"r_V6RH9FFY9J354M7G13BA6D3XHV"', 'd1a0f6b78c14c0f18f72c491df8562e455723d892794084da9ad49a081a7b4c9', NULL, NULL, NULL);
INSERT INTO public.content VALUES (49, 'ops/0/target', '{"created":true,"intent":"insert","row":"r_JR16J09DDPW9EX54GFQVWTQGBJ","table":"t4"}', '4338289bacf858b2d9b808106736facde2b4a042d0b5a1f062c65fe3b8600a71', NULL, NULL, NULL);
INSERT INTO public.content VALUES (49, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (49, 'request_key', '{"key":"e55e151821754aa4538ab89f8eda6be9e3e7ce4824385102f1252e92d56769c5"}', 'cbd7afb8f7c590383c9332257dd50dfc0426b8c7ecaca47368194c1d9da37ba3', NULL, NULL, NULL);
INSERT INTO public.content VALUES (50, 'request', '{"intent":"insert","premises":[{"fields":["amount"],"row":"r_V6RH9FFY9J354M7G13BA6D3XHV","table":"household.expenses","ver":"v21.0"}],"set":{"expense":"r_V6RH9FFY9J354M7G13BA6D3XHV","note":"half of lunch"},"table":"household.refunds"}', 'f096075d63f3cc678894119a61baa5fadadc132edd37db818ccec2d01605d4f4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (50, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_19JCPXTDW026H4EX"}', '8c257f7404be71506f7ec7c288092e0aedb4618b028cef46a5d287dff825c45d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (51, 'fields/f1/0', '{"status":"applied","value":"half of lunch"}', '6731b651c19eec0bf119411356eedb0d936803628773af9b41f5c8023511d907', NULL, NULL, NULL);
INSERT INTO public.content VALUES (51, 'fields/f2/0', '{"status":"applied","value":"r_V6RH9FFY9J354M7G13BA6D3XHV"}', '812fbfaf93acbc3a9bd8f0a267053e27edd2eb44479e029762755f2f5969dcbe', NULL, NULL, NULL);
INSERT INTO public.content VALUES (51, 'literal/f1/0', '{"segments":[{"result":"na","source":50}]}', '47b1956d41eaa447fffc4d8db1ff7cdb9186a0bf686582c5531d51a398c87729', NULL, NULL, NULL);
INSERT INTO public.content VALUES (51, 'literal/f2/0', '{"segments":[{"result":"na","source":50}]}', '47b1956d41eaa447fffc4d8db1ff7cdb9186a0bf686582c5531d51a398c87729', NULL, NULL, NULL);
INSERT INTO public.content VALUES (51, 'sources/f1/0', '[{"kind":"value","source":50}]', 'cd8ffd1b682a43ec63e90b2f0816a49abf4870fae625151a8e201616ea0c273d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (51, 'sources/f2/0', '[{"kind":"value","source":50}]', 'cd8ffd1b682a43ec63e90b2f0816a49abf4870fae625151a8e201616ea0c273d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (51, 'target', '{"cause":"request","created":true,"intent":"insert","op_index":0,"row":"r_JR16J09DDPW9EX54GFQVWTQGBJ","sv":1,"table":"t4"}', '3b091ecf178a27217c674d2cc4e5f3c4c4393326cfac1a77e6994a810a42b685', NULL, NULL, NULL);
INSERT INTO public.content VALUES (52, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-24T13:37:53.915Z","policy_version":1,"ruleset_version":1,"today":"2026-11-24"}', '31c76f0526a9fe5774e1b817fab46216622cbd64ffd20a7197d28fb45a5798e4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (52, 'ops/0/set/f1', '"food"', '90960c7a6145a97cbb09d6478535c2b31f76050310286dabe9ae2463ee003850', NULL, NULL, NULL);
INSERT INTO public.content VALUES (52, 'ops/0/set/f2', '"5000"', '804856326d54d734f3b3212c16f6eef4ed73817278ad5262df1c40fc895feaca', NULL, NULL, NULL);
INSERT INTO public.content VALUES (52, 'ops/0/target', '{"by_entity_key":true,"created":true,"entity":"e_TN6Z27K0HG01R6Y4YKV6W64XSN","intent":"update","table":"t2"}', '14f60f9792e6be5e6f28cd205eda60e6e266dd19ba717916573fe7886bbb3867', NULL, NULL, NULL);
INSERT INTO public.content VALUES (52, 'ops/0/valid', '{"from":{"mode":"given","value":"2026-10-01"},"to":{"mode":"next_change"}}', '7273cec08b6fc076559e36a924c20ca07cbb746cfbe55c1528defa8ee63e7692', NULL, NULL, NULL);
INSERT INTO public.content VALUES (52, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (52, 'request_key', '{"key":"cc8522457fb7d1817826d24bd2c5f4c03a146cfe2bdd5f5e956addf51ef1f75c"}', '7ee30dbe4efef3114caad93caa741f2b35394c87d130a0611de71414c3d60c2e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (53, 'request', '{"entity_key":{"kind":"food"},"intent":"update","set":{"amount":5000},"table":"household.budgets","valid_from":"2026-10-01"}', 'e8c41a2624b6b6a263306b0402ba6c0950daa36a0e9f1dc65ef3082e621faa1e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (53, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_PM4X4ERVWE959Q02"}', 'dfaa99f0064788f4e7ec0ebdc8e29f8106eb2e744aeb445fd2bbc79fe5f489e8', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'fields/f1/0', '{"status":"applied","value":"food"}', '3ce851fafc17dadf27fb8a73401c468b44acda2ff106fc54a0c477d259dd9fb7', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'fields/f2/0', '{"status":"applied","value":"5000"}', '0b0ab42381e2bb4d2859ec1864e72f7807787fd2bad4a716a2874538ba39f214', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'literal/f1/0', '{"segments":[{"result":"na","source":53}]}', 'b82e3ae156e1b50b66bf59d1eb89210ade76c884a0f4c0e8a77ece34fafe938a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'literal/f2/0', '{"segments":[{"result":"na","source":53}]}', 'b82e3ae156e1b50b66bf59d1eb89210ade76c884a0f4c0e8a77ece34fafe938a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'sources/f1/0', '[{"kind":"value","source":53}]', 'b863cc4850ac41d72e8c726892506c422beb9b9afad12203c31d774c5e150d73', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'sources/f2/0', '[{"kind":"value","source":53}]', 'b863cc4850ac41d72e8c726892506c422beb9b9afad12203c31d774c5e150d73', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'span/f1/0', '{"valid":{"from":"2026-10-01"}}', '80ba5cd58b91a2bf147edd7b90037d2a0c0f3aa70102ecbfa4458a539d352912', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'span/f2/0', '{"valid":{"from":"2026-10-01"}}', '80ba5cd58b91a2bf147edd7b90037d2a0c0f3aa70102ecbfa4458a539d352912', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'target', '{"cause":"request","created":true,"entity":"e_TN6Z27K0HG01R6Y4YKV6W64XSN","intent":"update","op_index":0,"sv":1,"table":"t2"}', '865b65ac0d1f50987ea4237d87ff918ed8b0b361c27f5876c4c5d400100facfc', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'valid_sources', '[53]', '17673dea3b100a600846ee04777d0c0c2379258f5b5cb1757f7a36f4956a6c41', NULL, NULL, NULL);
INSERT INTO public.content VALUES (55, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-24T13:37:53.923Z","policy_version":1,"ruleset_version":1,"today":"2026-11-24"}', '077aee19427543bedbf2d482d8ac3bb4dc570732f43a82921124313e0ba0ad19', NULL, NULL, NULL);
INSERT INTO public.content VALUES (55, 'ops/0/noop', '["f1"]', '6dbd1ae38d591a1d8818e127651ac0a0c7f78f1d180b0aa1aefb82008c3b0758', NULL, NULL, NULL);
INSERT INTO public.content VALUES (55, 'ops/0/set/f2', '"4000"', '91197d7b81dc27b9b94cf890932114c5ab712da496885ba5cc01ee4617bfaae0', NULL, NULL, NULL);
INSERT INTO public.content VALUES (55, 'ops/0/target', '{"by_entity_key":true,"entity":"e_TN6Z27K0HG01R6Y4YKV6W64XSN","intent":"update","table":"t2","ver":{"basis":"fallback","current":true,"op":52,"restore_count":0}}', '52ff47a02fbd125575538f7fb3ffcb93998a0194d41324e12647318b801c1c27', NULL, NULL, NULL);
INSERT INTO public.content VALUES (55, 'ops/0/valid', '{"from":{"mode":"given","value":"2026-11-10"},"to":{"mode":"next_change"}}', '7c600349a954d222ff1f1271eaa0a9c540445c22d7e96a9a016d8d264664137a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (55, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (55, 'request_key', '{"key":"e5e6dd6ae0f019eb87c380a12963e95ec428bc4f15c523f99bb967c6fc4a693a"}', 'fd17d15f3484cf2f37c5b5f449f5759eed382e7b836b8840ef3b8b2ff68fbf52', NULL, NULL, NULL);
INSERT INTO public.content VALUES (56, 'request', '{"entity_key":{"kind":"food"},"intent":"update","set":{"amount":4000},"table":"household.budgets","valid_from":"2026-11-10"}', '6de8c7b6772863dbbc50ebe46df7d75ea76e1602bc6d40942a71951ee91c85af', NULL, NULL, NULL);
INSERT INTO public.content VALUES (56, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_5SCVZEE0VS32YXZ4"}', '2705d374ba9a0a42838926f4c3b7b09663cdb0610f5f88516acd3ffed53437b1', NULL, NULL, NULL);
INSERT INTO public.content VALUES (57, 'fields/f2/0', '{"status":"applied","value":"4000"}', '8e23d82c7ddbe448c60657d8ef710ec0874d39aa72be68e930cab31f55ed2c3c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (57, 'literal/f2/0', '{"segments":[{"result":"na","source":56}]}', 'b903cb2ddcbb0e12413687f6058f52d2b871ebf7330699e026a4a5a316848009', NULL, NULL, NULL);
INSERT INTO public.content VALUES (57, 'sources/f2/0', '[{"kind":"value","source":56}]', '593e1a291dbc0675ec506bfa03f88dc9ca033e93fa172bb081c78882c74de2c0', NULL, NULL, NULL);
INSERT INTO public.content VALUES (57, 'span/f2/0', '{"valid":{"from":"2026-11-10"}}', '3b11f29fa3cdd8a4f4128418a46b42c472731a46787965a030d57bd4bc9016ee', NULL, NULL, NULL);
INSERT INTO public.content VALUES (57, 'target', '{"cause":"request","entity":"e_TN6Z27K0HG01R6Y4YKV6W64XSN","intent":"update","op_index":0,"sv":1,"table":"t2"}', '4d2e7f98d8c67bf0e23f8a2809b425754151103d52ee61aaafbce5ceeb98e862', NULL, NULL, NULL);
INSERT INTO public.content VALUES (57, 'valid_sources', '[56]', '0494aeb56d68d0683dcdc2856752cd331cb1a9112b239e9a529519dbe29e3e63', NULL, NULL, NULL);
INSERT INTO public.content VALUES (58, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-24T13:37:53.929Z","policy_version":1,"ruleset_version":1,"today":"2026-11-24"}', '98d93bdf94823a42ab3b0dc3d4190f709338e8eecc5354acfd10682fb2ce25bf', NULL, NULL, NULL);
INSERT INTO public.content VALUES (58, 'ops/0/noop', '["f1"]', '6dbd1ae38d591a1d8818e127651ac0a0c7f78f1d180b0aa1aefb82008c3b0758', NULL, NULL, NULL);
INSERT INTO public.content VALUES (58, 'ops/0/set/f2', '"4500"', 'bf1ac8b2c5a894f0bb4ebd1fb15ab12d2c6a92bd0fe856d165f96705ef3bd2f5', NULL, NULL, NULL);
INSERT INTO public.content VALUES (58, 'ops/0/target', '{"by_entity_key":true,"entity":"e_TN6Z27K0HG01R6Y4YKV6W64XSN","intent":"update","table":"t2","ver":{"basis":"fallback","current":true,"op":55,"restore_count":0}}', 'c39812211fc0b27e8b0dbbcd5be0e907b830a2f3f9066d6e2c8f956b681cb49b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (58, 'ops/0/valid', '{"from":{"mode":"given","value":"2026-10-15"},"to":{"mode":"open"}}', '5d334a626a7551e0201ad822cbaca0e27e317959d36d6fdbcbf24f69dc964360', NULL, NULL, NULL);
INSERT INTO public.content VALUES (58, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (58, 'request_key', '{"key":"8ee90a51a5bfb825ad32e50c224318ba69754cce48c64a70b73c648ef26300dc"}', 'e52c691914b186e9fb95f02b532400f25b994b8a593494b8cad08c97f2f1623a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (59, 'request', '{"entity_key":{"kind":"food"},"intent":"update","set":{"amount":4500},"table":"household.budgets","valid_from":"2026-10-15","valid_to":"open"}', 'c5d2dd03b95734ba4f02adf9455032dc2b9ed7da85f1b4e9b380424b0cadfa96', NULL, NULL, NULL);
INSERT INTO public.content VALUES (59, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_75VFD0FRS3NKN8A5"}', '428ca1c80548d52ccaddd17882ee7df43d50283d688b0fd4d8dd11948e537bed', NULL, NULL, NULL);
INSERT INTO public.content VALUES (60, 'fields/f2/0', '{"status":"awaiting","value":"4500"}', 'f288797fe8e450502df4528235299c293b805ae7d783357cf4b339617a2c52c6', NULL, NULL, NULL);
INSERT INTO public.content VALUES (60, 'literal/f2/0', '{"segments":[{"result":"na","source":59}]}', 'ef6f298ec294bf8b4ed2361ce3505c6bd7a185b4f16a066d5e0b80387b7f5db4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (60, 'sources/f2/0', '[{"kind":"value","source":59}]', 'ee85e2dc2bc2423f1d88a9ca67df8394e495c9665b1425dce963b25eff9c454d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (60, 'span/f2/0', '{"valid":{"from":"2026-10-15"}}', 'e6c0c70a14cb53d847c607a85603c051efee5a3734f0fb019615c85467cf1daf', NULL, NULL, NULL);
INSERT INTO public.content VALUES (60, 'target', '{"cause":"request","entity":"e_TN6Z27K0HG01R6Y4YKV6W64XSN","intent":"update","op_index":0,"sv":1,"table":"t2"}', '4d2e7f98d8c67bf0e23f8a2809b425754151103d52ee61aaafbce5ceeb98e862', NULL, NULL, NULL);
INSERT INTO public.content VALUES (60, 'valid_sources', '[59]', '8f332db1356cb4786b468baab31bd75565bd751de9d984c92f9defbcc3ef172d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (67, 'ops/0/set/f3', '"12"', 'f9cacf3cb91a12e03bc4546834f95a50a4c5fe02276ac260148ea9296c442d39', NULL, NULL, NULL);
INSERT INTO public.content VALUES (61, 'current/0', '{"deps":[{"event":54,"field":"f2","k":0},{"event":57,"field":"f2","k":0},{"event":60,"field":"f2","k":0}],"field":"f2","op":52,"valid":{"from":"2026-10-15","to":"2026-11-10"},"value":"5000"}', '8073ae020c7890dea4e8000244d5f09095bed94efc3bbb260e09d99fccc843b9', NULL, NULL, NULL);
INSERT INTO public.content VALUES (61, 'current/1', '{"deps":[{"event":57,"field":"f2","k":0},{"event":60,"field":"f2","k":0}],"field":"f2","op":55,"valid":{"from":"2026-11-10"},"value":"4000"}', '12f8ff850df0f03ec83a43948411596d07d4044c5bc8f5519f8b066d63952ed7', NULL, NULL, NULL);
INSERT INTO public.content VALUES (61, 'impact/0', '{"deps":[{"event":54,"field":"f2","k":0},{"event":57,"field":"f2","k":0}],"field":"f2","kind":"overwritten_segment","op":52,"valid":{"from":"2026-10-15","to":"2026-11-10"},"value":"5000"}', '521fcc9f665137202a0ee51b79c5fe138d455d5d84ea89ce907809f9818960d3', NULL, NULL, NULL);
INSERT INTO public.content VALUES (61, 'impact/1', '{"deps":[{"event":57,"field":"f2","k":0}],"field":"f2","kind":"overwritten_segment","op":55,"valid":{"from":"2026-11-10"},"value":"4000"}', 'e2fe93e6bad541bd07dd7dc8b01c7c127aa53b6706e4e1e6302bdb61f0cf1afd', NULL, NULL, NULL);
INSERT INTO public.content VALUES (61, 'proposed/0', '{"deps":[{"event":60,"field":"f2","k":0}],"field":"f2","valid":{"from":"2026-10-15"},"value":"4500"}', 'f6faa8aff2ad990c5fd52f61ef4b8d9cdf80e7d8aac5f2ffc3f249a0100f640e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (61, 'scope_valid', '{"deps":[{"event":60,"field":"f2","k":0}],"spans":[{"from":"2026-10-15"}]}', 'f698a8f359bb795e6eecf79a199215ba88cfb1957109b0749c970a193722b048', NULL, NULL, NULL);
INSERT INTO public.content VALUES (61, 'target', '{"entity":"e_TN6Z27K0HG01R6Y4YKV6W64XSN","item":"pi_V5DG105Z5F8C254R","origin_event":60,"policy_version":1,"reason":"overwrites_change_point","ruleset_version":1,"table":"t2","type":"awaiting_confirmation","unit":["f2"]}', '364c2f1b31c544e157dab296e97c8172edeff3157601a0a47b4f711ed14e274c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-24T13:37:53.939Z","policy_version":1,"ruleset_version":1,"today":"2026-11-24"}', 'f03c31f64e092c23491c08679e3aec08de9a382c8c1b0b472ab394143909051f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ops/0/set/f1', '"app"', '4e5ef144c51cd25230c144c3e1d8e842b9860b7a3cec2699d4e24e6517fc4b20', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ops/0/set/f2', '"k-1"', 'f613e2ddb1ed1aefc2d87a1bc773c3a3e671f40809ffe8875486d58482e5259a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ops/0/set/f3', '"10"', '536549599ec6c3b859cd3970025779a13d061783c73e663fea7f963e98379aa8', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ops/0/target', '{"by_external_key":true,"created":true,"intent":"update","row":"r_KNQKC0R2AV1WCSEBTX0FEV6DGV","table":"t3"}', '81e68e6abce27e4ae35d027c29258d3f6b3acda0d7905ac83044ca64cfec9295', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ops/1/set/f1', '"app"', '4e5ef144c51cd25230c144c3e1d8e842b9860b7a3cec2699d4e24e6517fc4b20', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ops/1/set/f2', '"k-2"', '242ae761454b02109f6b54c9077c298d68e7e96cf0087859efa80e54073f77aa', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ops/1/set/f3', '"21"', '6f8f349216adc47cfd723001f3dfbfc11179e1b36c31ce51c85056026f3d85b9', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ops/1/target', '{"by_external_key":true,"created":true,"intent":"update","row":"r_F9TJVJHQ32G09A15Z9520CN9CN","table":"t3"}', '6f39b86b3602a4c7e115d1bfde06f293b34c15344fdb2465205bceccd4df3e6e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'request', '{"op_count":2,"sv":1,"sv_basis":"explicit"}', 'e0cec6f32835f484f2a07b4776a1164f5e0b3d4ad918e86e9d189d29fce17780', NULL, NULL, NULL);
INSERT INTO public.content VALUES (63, 'request', '{"external_key":{"external_id":"k-1","origin":"app"},"intent":"update","set":{"fare":10},"table":"household.rides"}', '602bd852c41aaef9948bac4e79a237bad5b2c4ee7f721a2a8e6d4f5b741c490b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (63, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_DPS27VK22TQC1MVW"}', '152c62d693c26570808d22823d8978243686eb9017cb452a90d75651cb8bc765', NULL, NULL, NULL);
INSERT INTO public.content VALUES (64, 'request', '{"external_key":{"external_id":"k-2","origin":"app"},"intent":"update","set":{"fare":21},"table":"household.rides"}', '9070f120653e01cb1fdfa2c01ae8d9c0a844e997d9435b4f4ef900dd4ab4476f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (64, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":1,"source_id":"s_FPDSYKH7B081MMN6"}', '210dedd98b99911de7ed5aaf9345e656b35c24920831fe19ae284312c0f0a85f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'fields/f1/0', '{"status":"applied","value":"app"}', 'c0f87af78708bddb29d36c257c2d3a389a9a16d6077ecd1f72132e2c36458a46', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'fields/f2/0', '{"status":"applied","value":"k-1"}', 'f1b5335622ffbf0c57f3cb8d1242f129d57eec003bddfd855a7ed1c5a204a1ca', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'fields/f3/0', '{"status":"applied","value":"10"}', 'c5d6a3109242c147dbe9c262ab4ffa606fdb23aeab545dcd9f6edd4229e4746d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'literal/f1/0', '{"segments":[{"result":"na","source":63}]}', 'e0841b0f39d829865177ccca851114fb9e7a5f13ced5e90f3d3327678303633a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'literal/f2/0', '{"segments":[{"result":"na","source":63}]}', 'e0841b0f39d829865177ccca851114fb9e7a5f13ced5e90f3d3327678303633a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'literal/f3/0', '{"segments":[{"result":"na","source":63}]}', 'e0841b0f39d829865177ccca851114fb9e7a5f13ced5e90f3d3327678303633a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'sources/f1/0', '[{"kind":"value","source":63}]', 'b3dcee24b53b92ebf82de486dc7e1f5721207475796e39f5ccf7c765c022c434', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'sources/f2/0', '[{"kind":"value","source":63}]', 'b3dcee24b53b92ebf82de486dc7e1f5721207475796e39f5ccf7c765c022c434', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'sources/f3/0', '[{"kind":"value","source":63}]', 'b3dcee24b53b92ebf82de486dc7e1f5721207475796e39f5ccf7c765c022c434', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'target', '{"cause":"request","created":true,"intent":"update","op_index":0,"row":"r_KNQKC0R2AV1WCSEBTX0FEV6DGV","sv":1,"table":"t3"}', '170e952ecbab0d28b644e979caafe86f258dec400fb18bd33968fa5da157f202', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'fields/f1/0', '{"status":"applied","value":"app"}', 'c0f87af78708bddb29d36c257c2d3a389a9a16d6077ecd1f72132e2c36458a46', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'fields/f2/0', '{"status":"applied","value":"k-2"}', 'a00fb3f1544a5603c809d0f2c45478c13646761f47ee0ae70eceacfc5973e616', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'fields/f3/0', '{"status":"applied","value":"21"}', 'db2af3002b6b171e6a8ddf6ac2b6b0d0afbeaa88d898be80c8493e77e97a47fd', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'literal/f1/0', '{"segments":[{"result":"na","source":64}]}', '33c84a6f0c71d09e6d7804f71b7e8a38bbd3ff78740063cb982ad2858f322260', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'literal/f2/0', '{"segments":[{"result":"na","source":64}]}', '33c84a6f0c71d09e6d7804f71b7e8a38bbd3ff78740063cb982ad2858f322260', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'literal/f3/0', '{"segments":[{"result":"na","source":64}]}', '33c84a6f0c71d09e6d7804f71b7e8a38bbd3ff78740063cb982ad2858f322260', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'sources/f1/0', '[{"kind":"value","source":64}]', '58b096f741dec54695b0d08a032222f771639c9bcb2dd1fa941aa16fd6baade4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'sources/f2/0', '[{"kind":"value","source":64}]', '58b096f741dec54695b0d08a032222f771639c9bcb2dd1fa941aa16fd6baade4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'sources/f3/0', '[{"kind":"value","source":64}]', '58b096f741dec54695b0d08a032222f771639c9bcb2dd1fa941aa16fd6baade4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'target', '{"cause":"request","created":true,"intent":"update","op_index":1,"row":"r_F9TJVJHQ32G09A15Z9520CN9CN","sv":1,"table":"t3"}', 'd67c6592a1ca2a23bcfd250020af9a1c3fb6bfe421c08b668c7588ab55e25d17', NULL, NULL, NULL);
INSERT INTO public.content VALUES (67, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-24T13:37:53.948Z","policy_version":1,"ruleset_version":1,"today":"2026-11-24"}', '44f88ec8ca0dd0cb2a881ad5f6020219114226a7f862c3cee383275ef8ff8530', NULL, NULL, NULL);
INSERT INTO public.content VALUES (67, 'ops/0/baseline', '{"f3":62}', '850f6f2f9e33426a9e5b1b478f780ef8e999f86ad52151a509a7c4f9f7864a44', NULL, NULL, NULL);
INSERT INTO public.content VALUES (67, 'ops/0/noop', '["f1","f2"]', '8fd6f2004d3e89f6c04b595c49979ed48da7f355575a31f9ae6a2456b6c9bca4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (67, 'ops/0/target', '{"by_external_key":true,"intent":"update","row":"r_KNQKC0R2AV1WCSEBTX0FEV6DGV","table":"t3","ver":{"basis":"external_key","op":62,"restore_count":0}}', '6642e1763738f0909c891ebeb7a218d34bf0c57c73aabb59c055d1ab42bfb23f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (67, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (68, 'request', '{"external_key":{"external_id":"k-1","origin":"app"},"intent":"update","set":{"fare":12},"table":"household.rides"}', '78ff3623de3e1aca1b75daff2eecf8abd849fec8d2acd8cfd01d39fd79dd241c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (68, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_37WDY1330VQF7Q9H"}', 'f61719924a13bbc544fc8be31a6b4e98cb3d7bad8656859f7b82979a5816c359', NULL, NULL, NULL);
INSERT INTO public.content VALUES (69, 'fields/f3/0', '{"status":"applied","value":"12"}', 'ea590704ad6cb667a1c44e5aee91b061a120ea192f3fb3d6c64f11c2ca83fcf8', NULL, NULL, NULL);
INSERT INTO public.content VALUES (69, 'literal/f3/0', '{"segments":[{"result":"na","source":68}]}', 'a85b1c503221104998ddbd9e272a8efe5e7fe98227785680540222545cd02ac0', NULL, NULL, NULL);
INSERT INTO public.content VALUES (69, 'sources/f3/0', '[{"kind":"value","source":68}]', '29d246f835e24bc3a7360376a47f538836990cd62f470717347de67553d26ef6', NULL, NULL, NULL);
INSERT INTO public.content VALUES (69, 'target', '{"cause":"request","intent":"update","op_index":0,"row":"r_KNQKC0R2AV1WCSEBTX0FEV6DGV","sv":1,"table":"t3"}', '25f66ba21efc4fba62adeca51fc64cc089a5b01658b0a875f13910dce8f81a04', NULL, NULL, NULL);


--
-- Data for Name: counts; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.counts VALUES ('t1', '', 3);
INSERT INTO public.counts VALUES ('t4', '', 1);
INSERT INTO public.counts VALUES ('t2', '', 2);
INSERT INTO public.counts VALUES ('t3', '', 2);


--
-- Data for Name: d_t5_v1; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.d_t5_v1 VALUES ('p_Y5VYNKS7DXE6MB8P', '2026-11-04', 9, 1, 37);
INSERT INTO public.d_t5_v1 VALUES ('p_KNKSNAFMV8WDJAX9', '2026-11-02', 86, 2, 41);


--
-- Data for Name: deletions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: derived_reads; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.derived_reads VALUES (12, 't1', 'p_KNKSNAFMV8WDJAX9', 1, 11);
INSERT INTO public.derived_reads VALUES (16, 't1', 'p_KNKSNAFMV8WDJAX9', 1, 15);
INSERT INTO public.derived_reads VALUES (20, 't1', 'p_MRN4XWHC2TN0RDW5', 1, 19);
INSERT INTO public.derived_reads VALUES (24, 't1', 'p_KNKSNAFMV8WDJAX9', 1, 23);
INSERT INTO public.derived_reads VALUES (28, 't1', 'p_MRN4XWHC2TN0RDW5', 1, 27);
INSERT INTO public.derived_reads VALUES (32, 't1', 'p_Y5VYNKS7DXE6MB8P', 1, 31);
INSERT INTO public.derived_reads VALUES (36, 't1', 'p_Y5VYNKS7DXE6MB8P', 1, 35);
INSERT INTO public.derived_reads VALUES (40, 't1', 'p_Y5VYNKS7DXE6MB8P', 1, 39);
INSERT INTO public.derived_reads VALUES (44, 't1', 'p_KNKSNAFMV8WDJAX9', 1, 43);


--
-- Data for Name: events; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.events VALUES (1, '{"actor":"u_AYB8MHJ7TE1NHH45P4YAKJJV6W","at":"2026-11-24T13:37:53.607Z","node_id":"n_2K68G7HW67X01HD50SR7A0G7JK","prev_hash":"0000000000000000000000000000000000000000000000000000000000000000","seq":1,"type":"tenant.genesis","v":1}', '7b731a6ab1632879d1f16740b7431761ba1424c9e02e7251cc2ecad38debd751', 'tenant.genesis', 'u_AYB8MHJ7TE1NHH45P4YAKJJV6W', '2026-11-24T13:37:53.607Z', 1, NULL, NULL, NULL, NULL);
INSERT INTO public.events VALUES (2, '{"actor":"u_AYB8MHJ7TE1NHH45P4YAKJJV6W","at":"2026-11-24T13:37:53.802Z","prev_hash":"7b731a6ab1632879d1f16740b7431761ba1424c9e02e7251cc2ecad38debd751","seq":2,"slot":"sl_ESNC5VC50A2EC6GF","type":"schema.draft_submitted","v":1}', '8bdb97580d23c10ab92b2d5ca5b3b348008cd1f9b20ea26554827d37a7ff6f41', 'schema.draft_submitted', 'u_AYB8MHJ7TE1NHH45P4YAKJJV6W', '2026-11-24T13:37:53.802Z', 2, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (3, '{"actor":"u_AYB8MHJ7TE1NHH45P4YAKJJV6W","at":"2026-11-24T13:37:53.802Z","op":2,"prev_hash":"8bdb97580d23c10ab92b2d5ca5b3b348008cd1f9b20ea26554827d37a7ff6f41","seq":3,"slot":"sl_ESNC5VC50A2EC6GF","type":"schema.compiled","v":1}', 'ce3dd515137ccf67d07854eedcbbbb311bde37df33eca82c70f4b81d07319b51', 'schema.compiled', 'u_AYB8MHJ7TE1NHH45P4YAKJJV6W', '2026-11-24T13:37:53.802Z', 2, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (4, '{"actor":"u_AYB8MHJ7TE1NHH45P4YAKJJV6W","at":"2026-11-24T13:37:53.802Z","op":2,"prev_hash":"ce3dd515137ccf67d07854eedcbbbb311bde37df33eca82c70f4b81d07319b51","seq":4,"slot":"sl_ESNC5VC50A2EC6GF","type":"schema.confirmed","v":1}', '8c9cfd684fed2160cea5b795dcb1a952b9ada3a84dcf45d417c7eb9007dbb80e', 'schema.confirmed', 'u_AYB8MHJ7TE1NHH45P4YAKJJV6W', '2026-11-24T13:37:53.802Z', 2, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (5, '{"actor":"u_AYB8MHJ7TE1NHH45P4YAKJJV6W","at":"2026-11-24T13:37:53.802Z","op":2,"prev_hash":"8c9cfd684fed2160cea5b795dcb1a952b9ada3a84dcf45d417c7eb9007dbb80e","seq":5,"slot":"sl_ESNC5VC50A2EC6GF","type":"slot.policy_set","v":1}', 'a5d4773307014d3cf7a0740919502c4e25ea25e58f11430343d6965830099b1d', 'slot.policy_set', 'u_AYB8MHJ7TE1NHH45P4YAKJJV6W', '2026-11-24T13:37:53.802Z', 2, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (6, '{"actor":"u_AYB8MHJ7TE1NHH45P4YAKJJV6W","at":"2026-11-24T13:37:53.802Z","op":2,"prev_hash":"a5d4773307014d3cf7a0740919502c4e25ea25e58f11430343d6965830099b1d","seq":6,"slot":"sl_ESNC5VC50A2EC6GF","type":"schema.switched","v":1}', '8f0ed8c297159fd8e50e3f9984f2c4083602e8dbff742e4b5abcd9be3861744c', 'schema.switched', 'u_AYB8MHJ7TE1NHH45P4YAKJJV6W', '2026-11-24T13:37:53.802Z', 2, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (7, '{"actor":"u_AYB8MHJ7TE1NHH45P4YAKJJV6W","at":"2026-11-24T13:37:53.816Z","prev_hash":"8f0ed8c297159fd8e50e3f9984f2c4083602e8dbff742e4b5abcd9be3861744c","seq":7,"type":"principal.registered","v":1}', '972820d837925947ef9140e50928c0bdb8778704fa1e8c89326e5a268db873b7', 'principal.registered', 'u_AYB8MHJ7TE1NHH45P4YAKJJV6W', '2026-11-24T13:37:53.816Z', 7, NULL, NULL, NULL, NULL);
INSERT INTO public.events VALUES (8, '{"actor":"u_AYB8MHJ7TE1NHH45P4YAKJJV6W","at":"2026-11-24T13:37:53.819Z","prev_hash":"972820d837925947ef9140e50928c0bdb8778704fa1e8c89326e5a268db873b7","seq":8,"type":"principal.registered","v":1}', 'fa6a9e50e39ade371cbe171f6b5cb016088098e782c53bd7fa46842ede1f9af4', 'principal.registered', 'u_AYB8MHJ7TE1NHH45P4YAKJJV6W', '2026-11-24T13:37:53.819Z', 8, NULL, NULL, NULL, NULL);
INSERT INTO public.events VALUES (9, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.821Z","prev_hash":"fa6a9e50e39ade371cbe171f6b5cb016088098e782c53bd7fa46842ede1f9af4","seq":9,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.head","v":1}', 'a1d82152603f3a6fa11b8b39271370850f2cbf7232ae642d91695e6f76200a66', 'write.head', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.821Z', 9, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (10, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.821Z","op":9,"prev_hash":"a1d82152603f3a6fa11b8b39271370850f2cbf7232ae642d91695e6f76200a66","seq":10,"slot":"sl_ESNC5VC50A2EC6GF","type":"source.recorded","v":1}', 'be9b1d7b824180f00b4c08d716896df86843c6f0018942b699f0cb304084a918', 'source.recorded', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.821Z', 9, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (11, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.821Z","op":9,"prev_hash":"be9b1d7b824180f00b4c08d716896df86843c6f0018942b699f0cb304084a918","seq":11,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.base","v":1}', 'd5652faebac94f49fabde581d4fd7b19f276dddee61cfa917e23e37298fe7961', 'write.base', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.821Z', 9, 'sl_ESNC5VC50A2EC6GF', 't1', 'r_V6RH9FFY9J354M7G13BA6D3XHV', NULL);
INSERT INTO public.events VALUES (12, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.821Z","op":9,"prev_hash":"d5652faebac94f49fabde581d4fd7b19f276dddee61cfa917e23e37298fe7961","seq":12,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.derived","v":1}', 'e25a064763a19d3977dfe706a946be617de631562fac7e48be2c116f22c00293', 'write.derived', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.821Z', 9, 'sl_ESNC5VC50A2EC6GF', 't5', NULL, NULL);
INSERT INTO public.events VALUES (13, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.832Z","prev_hash":"e25a064763a19d3977dfe706a946be617de631562fac7e48be2c116f22c00293","seq":13,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.head","v":1}', '987b9b09c33869f3d9b15f6670a0beebb4f7150b3f009e664d4270f9d93a5528', 'write.head', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.832Z', 13, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (14, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.832Z","op":13,"prev_hash":"987b9b09c33869f3d9b15f6670a0beebb4f7150b3f009e664d4270f9d93a5528","seq":14,"slot":"sl_ESNC5VC50A2EC6GF","type":"source.recorded","v":1}', '35c850cc696c92fd28efcb078547d5c7170ead18efbc548f5e91ed69f8ef5da4', 'source.recorded', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.832Z', 13, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (15, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.832Z","op":13,"prev_hash":"35c850cc696c92fd28efcb078547d5c7170ead18efbc548f5e91ed69f8ef5da4","seq":15,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.base","v":1}', '5ea98c8235d2e7b264b1ec64ad4039f76532c0b3b9061325a6174f0bcb1b8fe7', 'write.base', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.832Z', 13, 'sl_ESNC5VC50A2EC6GF', 't1', 'r_0HX0BEZ3J96GW8CYMYXVCKKK7Y', NULL);
INSERT INTO public.events VALUES (16, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.832Z","op":13,"prev_hash":"5ea98c8235d2e7b264b1ec64ad4039f76532c0b3b9061325a6174f0bcb1b8fe7","seq":16,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.derived","v":1}', '13c71afeb5b27be00565df47c10a1626ccf55870f8521b2d7844ae5b58d4f4e6', 'write.derived', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.832Z', 13, 'sl_ESNC5VC50A2EC6GF', 't5', NULL, NULL);
INSERT INTO public.events VALUES (17, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.839Z","prev_hash":"13c71afeb5b27be00565df47c10a1626ccf55870f8521b2d7844ae5b58d4f4e6","seq":17,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.head","v":1}', '618a2f3026ca60135e814c7e0d7f468a2db96362adb3757b9503f0f2b1ea1f48', 'write.head', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.839Z', 17, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (18, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.839Z","op":17,"prev_hash":"618a2f3026ca60135e814c7e0d7f468a2db96362adb3757b9503f0f2b1ea1f48","seq":18,"slot":"sl_ESNC5VC50A2EC6GF","type":"source.recorded","v":1}', '6b9cafceded025b533aa1cd0e3153c66ac9ee720eb4fa55f8dab34dc4a011bca', 'source.recorded', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.839Z', 17, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (19, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.839Z","op":17,"prev_hash":"6b9cafceded025b533aa1cd0e3153c66ac9ee720eb4fa55f8dab34dc4a011bca","seq":19,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.base","v":1}', 'b8cecc1184e03093c3e10eb9d9f10f24df51b5b11eaadfe0c7edccbe3c3d626d', 'write.base', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.839Z', 17, 'sl_ESNC5VC50A2EC6GF', 't1', 'r_WYXV2M27PD1JYV4HN68E5VAM13', NULL);
INSERT INTO public.events VALUES (20, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.839Z","op":17,"prev_hash":"b8cecc1184e03093c3e10eb9d9f10f24df51b5b11eaadfe0c7edccbe3c3d626d","seq":20,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.derived","v":1}', '9b5db610be6b1f8903dc91aac8d5f250c7dd56074e7485937963930f5bdf9374', 'write.derived', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.839Z', 17, 'sl_ESNC5VC50A2EC6GF', 't5', NULL, NULL);
INSERT INTO public.events VALUES (21, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.846Z","prev_hash":"9b5db610be6b1f8903dc91aac8d5f250c7dd56074e7485937963930f5bdf9374","seq":21,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.head","v":1}', '0ded99544cf2009494356d934841d6dabaf19f4507c5346577085a81f6a4119d', 'write.head', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.846Z', 21, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (22, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.846Z","op":21,"prev_hash":"0ded99544cf2009494356d934841d6dabaf19f4507c5346577085a81f6a4119d","seq":22,"slot":"sl_ESNC5VC50A2EC6GF","type":"source.recorded","v":1}', '3cbf82ba928d8ee014711a73f942dbaa42157b2110e4a7bfc689d347c85f5c2f', 'source.recorded', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.846Z', 21, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (23, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.846Z","op":21,"prev_hash":"3cbf82ba928d8ee014711a73f942dbaa42157b2110e4a7bfc689d347c85f5c2f","seq":23,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.base","v":1}', 'd516481c5ca5e8e7e5ac7ba7118893b1ef5eeeed2e368c4eb32ad65749639f4c', 'write.base', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.846Z', 21, 'sl_ESNC5VC50A2EC6GF', 't1', 'r_V6RH9FFY9J354M7G13BA6D3XHV', NULL);
INSERT INTO public.events VALUES (24, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.846Z","op":21,"prev_hash":"d516481c5ca5e8e7e5ac7ba7118893b1ef5eeeed2e368c4eb32ad65749639f4c","seq":24,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.derived","v":1}', 'ed8024e7e8c18e5e3a16c3da6e679ce752e8d1c9e5c6be7235a78397a58bd6b9', 'write.derived', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.846Z', 21, 'sl_ESNC5VC50A2EC6GF', 't5', NULL, NULL);
INSERT INTO public.events VALUES (25, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.855Z","prev_hash":"ed8024e7e8c18e5e3a16c3da6e679ce752e8d1c9e5c6be7235a78397a58bd6b9","seq":25,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.head","v":1}', 'f2b71f4edf15f12654ada89ca98e91e446fd3e41927fb9f572886ed80e0d265d', 'write.head', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.855Z', 25, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (26, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.855Z","op":25,"prev_hash":"f2b71f4edf15f12654ada89ca98e91e446fd3e41927fb9f572886ed80e0d265d","seq":26,"slot":"sl_ESNC5VC50A2EC6GF","type":"source.recorded","v":1}', 'e53cf16a812efe6179f42e48e3d1d295f54e2733a37df21d3b7b8428431ecd55', 'source.recorded', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.855Z', 25, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (27, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.855Z","op":25,"prev_hash":"e53cf16a812efe6179f42e48e3d1d295f54e2733a37df21d3b7b8428431ecd55","seq":27,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.base","v":1}', 'dcfd564ba77fcea76227ec06ee34308de485dbad61608554d008ab45f4c6538d', 'write.base', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.855Z', 25, 'sl_ESNC5VC50A2EC6GF', 't1', 'r_WYXV2M27PD1JYV4HN68E5VAM13', NULL);
INSERT INTO public.events VALUES (28, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.855Z","op":25,"prev_hash":"dcfd564ba77fcea76227ec06ee34308de485dbad61608554d008ab45f4c6538d","seq":28,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.derived","v":1}', '1a7ced4494a5ba48483d6c0b1ca044336abe634d9d6b8149e6515580b0724af3', 'write.derived', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.855Z', 25, 'sl_ESNC5VC50A2EC6GF', 't5', NULL, NULL);
INSERT INTO public.events VALUES (29, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.864Z","prev_hash":"1a7ced4494a5ba48483d6c0b1ca044336abe634d9d6b8149e6515580b0724af3","seq":29,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.head","v":1}', '14d4412c7b5d785e9790dc4cbaef787041fb39d948f591fe35a3da2228f3aaf5', 'write.head', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.864Z', 29, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (30, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.864Z","op":29,"prev_hash":"14d4412c7b5d785e9790dc4cbaef787041fb39d948f591fe35a3da2228f3aaf5","seq":30,"slot":"sl_ESNC5VC50A2EC6GF","type":"source.recorded","v":1}', '47b6d931411ae5db7fc767ac22c766c547674c1af4159107d542ca553ddbc3b6', 'source.recorded', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.864Z', 29, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (31, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.864Z","op":29,"prev_hash":"47b6d931411ae5db7fc767ac22c766c547674c1af4159107d542ca553ddbc3b6","seq":31,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.base","v":1}', 'c667444408ec91926f650358f6e1601c09b8744e3456c39fa7e4488dffcb1646', 'write.base', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.864Z', 29, 'sl_ESNC5VC50A2EC6GF', 't1', 'r_P6M68GZNRN8N73T04M6G6NQC2W', NULL);
INSERT INTO public.events VALUES (32, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.864Z","op":29,"prev_hash":"c667444408ec91926f650358f6e1601c09b8744e3456c39fa7e4488dffcb1646","seq":32,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.derived","v":1}', '47d07cd72f657142ca9af0e261547c74d47646c57b9ee8604596e9017e534c90', 'write.derived', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.864Z', 29, 'sl_ESNC5VC50A2EC6GF', 't5', NULL, NULL);
INSERT INTO public.events VALUES (33, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.873Z","prev_hash":"47d07cd72f657142ca9af0e261547c74d47646c57b9ee8604596e9017e534c90","seq":33,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.head","v":1}', '27ffba89e719f227e95b08bf8248f2f0e5d6a8c58e131b67b9426de41406690d', 'write.head', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.873Z', 33, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (34, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.873Z","op":33,"prev_hash":"27ffba89e719f227e95b08bf8248f2f0e5d6a8c58e131b67b9426de41406690d","seq":34,"slot":"sl_ESNC5VC50A2EC6GF","type":"source.recorded","v":1}', 'c3b6d51d9defb5d45511d3c9969bb5ce4325f9cb8a72e94ff5f4b45ca6d6128c', 'source.recorded', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.873Z', 33, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (35, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.873Z","op":33,"prev_hash":"c3b6d51d9defb5d45511d3c9969bb5ce4325f9cb8a72e94ff5f4b45ca6d6128c","seq":35,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.base","v":1}', '497b6bac627d4987c860871da5b30c4911bb5940bbefb1c4ee8035c60f3165a6', 'write.base', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.873Z', 33, 'sl_ESNC5VC50A2EC6GF', 't1', 'r_P6M68GZNRN8N73T04M6G6NQC2W', NULL);
INSERT INTO public.events VALUES (36, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.873Z","op":33,"prev_hash":"497b6bac627d4987c860871da5b30c4911bb5940bbefb1c4ee8035c60f3165a6","seq":36,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.derived","v":1}', '9e6f911ad4998df50174d8a8c82677ad53335f06a88310f6e8b217d24cf1d57a', 'write.derived', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.873Z', 33, 'sl_ESNC5VC50A2EC6GF', 't5', NULL, NULL);
INSERT INTO public.events VALUES (37, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.881Z","prev_hash":"9e6f911ad4998df50174d8a8c82677ad53335f06a88310f6e8b217d24cf1d57a","seq":37,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.head","v":1}', 'a269e07e8b6884ac76cf4463a883ff7f511541ae7481e2488d931fef4808afca', 'write.head', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.881Z', 37, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (38, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.881Z","op":37,"prev_hash":"a269e07e8b6884ac76cf4463a883ff7f511541ae7481e2488d931fef4808afca","seq":38,"slot":"sl_ESNC5VC50A2EC6GF","type":"source.recorded","v":1}', '8f415e09459fb0c055e69598346a9f376acd8a213e157b930c37e981ce278cc1', 'source.recorded', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.881Z', 37, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (39, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.881Z","op":37,"prev_hash":"8f415e09459fb0c055e69598346a9f376acd8a213e157b930c37e981ce278cc1","seq":39,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.base","v":1}', 'b640068dcff697ca610e84f806c7536ffbe4c09b696900dec9ebdae7e3fcfcf8', 'write.base', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.881Z', 37, 'sl_ESNC5VC50A2EC6GF', 't1', 'r_P6M68GZNRN8N73T04M6G6NQC2W', NULL);
INSERT INTO public.events VALUES (40, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.881Z","op":37,"prev_hash":"b640068dcff697ca610e84f806c7536ffbe4c09b696900dec9ebdae7e3fcfcf8","seq":40,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.derived","v":1}', '3ea54f1d1227bc5366f0976671dcd3ab280890dfcde3ab0a5f431020956d1ba8', 'write.derived', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.881Z', 37, 'sl_ESNC5VC50A2EC6GF', 't5', NULL, NULL);
INSERT INTO public.events VALUES (41, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.890Z","prev_hash":"3ea54f1d1227bc5366f0976671dcd3ab280890dfcde3ab0a5f431020956d1ba8","seq":41,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.head","v":1}', 'a53c5134ddfb99f609fdb4b230d5a7fa2db136fa89a4a821e6eb3c7eac21f976', 'write.head', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.890Z', 41, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (42, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.890Z","op":41,"prev_hash":"a53c5134ddfb99f609fdb4b230d5a7fa2db136fa89a4a821e6eb3c7eac21f976","seq":42,"slot":"sl_ESNC5VC50A2EC6GF","type":"source.recorded","v":1}', '52496e69cc012d369371032e1477d0b9e85d2feba9d0ba9a5650e238f077abbf', 'source.recorded', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.890Z', 41, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (43, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.890Z","op":41,"prev_hash":"52496e69cc012d369371032e1477d0b9e85d2feba9d0ba9a5650e238f077abbf","seq":43,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.base","v":1}', '8838e83680756552dbe11ac2c37cd9151d4b037786a4c8a2b7314fd53a0831af', 'write.base', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.890Z', 41, 'sl_ESNC5VC50A2EC6GF', 't1', 'r_0HX0BEZ3J96GW8CYMYXVCKKK7Y', NULL);
INSERT INTO public.events VALUES (44, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.890Z","op":41,"prev_hash":"8838e83680756552dbe11ac2c37cd9151d4b037786a4c8a2b7314fd53a0831af","seq":44,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.derived","v":1}', '9d5439252890fc2f685c967b0b97ec89d7fc3d6c2cdfe593d3df5c3e7e1d38da', 'write.derived', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.890Z', 41, 'sl_ESNC5VC50A2EC6GF', 't5', NULL, NULL);
INSERT INTO public.events VALUES (45, '{"actor":"ci_PDVX102QE14MPMRZP4VVYP5Y7B","at":"2026-11-24T13:37:53.899Z","prev_hash":"9d5439252890fc2f685c967b0b97ec89d7fc3d6c2cdfe593d3df5c3e7e1d38da","seq":45,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.head","v":1}', '2cc26ec8697f244f98ed1d2d316bafe12431aea2c7bc50ef5c9b937995f912fb', 'write.head', 'ci_PDVX102QE14MPMRZP4VVYP5Y7B', '2026-11-24T13:37:53.899Z', 45, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (46, '{"actor":"ci_PDVX102QE14MPMRZP4VVYP5Y7B","at":"2026-11-24T13:37:53.899Z","op":45,"prev_hash":"2cc26ec8697f244f98ed1d2d316bafe12431aea2c7bc50ef5c9b937995f912fb","seq":46,"slot":"sl_ESNC5VC50A2EC6GF","type":"source.recorded","v":1}', 'be4076ab0b57d82f6810a017756c3e4df904da97a93d7276bbdf3e6c1b51e4ce', 'source.recorded', 'ci_PDVX102QE14MPMRZP4VVYP5Y7B', '2026-11-24T13:37:53.899Z', 45, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (47, '{"actor":"ci_PDVX102QE14MPMRZP4VVYP5Y7B","at":"2026-11-24T13:37:53.899Z","op":45,"prev_hash":"be4076ab0b57d82f6810a017756c3e4df904da97a93d7276bbdf3e6c1b51e4ce","seq":47,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.base","v":1}', '5c0230b327dba77e3234fe82118c2910f7803ee2f854800455fe1f9c920329d6', 'write.base', 'ci_PDVX102QE14MPMRZP4VVYP5Y7B', '2026-11-24T13:37:53.899Z', 45, 'sl_ESNC5VC50A2EC6GF', 't1', 'r_0HX0BEZ3J96GW8CYMYXVCKKK7Y', NULL);
INSERT INTO public.events VALUES (48, '{"actor":"ci_PDVX102QE14MPMRZP4VVYP5Y7B","at":"2026-11-24T13:37:53.899Z","op":45,"prev_hash":"5c0230b327dba77e3234fe82118c2910f7803ee2f854800455fe1f9c920329d6","seq":48,"slot":"sl_ESNC5VC50A2EC6GF","type":"item.created","v":1}', 'e30e586b8ba7260b7e42a45089d86004e27544cfb1bba2ef20ea1029166481b6', 'item.created', 'ci_PDVX102QE14MPMRZP4VVYP5Y7B', '2026-11-24T13:37:53.899Z', 45, 'sl_ESNC5VC50A2EC6GF', 't1', 'r_0HX0BEZ3J96GW8CYMYXVCKKK7Y', 47);
INSERT INTO public.events VALUES (49, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.908Z","prev_hash":"e30e586b8ba7260b7e42a45089d86004e27544cfb1bba2ef20ea1029166481b6","seq":49,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.head","v":1}', '9092afa4416e0de21de73e51deba823a4ed920c7cb279025051f136926439116', 'write.head', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.908Z', 49, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (50, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.908Z","op":49,"prev_hash":"9092afa4416e0de21de73e51deba823a4ed920c7cb279025051f136926439116","seq":50,"slot":"sl_ESNC5VC50A2EC6GF","type":"source.recorded","v":1}', '3b78aa5ec4d44da0d520445797de30f8e90215b015d814c6ce0fe9a1cba96eac', 'source.recorded', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.908Z', 49, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (51, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.908Z","op":49,"prev_hash":"3b78aa5ec4d44da0d520445797de30f8e90215b015d814c6ce0fe9a1cba96eac","seq":51,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.base","v":1}', 'bafda37fe583741af6ed5ddb84acd3c3294218a8ecc79225656432153d775c4f', 'write.base', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.908Z', 49, 'sl_ESNC5VC50A2EC6GF', 't4', 'r_JR16J09DDPW9EX54GFQVWTQGBJ', NULL);
INSERT INTO public.events VALUES (52, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.915Z","prev_hash":"bafda37fe583741af6ed5ddb84acd3c3294218a8ecc79225656432153d775c4f","seq":52,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.head","v":1}', '6ec0ef9bed3b52379c8e51a6df0cb753865e58da87cdc9cf534c4b71fe6fe2ec', 'write.head', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.915Z', 52, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (53, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.915Z","op":52,"prev_hash":"6ec0ef9bed3b52379c8e51a6df0cb753865e58da87cdc9cf534c4b71fe6fe2ec","seq":53,"slot":"sl_ESNC5VC50A2EC6GF","type":"source.recorded","v":1}', '6b590b0515b95f5092f8e10d620b3b696e1b2ac199bd06087159b95c6899333a', 'source.recorded', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.915Z', 52, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (54, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.915Z","op":52,"prev_hash":"6b590b0515b95f5092f8e10d620b3b696e1b2ac199bd06087159b95c6899333a","seq":54,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.base","v":1}', 'fb5dd5b834ba75e9a8292c3bad9d84de4530767e612aae8bceeef1eaa0a6b4e9', 'write.base', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.915Z', 52, 'sl_ESNC5VC50A2EC6GF', 't2', 'e_TN6Z27K0HG01R6Y4YKV6W64XSN', NULL);
INSERT INTO public.events VALUES (55, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.923Z","prev_hash":"fb5dd5b834ba75e9a8292c3bad9d84de4530767e612aae8bceeef1eaa0a6b4e9","seq":55,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.head","v":1}', '9ddafb8cbd025004f9bb65dfcd0735280d95b28681c4b09907f6b55596424e49', 'write.head', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.923Z', 55, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (56, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.923Z","op":55,"prev_hash":"9ddafb8cbd025004f9bb65dfcd0735280d95b28681c4b09907f6b55596424e49","seq":56,"slot":"sl_ESNC5VC50A2EC6GF","type":"source.recorded","v":1}', 'ef4508ef27e2df54827761615ce0a1e8800f1a3e948b6fa659b628e0d0e25abf', 'source.recorded', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.923Z', 55, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (57, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.923Z","op":55,"prev_hash":"ef4508ef27e2df54827761615ce0a1e8800f1a3e948b6fa659b628e0d0e25abf","seq":57,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.base","v":1}', 'ea3397f4274bc416c14b1ae0a45f8781db56eadc35d03a4272baf16c14992477', 'write.base', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.923Z', 55, 'sl_ESNC5VC50A2EC6GF', 't2', 'e_TN6Z27K0HG01R6Y4YKV6W64XSN', NULL);
INSERT INTO public.events VALUES (58, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.929Z","prev_hash":"ea3397f4274bc416c14b1ae0a45f8781db56eadc35d03a4272baf16c14992477","seq":58,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.head","v":1}', 'd511666b7a97dc0aa947a71400b9e1c86248bdf934c9ca07e45dc35b4c748b2c', 'write.head', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.929Z', 58, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (59, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.929Z","op":58,"prev_hash":"d511666b7a97dc0aa947a71400b9e1c86248bdf934c9ca07e45dc35b4c748b2c","seq":59,"slot":"sl_ESNC5VC50A2EC6GF","type":"source.recorded","v":1}', '2b399cce8c3c484802e6c970b8189f70c7ca03dc058529ab32c30cc76639ce22', 'source.recorded', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.929Z', 58, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (60, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.929Z","op":58,"prev_hash":"2b399cce8c3c484802e6c970b8189f70c7ca03dc058529ab32c30cc76639ce22","seq":60,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.base","v":1}', '84c6815dba5c6ba70b8ddbd118474b5643485ef6ddba4f84e76b6c52731e86a2', 'write.base', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.929Z', 58, 'sl_ESNC5VC50A2EC6GF', 't2', 'e_TN6Z27K0HG01R6Y4YKV6W64XSN', NULL);
INSERT INTO public.events VALUES (61, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.929Z","op":58,"prev_hash":"84c6815dba5c6ba70b8ddbd118474b5643485ef6ddba4f84e76b6c52731e86a2","seq":61,"slot":"sl_ESNC5VC50A2EC6GF","type":"item.created","v":1}', 'da25694326606befcddd564efd55bf28bd9ac9d9c90d1d22142ffd811d226ad8', 'item.created', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.929Z', 58, 'sl_ESNC5VC50A2EC6GF', 't2', 'e_TN6Z27K0HG01R6Y4YKV6W64XSN', 60);
INSERT INTO public.events VALUES (62, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.939Z","prev_hash":"da25694326606befcddd564efd55bf28bd9ac9d9c90d1d22142ffd811d226ad8","seq":62,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.head","v":1}', 'c9eee8140148dfe4973da6bcac0eb24fe208b693ce31bd5d8f587c67680c946b', 'write.head', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.939Z', 62, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (63, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.939Z","op":62,"prev_hash":"c9eee8140148dfe4973da6bcac0eb24fe208b693ce31bd5d8f587c67680c946b","seq":63,"slot":"sl_ESNC5VC50A2EC6GF","type":"source.recorded","v":1}', '29f3631ec697ce976b0794c2d82a76fb58141c338fceb9b1c68183ea03a67980', 'source.recorded', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.939Z', 62, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (64, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.939Z","op":62,"prev_hash":"29f3631ec697ce976b0794c2d82a76fb58141c338fceb9b1c68183ea03a67980","seq":64,"slot":"sl_ESNC5VC50A2EC6GF","type":"source.recorded","v":1}', '21f347372f2b38318920298873f50a200dd14b46dfb9397fc8f85af9e7efe11c', 'source.recorded', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.939Z', 62, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (65, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.939Z","op":62,"prev_hash":"21f347372f2b38318920298873f50a200dd14b46dfb9397fc8f85af9e7efe11c","seq":65,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.base","v":1}', 'd57e958dfcc26bb839eb8cdb90558b1e56f050a7e4a7ebb2dce6d3b44ad46611', 'write.base', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.939Z', 62, 'sl_ESNC5VC50A2EC6GF', 't3', 'r_KNQKC0R2AV1WCSEBTX0FEV6DGV', NULL);
INSERT INTO public.events VALUES (66, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.939Z","op":62,"prev_hash":"d57e958dfcc26bb839eb8cdb90558b1e56f050a7e4a7ebb2dce6d3b44ad46611","seq":66,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.base","v":1}', 'e4073f285c9e8a25ffb7dac4ab23ec20a0d9f77b8986582f4e768f5ef801502b', 'write.base', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.939Z', 62, 'sl_ESNC5VC50A2EC6GF', 't3', 'r_F9TJVJHQ32G09A15Z9520CN9CN', NULL);
INSERT INTO public.events VALUES (67, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.948Z","prev_hash":"e4073f285c9e8a25ffb7dac4ab23ec20a0d9f77b8986582f4e768f5ef801502b","seq":67,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.head","v":1}', '736c731b90261122efe2a42c235176c2cbe403bfe63b075d8aa673861ea35f40', 'write.head', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.948Z', 67, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (68, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.948Z","op":67,"prev_hash":"736c731b90261122efe2a42c235176c2cbe403bfe63b075d8aa673861ea35f40","seq":68,"slot":"sl_ESNC5VC50A2EC6GF","type":"source.recorded","v":1}', 'f5d06737547df8c41b67373515ded55e15d422f277451a191126b3ecb717cb28', 'source.recorded', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.948Z', 67, 'sl_ESNC5VC50A2EC6GF', NULL, NULL, NULL);
INSERT INTO public.events VALUES (69, '{"actor":"ci_N7MTZZE9VD8HEN6Y533VE628P4","at":"2026-11-24T13:37:53.948Z","op":67,"prev_hash":"f5d06737547df8c41b67373515ded55e15d422f277451a191126b3ecb717cb28","seq":69,"slot":"sl_ESNC5VC50A2EC6GF","type":"write.base","v":1}', 'b5f0175ffeb1040820543092071e4f36baefbcd400e376a274f447f3fac4fe8c', 'write.base', 'ci_N7MTZZE9VD8HEN6Y533VE628P4', '2026-11-24T13:37:53.948Z', 67, 'sl_ESNC5VC50A2EC6GF', 't3', 'r_KNQKC0R2AV1WCSEBTX0FEV6DGV', NULL);


--
-- Data for Name: external_keys; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.external_keys VALUES ('t3', '["app","k-1"]', 'r_KNQKC0R2AV1WCSEBTX0FEV6DGV', NULL, 'present', NULL);
INSERT INTO public.external_keys VALUES ('t3', '["app","k-2"]', 'r_F9TJVJHQ32G09A15Z9520CN9CN', NULL, 'present', NULL);


--
-- Data for Name: field_name_usage; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: flags; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.flags VALUES ('t1', 'r_0HX0BEZ3J96GW8CYMYXVCKKK7Y', 'disputed', 'pi_12CVJYSZ2KWRQ1BM', '["f2"]', NULL);
INSERT INTO public.flags VALUES ('t2', 'e_TN6Z27K0HG01R6Y4YKV6W64XSN', 'awaiting', 'pi_V5DG105Z5F8C254R', '["f2"]', '[{"from":"2026-10-15"}]');


--
-- Data for Name: last_read; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.last_read VALUES ('ci_N7MTZZE9VD8HEN6Y533VE628P4', '', 'r_P6M68GZNRN8N73T04M6G6NQC2W', 'ver', 37, 0, 'rd_Q1G3G51C5KDT1P4C');
INSERT INTO public.last_read VALUES ('ci_N7MTZZE9VD8HEN6Y533VE628P4', '', 'r_0HX0BEZ3J96GW8CYMYXVCKKK7Y', 'ver', 41, 0, 'rd_Q1G3G51C5KDT1P4C');
INSERT INTO public.last_read VALUES ('ci_N7MTZZE9VD8HEN6Y533VE628P4', '', 'r_V6RH9FFY9J354M7G13BA6D3XHV', 'ver', 21, 0, 'rd_Q1G3G51C5KDT1P4C');
INSERT INTO public.last_read VALUES ('ci_N7MTZZE9VD8HEN6Y533VE628P4', '', 'e_TN6Z27K0HG01R6Y4YKV6W64XSN', 'ver', 55, 0, 'rd_QWQG57QHWF598W1D');
INSERT INTO public.last_read VALUES ('ci_N7MTZZE9VD8HEN6Y533VE628P4', '', 'r_KNQKC0R2AV1WCSEBTX0FEV6DGV', 'ver', 67, 0, 'rd_457YV90TEVPW0ZZM');
INSERT INTO public.last_read VALUES ('ci_N7MTZZE9VD8HEN6Y533VE628P4', '', 'r_F9TJVJHQ32G09A15Z9520CN9CN', 'ver', 62, 0, 'rd_457YV90TEVPW0ZZM');
INSERT INTO public.last_read VALUES ('ci_N7MTZZE9VD8HEN6Y533VE628P4', '', 'r_JR16J09DDPW9EX54GFQVWTQGBJ', 'ver', 49, 0, 'rd_FAF5DCF9EGYJP7PT');
INSERT INTO public.last_read VALUES ('ci_N7MTZZE9VD8HEN6Y533VE628P4', '', 'sl_ESNC5VC50A2EC6GF', 'sv', 1, 0, 'rd_TDNH7JKXEAHKV7X7');
INSERT INTO public.last_read VALUES ('ci_PDVX102QE14MPMRZP4VVYP5Y7B', '', 'r_V6RH9FFY9J354M7G13BA6D3XHV', 'ver', 21, 0, 'rd_BW1HRHRPDQP2QT2J');
INSERT INTO public.last_read VALUES ('ci_PDVX102QE14MPMRZP4VVYP5Y7B', '', 'sl_ESNC5VC50A2EC6GF', 'sv', 1, 0, 'rd_BW1HRHRPDQP2QT2J');
INSERT INTO public.last_read VALUES ('u_AYB8MHJ7TE1NHH45P4YAKJJV6W', '', 'r_P6M68GZNRN8N73T04M6G6NQC2W', 'ver', 37, 0, 'rd_33RX0Q2Z5D0NZKJK');
INSERT INTO public.last_read VALUES ('u_AYB8MHJ7TE1NHH45P4YAKJJV6W', '', 'r_0HX0BEZ3J96GW8CYMYXVCKKK7Y', 'ver', 41, 0, 'rd_33RX0Q2Z5D0NZKJK');
INSERT INTO public.last_read VALUES ('u_AYB8MHJ7TE1NHH45P4YAKJJV6W', '', 'r_V6RH9FFY9J354M7G13BA6D3XHV', 'ver', 21, 0, 'rd_33RX0Q2Z5D0NZKJK');
INSERT INTO public.last_read VALUES ('u_AYB8MHJ7TE1NHH45P4YAKJJV6W', '', 'r_KNQKC0R2AV1WCSEBTX0FEV6DGV', 'ver', 67, 0, 'rd_FV978PP7V00D4C8D');
INSERT INTO public.last_read VALUES ('u_AYB8MHJ7TE1NHH45P4YAKJJV6W', '', 'r_F9TJVJHQ32G09A15Z9520CN9CN', 'ver', 62, 0, 'rd_FV978PP7V00D4C8D');
INSERT INTO public.last_read VALUES ('u_AYB8MHJ7TE1NHH45P4YAKJJV6W', '', 'e_TN6Z27K0HG01R6Y4YKV6W64XSN', 'ver', 55, 0, 'rd_9JE5QN6YN8M7TSFG');
INSERT INTO public.last_read VALUES ('u_AYB8MHJ7TE1NHH45P4YAKJJV6W', '', 'sl_ESNC5VC50A2EC6GF', 'sv', 1, 0, 'rd_9JE5QN6YN8M7TSFG');


--
-- Data for Name: meta; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.meta VALUES ('storage_format', '5');
INSERT INTO public.meta VALUES ('session_settings', '["SET client_encoding = ''UTF8''","SET TIME ZONE ''UTC''","SET datestyle = ''ISO, YMD''","SET intervalstyle = ''iso_8601''","SET extra_float_digits = 3","SET standard_conforming_strings = on"]');
INSERT INTO public.meta VALUES ('tenant_id', 'tn_DEE9VA5MMDGN6S2JZMA9NN3ZNA');
INSERT INTO public.meta VALUES ('ownership_epoch', '2');


--
-- Data for Name: migrations; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: partitions; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.partitions VALUES ('t5', 'p_KNKSNAFMV8WDJAX9', '["2026-11-02"]');
INSERT INTO public.partitions VALUES ('t5', 'p_MRN4XWHC2TN0RDW5', '["2026-11-03"]');
INSERT INTO public.partitions VALUES ('t5', 'p_Y5VYNKS7DXE6MB8P', '["2026-11-04"]');


--
-- Data for Name: pending_blocks; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: pending_entries; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.pending_entries VALUES ('pi_12CVJYSZ2KWRQ1BM', 0, 48, 'candidates/0');
INSERT INTO public.pending_entries VALUES ('pi_12CVJYSZ2KWRQ1BM', 1, 48, 'current/0');
INSERT INTO public.pending_entries VALUES ('pi_12CVJYSZ2KWRQ1BM', 2, 48, 'impact/0');
INSERT INTO public.pending_entries VALUES ('pi_12CVJYSZ2KWRQ1BM', 3, 48, 'previous/0');
INSERT INTO public.pending_entries VALUES ('pi_V5DG105Z5F8C254R', 0, 61, 'current/0');
INSERT INTO public.pending_entries VALUES ('pi_V5DG105Z5F8C254R', 1, 61, 'current/1');
INSERT INTO public.pending_entries VALUES ('pi_V5DG105Z5F8C254R', 2, 61, 'impact/0');
INSERT INTO public.pending_entries VALUES ('pi_V5DG105Z5F8C254R', 3, 61, 'impact/1');
INSERT INTO public.pending_entries VALUES ('pi_V5DG105Z5F8C254R', 4, 61, 'proposed/0');
INSERT INTO public.pending_entries VALUES ('pi_V5DG105Z5F8C254R', 5, 61, 'scope_valid');


--
-- Data for Name: pending_items; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.pending_items VALUES ('pi_12CVJYSZ2KWRQ1BM', 'conflict', 'sl_ESNC5VC50A2EC6GF', 't1', 'r_0HX0BEZ3J96GW8CYMYXVCKKK7Y', 'open', NULL, 45);
INSERT INTO public.pending_items VALUES ('pi_V5DG105Z5F8C254R', 'awaiting_confirmation', 'sl_ESNC5VC50A2EC6GF', 't2', 'e_TN6Z27K0HG01R6Y4YKV6W64XSN', 'open', NULL, 58);


--
-- Data for Name: possibly_affected; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: premise_decls; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.premise_decls VALUES (49, 0, 0, 't4', 'r_JR16J09DDPW9EX54GFQVWTQGBJ', 't1', 'r_V6RH9FFY9J354M7G13BA6D3XHV', '["f2"]', 'whole', NULL, 21, 0, 'current', NULL, NULL, 'ci_N7MTZZE9VD8HEN6Y533VE628P4');


--
-- Data for Name: premise_edges; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.premise_edges VALUES (51, 'f1', 0, 'r_V6RH9FFY9J354M7G13BA6D3XHV', 49, 0, 0);
INSERT INTO public.premise_edges VALUES (51, 'f2', 0, 'r_V6RH9FFY9J354M7G13BA6D3XHV', 49, 0, 0);


--
-- Data for Name: principals; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.principals VALUES ('u_AYB8MHJ7TE1NHH45P4YAKJJV6W', 'user', NULL, NULL, NULL, NULL, NULL, 'active', 1);
INSERT INTO public.principals VALUES ('system', 'system', NULL, NULL, NULL, NULL, NULL, 'active', 1);
INSERT INTO public.principals VALUES ('ci_N7MTZZE9VD8HEN6Y533VE628P4', 'connection', 'sample agent', '["saveslot.read","saveslot.write","saveslot.schema"]', NULL, 'token', NULL, 'active', 7);
INSERT INTO public.principals VALUES ('ci_PDVX102QE14MPMRZP4VVYP5Y7B', 'connection', 'another agent', '["saveslot.read","saveslot.write","saveslot.schema"]', NULL, 'token', NULL, 'active', 8);


--
-- Data for Name: read_log; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_Q1G3G51C5KDT1P4C', 1, 'ci_N7MTZZE9VD8HEN6Y533VE628P4', NULL, '2026-11-24T13:37:53.954Z', 67, 'query', false, false, 'sl_ESNC5VC50A2EC6GF', 1, 't1', '{"fields":["f1","f2","f3"],"order":[],"page":false,"table":"t1","time":"none","where":[]}', NULL, NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_QWQG57QHWF598W1D', 2, 'ci_N7MTZZE9VD8HEN6Y533VE628P4', NULL, '2026-11-24T13:37:53.958Z', 67, 'query', false, false, 'sl_ESNC5VC50A2EC6GF', 1, 't2', '{"fields":["f1","f2"],"order":[],"page":false,"table":"t2","time":"none","where":[]}', '{"at":"2026-11-24"}', NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_457YV90TEVPW0ZZM', 3, 'ci_N7MTZZE9VD8HEN6Y533VE628P4', NULL, '2026-11-24T13:37:53.961Z', 67, 'query', false, false, 'sl_ESNC5VC50A2EC6GF', 1, 't3', '{"fields":["f1","f2","f3"],"order":[],"page":false,"table":"t3","time":"none","where":[]}', NULL, NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_FAF5DCF9EGYJP7PT', 4, 'ci_N7MTZZE9VD8HEN6Y533VE628P4', NULL, '2026-11-24T13:37:53.964Z', 67, 'query', false, false, 'sl_ESNC5VC50A2EC6GF', 1, 't4', '{"fields":["f1","f2"],"order":[],"page":false,"table":"t4","time":"none","where":[]}', NULL, NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_TDNH7JKXEAHKV7X7', 5, 'ci_N7MTZZE9VD8HEN6Y533VE628P4', NULL, '2026-11-24T13:37:53.967Z', 67, 'query', false, false, 'sl_ESNC5VC50A2EC6GF', 1, 't5', '{"fields":["f1","f2","f3"],"order":[],"page":false,"table":"t5","time":"none","where":[]}', NULL, NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_BW1HRHRPDQP2QT2J', 6, 'ci_PDVX102QE14MPMRZP4VVYP5Y7B', NULL, '2026-11-24T13:37:53.970Z', 67, 'history', false, false, 'sl_ESNC5VC50A2EC6GF', 1, 't1', '{"mode":"timeline","table":"t1","target":"r_V6RH9FFY9J354M7G13BA6D3XHV"}', NULL, NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_33RX0Q2Z5D0NZKJK', 7, 'u_AYB8MHJ7TE1NHH45P4YAKJJV6W', NULL, '2026-11-24T13:37:53.974Z', 67, 'query', false, false, 'sl_ESNC5VC50A2EC6GF', 1, 't1', '{"fields":["f1","f2","f3"],"order":[],"page":false,"table":"t1","time":"none","where":[]}', NULL, NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_FV978PP7V00D4C8D', 8, 'u_AYB8MHJ7TE1NHH45P4YAKJJV6W', NULL, '2026-11-24T13:37:53.977Z', 67, 'query', false, false, 'sl_ESNC5VC50A2EC6GF', 1, 't3', '{"fields":["f1","f2","f3"],"order":[],"page":false,"table":"t3","time":"none","where":[]}', NULL, NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_90F6SBX2N7Q7BA87', 9, 'u_AYB8MHJ7TE1NHH45P4YAKJJV6W', NULL, '2026-11-24T13:37:53.979Z', 67, 'query', false, false, 'sl_ESNC5VC50A2EC6GF', 1, 't2', '{"fields":["f1","f2"],"order":[],"page":false,"table":"t2","time":"at","where":[]}', '{"at":"2026-10-05"}', NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_9JE5QN6YN8M7TSFG', 10, 'u_AYB8MHJ7TE1NHH45P4YAKJJV6W', NULL, '2026-11-24T13:37:53.982Z', 67, 'query', false, false, 'sl_ESNC5VC50A2EC6GF', 1, 't2', '{"fields":["f1","f2"],"order":[],"page":false,"table":"t2","time":"at","where":[]}', '{"at":"2026-11-15"}', NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_GY16WVR5T6XJF2YZ', 11, 'u_AYB8MHJ7TE1NHH45P4YAKJJV6W', NULL, '2026-11-24T13:37:53.985Z', 67, 'pending', false, false, NULL, NULL, NULL, '{"list":true,"slot":null,"status":"open","type":null}', NULL, NULL, NULL, NULL);


--
-- Data for Name: read_log_rows; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.read_log_rows VALUES ('rd_Q1G3G51C5KDT1P4C', 0, 't1', 'r_P6M68GZNRN8N73T04M6G6NQC2W', 37, 0);
INSERT INTO public.read_log_rows VALUES ('rd_Q1G3G51C5KDT1P4C', 1, 't1', 'r_0HX0BEZ3J96GW8CYMYXVCKKK7Y', 41, 0);
INSERT INTO public.read_log_rows VALUES ('rd_Q1G3G51C5KDT1P4C', 2, 't1', 'r_V6RH9FFY9J354M7G13BA6D3XHV', 21, 0);
INSERT INTO public.read_log_rows VALUES ('rd_QWQG57QHWF598W1D', 0, 't2', 'e_TN6Z27K0HG01R6Y4YKV6W64XSN', 55, 0);
INSERT INTO public.read_log_rows VALUES ('rd_457YV90TEVPW0ZZM', 0, 't3', 'r_KNQKC0R2AV1WCSEBTX0FEV6DGV', 67, 0);
INSERT INTO public.read_log_rows VALUES ('rd_457YV90TEVPW0ZZM', 1, 't3', 'r_F9TJVJHQ32G09A15Z9520CN9CN', 62, 0);
INSERT INTO public.read_log_rows VALUES ('rd_FAF5DCF9EGYJP7PT', 0, 't4', 'r_JR16J09DDPW9EX54GFQVWTQGBJ', 49, 0);
INSERT INTO public.read_log_rows VALUES ('rd_TDNH7JKXEAHKV7X7', 0, 't5', 'p_KNKSNAFMV8WDJAX9', 41, 0);
INSERT INTO public.read_log_rows VALUES ('rd_TDNH7JKXEAHKV7X7', 1, 't5', 'p_Y5VYNKS7DXE6MB8P', 37, 0);
INSERT INTO public.read_log_rows VALUES ('rd_BW1HRHRPDQP2QT2J', 0, 't1', 'r_V6RH9FFY9J354M7G13BA6D3XHV', 21, 0);
INSERT INTO public.read_log_rows VALUES ('rd_33RX0Q2Z5D0NZKJK', 0, 't1', 'r_P6M68GZNRN8N73T04M6G6NQC2W', 37, 0);
INSERT INTO public.read_log_rows VALUES ('rd_33RX0Q2Z5D0NZKJK', 1, 't1', 'r_0HX0BEZ3J96GW8CYMYXVCKKK7Y', 41, 0);
INSERT INTO public.read_log_rows VALUES ('rd_33RX0Q2Z5D0NZKJK', 2, 't1', 'r_V6RH9FFY9J354M7G13BA6D3XHV', 21, 0);
INSERT INTO public.read_log_rows VALUES ('rd_FV978PP7V00D4C8D', 0, 't3', 'r_KNQKC0R2AV1WCSEBTX0FEV6DGV', 67, 0);
INSERT INTO public.read_log_rows VALUES ('rd_FV978PP7V00D4C8D', 1, 't3', 'r_F9TJVJHQ32G09A15Z9520CN9CN', 62, 0);
INSERT INTO public.read_log_rows VALUES ('rd_90F6SBX2N7Q7BA87', 0, 't2', 'e_TN6Z27K0HG01R6Y4YKV6W64XSN', 55, 0);
INSERT INTO public.read_log_rows VALUES ('rd_9JE5QN6YN8M7TSFG', 0, 't2', 'e_TN6Z27K0HG01R6Y4YKV6W64XSN', 55, 0);


--
-- Data for Name: request_keys; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.request_keys VALUES ('d67707fd634dbb62962b4e6017f6c302ce8efa552d586cb674d213b721fb6fce', 2, '2026-11-24T13:37:53.802Z', NULL);
INSERT INTO public.request_keys VALUES ('6a8b420993d1943c6d40ac58899a69206748b1b3de8b29cfb2f09ddcf546ffbe', 9, '2026-11-24T13:37:53.821Z', NULL);
INSERT INTO public.request_keys VALUES ('9d0fc59c1461911fc73b01c297101e41711f988d7c2e4c10dbd46aa2b33b1e0a', 13, '2026-11-24T13:37:53.832Z', NULL);
INSERT INTO public.request_keys VALUES ('c25320bd27af0a62a11bcde927921b9841abc24b8ea2d1c4cf5cfd2ceb04f95e', 17, '2026-11-24T13:37:53.839Z', NULL);
INSERT INTO public.request_keys VALUES ('29aa15fa354edd9be39fe5f7eb1a7bac29e70078ed23a9f047d0de888cc75671', 21, '2026-11-24T13:37:53.846Z', NULL);
INSERT INTO public.request_keys VALUES ('be064ce8a2041c9cba5d9fa50ad44bd107ca8af4c7361202764bf832b3f5539d', 25, '2026-11-24T13:37:53.855Z', NULL);
INSERT INTO public.request_keys VALUES ('ca36b33f30cfd5aa63f0d221efb6230516fb65d6831d9b27f61a6df2209ddd16', 29, '2026-11-24T13:37:53.864Z', NULL);
INSERT INTO public.request_keys VALUES ('0675fde3ddd9c52fd587c1f5a73cd4d4ecc7315f29b6312491c0660a06344a68', 33, '2026-11-24T13:37:53.873Z', NULL);
INSERT INTO public.request_keys VALUES ('6a54f87a7030d20a8a7f649541a09c0e00c1de197adf775e1107c3733cc77897', 37, '2026-11-24T13:37:53.881Z', NULL);
INSERT INTO public.request_keys VALUES ('3f3dbbc2a762de62af9c68c543e72c45a4dc853ca86046c0e84c75fc0792edc7', 41, '2026-11-24T13:37:53.890Z', NULL);
INSERT INTO public.request_keys VALUES ('cf0b7cf66e1e0e49d55f2731a118f9c3fbd03cc826c97585ca69415b7f9bdb97', 45, '2026-11-24T13:37:53.899Z', NULL);
INSERT INTO public.request_keys VALUES ('e55e151821754aa4538ab89f8eda6be9e3e7ce4824385102f1252e92d56769c5', 49, '2026-11-24T13:37:53.908Z', NULL);
INSERT INTO public.request_keys VALUES ('cc8522457fb7d1817826d24bd2c5f4c03a146cfe2bdd5f5e956addf51ef1f75c', 52, '2026-11-24T13:37:53.915Z', NULL);
INSERT INTO public.request_keys VALUES ('e5e6dd6ae0f019eb87c380a12963e95ec428bc4f15c523f99bb967c6fc4a693a', 55, '2026-11-24T13:37:53.923Z', NULL);
INSERT INTO public.request_keys VALUES ('8ee90a51a5bfb825ad32e50c224318ba69754cce48c64a70b73c648ef26300dc', 58, '2026-11-24T13:37:53.929Z', NULL);


--
-- Data for Name: residue_progress; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: row_origins; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.row_origins VALUES ('r_V6RH9FFY9J354M7G13BA6D3XHV', 't1', 11);
INSERT INTO public.row_origins VALUES ('r_0HX0BEZ3J96GW8CYMYXVCKKK7Y', 't1', 15);
INSERT INTO public.row_origins VALUES ('r_WYXV2M27PD1JYV4HN68E5VAM13', 't1', 19);
INSERT INTO public.row_origins VALUES ('r_P6M68GZNRN8N73T04M6G6NQC2W', 't1', 31);
INSERT INTO public.row_origins VALUES ('r_JR16J09DDPW9EX54GFQVWTQGBJ', 't4', 51);
INSERT INTO public.row_origins VALUES ('e_TN6Z27K0HG01R6Y4YKV6W64XSN', 't2', 54);
INSERT INTO public.row_origins VALUES ('r_KNQKC0R2AV1WCSEBTX0FEV6DGV', 't3', 65);
INSERT INTO public.row_origins VALUES ('r_F9TJVJHQ32G09A15Z9520CN9CN', 't3', 66);


--
-- Data for Name: schema_versions; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.schema_versions VALUES ('sl_ESNC5VC50A2EC6GF', 1, 3, 'd_MQ7WG6HXZNZRCP5H', 6, 'current');


--
-- Data for Name: slots; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.slots VALUES ('sl_ESNC5VC50A2EC6GF', 'household', 'Asia/Shanghai', 1, 5, 1);


--
-- Data for Name: sources; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.sources VALUES (10, 's_NC5PXS7Q71SZQYHV', 'user_message', 'user_stated', 'sl_ESNC5VC50A2EC6GF', 'present');
INSERT INTO public.sources VALUES (14, 's_EGKTGA593MKWQ9DY', 'api_call', 'agent_inferred', 'sl_ESNC5VC50A2EC6GF', 'present');
INSERT INTO public.sources VALUES (18, 's_N7BVK223HD50Z7MW', 'api_call', 'agent_inferred', 'sl_ESNC5VC50A2EC6GF', 'present');
INSERT INTO public.sources VALUES (22, 's_54CJ89JJQGQR0BEK', 'user_message', 'user_stated', 'sl_ESNC5VC50A2EC6GF', 'present');
INSERT INTO public.sources VALUES (26, 's_6CESSAB8MX52ZN25', 'api_call', 'agent_inferred', 'sl_ESNC5VC50A2EC6GF', 'present');
INSERT INTO public.sources VALUES (30, 's_TMCNS0780BRHTVN6', 'api_call', 'agent_inferred', 'sl_ESNC5VC50A2EC6GF', 'present');
INSERT INTO public.sources VALUES (34, 's_5VWG38VSJWYKT3BV', 'api_call', 'agent_inferred', 'sl_ESNC5VC50A2EC6GF', 'present');
INSERT INTO public.sources VALUES (38, 's_96RAFB07HEXD0K55', 'api_call', 'agent_inferred', 'sl_ESNC5VC50A2EC6GF', 'present');
INSERT INTO public.sources VALUES (42, 's_F0CVVBSPRXMN912X', 'api_call', 'agent_inferred', 'sl_ESNC5VC50A2EC6GF', 'present');
INSERT INTO public.sources VALUES (46, 's_830SRXDQRW12W5RS', 'api_call', 'agent_inferred', 'sl_ESNC5VC50A2EC6GF', 'present');
INSERT INTO public.sources VALUES (50, 's_19JCPXTDW026H4EX', 'api_call', 'agent_inferred', 'sl_ESNC5VC50A2EC6GF', 'present');
INSERT INTO public.sources VALUES (53, 's_PM4X4ERVWE959Q02', 'api_call', 'agent_inferred', 'sl_ESNC5VC50A2EC6GF', 'present');
INSERT INTO public.sources VALUES (56, 's_5SCVZEE0VS32YXZ4', 'api_call', 'agent_inferred', 'sl_ESNC5VC50A2EC6GF', 'present');
INSERT INTO public.sources VALUES (59, 's_75VFD0FRS3NKN8A5', 'api_call', 'agent_inferred', 'sl_ESNC5VC50A2EC6GF', 'present');
INSERT INTO public.sources VALUES (63, 's_DPS27VK22TQC1MVW', 'api_call', 'agent_inferred', 'sl_ESNC5VC50A2EC6GF', 'present');
INSERT INTO public.sources VALUES (64, 's_FPDSYKH7B081MMN6', 'api_call', 'agent_inferred', 'sl_ESNC5VC50A2EC6GF', 'present');
INSERT INTO public.sources VALUES (68, 's_37WDY1330VQF7Q9H', 'api_call', 'agent_inferred', 'sl_ESNC5VC50A2EC6GF', 'present');


--
-- Data for Name: t_t1_v1; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.t_t1_v1 VALUES ('r_V6RH9FFY9J354M7G13BA6D3XHV', false, '2026-11-02', 54, 'lunch');
INSERT INTO public.t_t1_v1 VALUES ('r_WYXV2M27PD1JYV4HN68E5VAM13', true, '2026-11-03', 18, 'coffee');
INSERT INTO public.t_t1_v1 VALUES ('r_P6M68GZNRN8N73T04M6G6NQC2W', false, '2026-11-04', 9, 'snack');
INSERT INTO public.t_t1_v1 VALUES ('r_0HX0BEZ3J96GW8CYMYXVCKKK7Y', false, '2026-11-02', 32, 'taxi');


--
-- Data for Name: t_t1_v1__ver; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.t_t1_v1__ver VALUES ('r_V6RH9FFY9J354M7G13BA6D3XHV', 'f1', 9, NULL, 'insert', 11, 'f1', 0, NULL, NULL, '2026-11-02', NULL, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_V6RH9FFY9J354M7G13BA6D3XHV', 'f3', 9, NULL, 'insert', 11, 'f3', 0, NULL, NULL, NULL, NULL, 'lunch');
INSERT INTO public.t_t1_v1__ver VALUES ('r_0HX0BEZ3J96GW8CYMYXVCKKK7Y', 'f1', 13, NULL, 'insert', 15, 'f1', 0, NULL, NULL, '2026-11-02', NULL, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_0HX0BEZ3J96GW8CYMYXVCKKK7Y', 'f3', 13, NULL, 'insert', 15, 'f3', 0, NULL, NULL, NULL, NULL, 'taxi');
INSERT INTO public.t_t1_v1__ver VALUES ('r_WYXV2M27PD1JYV4HN68E5VAM13', 'f1', 17, NULL, 'insert', 19, 'f1', 0, NULL, NULL, '2026-11-03', NULL, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_WYXV2M27PD1JYV4HN68E5VAM13', 'f2', 17, NULL, 'insert', 19, 'f2', 0, NULL, NULL, NULL, 18, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_WYXV2M27PD1JYV4HN68E5VAM13', 'f3', 17, NULL, 'insert', 19, 'f3', 0, NULL, NULL, NULL, NULL, 'coffee');
INSERT INTO public.t_t1_v1__ver VALUES ('r_V6RH9FFY9J354M7G13BA6D3XHV', 'f2', 9, 21, 'insert', 11, 'f2', 0, NULL, NULL, NULL, 45, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_V6RH9FFY9J354M7G13BA6D3XHV', 'f2', 21, NULL, 'correct', 23, 'f2', 0, NULL, NULL, NULL, 54, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_WYXV2M27PD1JYV4HN68E5VAM13', 'existence', 25, NULL, 'revoke', 27, 'existence', 0, true, NULL, NULL, NULL, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_P6M68GZNRN8N73T04M6G6NQC2W', 'f1', 29, NULL, 'insert', 31, 'f1', 0, NULL, NULL, '2026-11-04', NULL, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_P6M68GZNRN8N73T04M6G6NQC2W', 'f2', 29, NULL, 'insert', 31, 'f2', 0, NULL, NULL, NULL, 9, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_P6M68GZNRN8N73T04M6G6NQC2W', 'f3', 29, NULL, 'insert', 31, 'f3', 0, NULL, NULL, NULL, NULL, 'snack');
INSERT INTO public.t_t1_v1__ver VALUES ('r_P6M68GZNRN8N73T04M6G6NQC2W', 'existence', 33, 37, 'revoke', 35, 'existence', 0, true, NULL, NULL, NULL, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_P6M68GZNRN8N73T04M6G6NQC2W', 'existence', 37, NULL, 'revoke', 39, 'existence', 0, NULL, NULL, NULL, NULL, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_0HX0BEZ3J96GW8CYMYXVCKKK7Y', 'f2', 13, 41, 'insert', 15, 'f2', 0, NULL, NULL, NULL, 30, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_0HX0BEZ3J96GW8CYMYXVCKKK7Y', 'f2', 41, NULL, 'update', 43, 'f2', 0, NULL, NULL, NULL, 32, NULL);


--
-- Data for Name: t_t2_v1; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.t_t2_v1 VALUES ('e_TN6Z27K0HG01R6Y4YKV6W64XSN', '2026-10-01', '2026-11-10', 'food', 5000);
INSERT INTO public.t_t2_v1 VALUES ('e_TN6Z27K0HG01R6Y4YKV6W64XSN', '2026-11-10', NULL, 'food', 4000);


--
-- Data for Name: t_t2_v1__ver; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.t_t2_v1__ver VALUES ('e_TN6Z27K0HG01R6Y4YKV6W64XSN', 'f1', '2026-10-01', NULL, 52, NULL, 'update', 54, 'f1', 0, NULL, NULL, 'food', NULL);
INSERT INTO public.t_t2_v1__ver VALUES ('e_TN6Z27K0HG01R6Y4YKV6W64XSN', 'f2', '2026-10-01', NULL, 52, 55, 'update', 54, 'f2', 0, NULL, NULL, NULL, 5000);
INSERT INTO public.t_t2_v1__ver VALUES ('e_TN6Z27K0HG01R6Y4YKV6W64XSN', 'f2', '2026-10-01', '2026-11-10', 55, NULL, 'update', 54, 'f2', 0, NULL, NULL, NULL, 5000);
INSERT INTO public.t_t2_v1__ver VALUES ('e_TN6Z27K0HG01R6Y4YKV6W64XSN', 'f2', '2026-11-10', NULL, 55, NULL, 'update', 57, 'f2', 0, NULL, NULL, NULL, 4000);


--
-- Data for Name: t_t3_v1; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.t_t3_v1 VALUES ('r_F9TJVJHQ32G09A15Z9520CN9CN', false, 'app', 'k-2', 21);
INSERT INTO public.t_t3_v1 VALUES ('r_KNQKC0R2AV1WCSEBTX0FEV6DGV', false, 'app', 'k-1', 12);


--
-- Data for Name: t_t3_v1__ver; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.t_t3_v1__ver VALUES ('r_KNQKC0R2AV1WCSEBTX0FEV6DGV', 'f1', 62, NULL, 'update', 65, 'f1', 0, NULL, NULL, 'app', NULL, NULL);
INSERT INTO public.t_t3_v1__ver VALUES ('r_KNQKC0R2AV1WCSEBTX0FEV6DGV', 'f2', 62, NULL, 'update', 65, 'f2', 0, NULL, NULL, NULL, 'k-1', NULL);
INSERT INTO public.t_t3_v1__ver VALUES ('r_F9TJVJHQ32G09A15Z9520CN9CN', 'f1', 62, NULL, 'update', 66, 'f1', 0, NULL, NULL, 'app', NULL, NULL);
INSERT INTO public.t_t3_v1__ver VALUES ('r_F9TJVJHQ32G09A15Z9520CN9CN', 'f2', 62, NULL, 'update', 66, 'f2', 0, NULL, NULL, NULL, 'k-2', NULL);
INSERT INTO public.t_t3_v1__ver VALUES ('r_F9TJVJHQ32G09A15Z9520CN9CN', 'f3', 62, NULL, 'update', 66, 'f3', 0, NULL, NULL, NULL, NULL, 21);
INSERT INTO public.t_t3_v1__ver VALUES ('r_KNQKC0R2AV1WCSEBTX0FEV6DGV', 'f3', 62, 67, 'update', 65, 'f3', 0, NULL, NULL, NULL, NULL, 10);
INSERT INTO public.t_t3_v1__ver VALUES ('r_KNQKC0R2AV1WCSEBTX0FEV6DGV', 'f3', 67, NULL, 'update', 69, 'f3', 0, NULL, NULL, NULL, NULL, 12);


--
-- Data for Name: t_t4_v1; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.t_t4_v1 VALUES ('r_JR16J09DDPW9EX54GFQVWTQGBJ', false, 'half of lunch', 'r_V6RH9FFY9J354M7G13BA6D3XHV');


--
-- Data for Name: t_t4_v1__ver; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.t_t4_v1__ver VALUES ('r_JR16J09DDPW9EX54GFQVWTQGBJ', 'f1', 49, NULL, 'insert', 51, 'f1', 0, NULL, NULL, 'half of lunch', NULL);
INSERT INTO public.t_t4_v1__ver VALUES ('r_JR16J09DDPW9EX54GFQVWTQGBJ', 'f2', 49, NULL, 'insert', 51, 'f2', 0, NULL, NULL, NULL, 'r_V6RH9FFY9J354M7G13BA6D3XHV');


--
-- Data for Name: task_cursors; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Name: read_log_n_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.read_log_n_seq', 11, true);


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
-- Name: counts counts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counts
    ADD CONSTRAINT counts_pkey PRIMARY KEY (table_id, partition_key);


--
-- Name: d_t5_v1 d_t5_v1_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.d_t5_v1
    ADD CONSTRAINT d_t5_v1_pkey PRIMARY KEY (partition_id);


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
-- Name: t_t1_v1__ver t_t1_v1__ver_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.t_t1_v1__ver
    ADD CONSTRAINT t_t1_v1__ver_pkey PRIMARY KEY (row_id, field_id, rec_from);


--
-- Name: t_t1_v1 t_t1_v1_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.t_t1_v1
    ADD CONSTRAINT t_t1_v1_pkey PRIMARY KEY (row_id);


--
-- Name: t_t2_v1__ver t_t2_v1__ver_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.t_t2_v1__ver
    ADD CONSTRAINT t_t2_v1__ver_pkey PRIMARY KEY (row_id, field_id, valid_from, rec_from);


--
-- Name: t_t2_v1 t_t2_v1_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.t_t2_v1
    ADD CONSTRAINT t_t2_v1_pkey PRIMARY KEY (entity_id, valid_from);


--
-- Name: t_t3_v1__ver t_t3_v1__ver_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.t_t3_v1__ver
    ADD CONSTRAINT t_t3_v1__ver_pkey PRIMARY KEY (row_id, field_id, rec_from);


--
-- Name: t_t3_v1 t_t3_v1_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.t_t3_v1
    ADD CONSTRAINT t_t3_v1_pkey PRIMARY KEY (row_id);


--
-- Name: t_t4_v1__ver t_t4_v1__ver_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.t_t4_v1__ver
    ADD CONSTRAINT t_t4_v1__ver_pkey PRIMARY KEY (row_id, field_id, rec_from);


--
-- Name: t_t4_v1 t_t4_v1_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.t_t4_v1
    ADD CONSTRAINT t_t4_v1_pkey PRIMARY KEY (row_id);


--
-- Name: task_cursors task_cursors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_cursors
    ADD CONSTRAINT task_cursors_pkey PRIMARY KEY (task);


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
-- Name: t_t1_v1__ver_row; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX t_t1_v1__ver_row ON public.t_t1_v1__ver USING btree (row_id, rec_from);


--
-- Name: t_t2_v1__ver_row; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX t_t2_v1__ver_row ON public.t_t2_v1__ver USING btree (row_id, rec_from);


--
-- Name: t_t3_v1__ver_row; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX t_t3_v1__ver_row ON public.t_t3_v1__ver USING btree (row_id, rec_from);


--
-- Name: t_t4_v1__ver_row; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX t_t4_v1__ver_row ON public.t_t4_v1__ver USING btree (row_id, rec_from);


--
-- PostgreSQL database dump complete
--

\unrestrict 7nGq6jdYCTuREbqdTBmb6ffhaw4d0KJ2Kk4OoVOffq7jeYH5jMd3jV1djDCYQjS

