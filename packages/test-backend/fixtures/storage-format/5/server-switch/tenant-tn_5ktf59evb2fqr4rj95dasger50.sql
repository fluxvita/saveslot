--
-- PostgreSQL database dump
--

\restrict 8Hhpk0LJ26pplc2CbDANO2lFIYGj8e9otW7fUgVNFPHhdpCuCz66wUV6joFchk8

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

INSERT INTO public.base_sources VALUES (11, 'r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC', 'f1', 0, 0, 'value', 10, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (11, 'r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC', 'f2', 0, 0, 'value', 10, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (11, 'r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC', 'f3', 0, 0, 'value', 10, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (15, 'r_T226J69Z95XDYC8Q9B84CZEQ0A', 'f1', 0, 0, 'value', 14, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (15, 'r_T226J69Z95XDYC8Q9B84CZEQ0A', 'f2', 0, 0, 'value', 14, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (15, 'r_T226J69Z95XDYC8Q9B84CZEQ0A', 'f3', 0, 0, 'value', 14, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (19, 'r_15D0YYA6VPYZ1XG6404XSGF9P0', 'f1', 0, 0, 'value', 18, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (19, 'r_15D0YYA6VPYZ1XG6404XSGF9P0', 'f2', 0, 0, 'value', 18, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (19, 'r_15D0YYA6VPYZ1XG6404XSGF9P0', 'f3', 0, 0, 'value', 18, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (23, 'r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC', 'f2', 0, 0, 'value', 22, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (27, 'r_15D0YYA6VPYZ1XG6404XSGF9P0', 'existence', 0, 0, 'operation', 26, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (31, 'r_WR69B2FVJQ1FTTB6ACJBMWQ49N', 'f1', 0, 0, 'value', 30, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (31, 'r_WR69B2FVJQ1FTTB6ACJBMWQ49N', 'f2', 0, 0, 'value', 30, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (31, 'r_WR69B2FVJQ1FTTB6ACJBMWQ49N', 'f3', 0, 0, 'value', 30, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (35, 'r_WR69B2FVJQ1FTTB6ACJBMWQ49N', 'existence', 0, 0, 'operation', 34, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[{"op":37,"valid":[{"from":null,"to":null}]}]', NULL, NULL);
INSERT INTO public.base_sources VALUES (39, 'r_WR69B2FVJQ1FTTB6ACJBMWQ49N', 'existence', 0, 0, 'operation', 38, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (43, 'r_T226J69Z95XDYC8Q9B84CZEQ0A', 'f2', 0, 0, 'value', 42, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (51, 'r_DF4P6XP854WAKJA5KCZCN2K4F1', 'f1', 0, 0, 'value', 50, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (51, 'r_DF4P6XP854WAKJA5KCZCN2K4F1', 'f2', 0, 0, 'value', 50, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (54, 'e_WXAAKENGDMG892R1XX11VYKR6W', 'f1', 0, 0, 'value', 53, NULL, NULL, NULL, NULL, 'applied', '2026-10-01', NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (54, 'e_WXAAKENGDMG892R1XX11VYKR6W', 'f1', 0, 1, 'interval', 53, NULL, NULL, NULL, NULL, 'applied', '2026-10-01', NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (54, 'e_WXAAKENGDMG892R1XX11VYKR6W', 'f2', 0, 0, 'value', 53, NULL, NULL, NULL, NULL, 'applied', '2026-10-01', NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (54, 'e_WXAAKENGDMG892R1XX11VYKR6W', 'f2', 0, 1, 'interval', 53, NULL, NULL, NULL, NULL, 'applied', '2026-10-01', NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (57, 'e_WXAAKENGDMG892R1XX11VYKR6W', 'f2', 0, 0, 'value', 56, NULL, NULL, NULL, NULL, 'applied', '2026-11-10', NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (57, 'e_WXAAKENGDMG892R1XX11VYKR6W', 'f2', 0, 1, 'interval', 56, NULL, NULL, NULL, NULL, 'applied', '2026-11-10', NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (65, 'r_ZXQQZBZTZKVMZF3DR72Y0WPERW', 'f1', 0, 0, 'value', 63, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (65, 'r_ZXQQZBZTZKVMZF3DR72Y0WPERW', 'f2', 0, 0, 'value', 63, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (65, 'r_ZXQQZBZTZKVMZF3DR72Y0WPERW', 'f3', 0, 0, 'value', 63, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (66, 'r_VN6ZHQ4XDW34A24P9YSQYPQ5S4', 'f1', 0, 0, 'value', 64, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (66, 'r_VN6ZHQ4XDW34A24P9YSQYPQ5S4', 'f2', 0, 0, 'value', 64, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (66, 'r_VN6ZHQ4XDW34A24P9YSQYPQ5S4', 'f3', 0, 0, 'value', 64, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (69, 'r_ZXQQZBZTZKVMZF3DR72Y0WPERW', 'f3', 0, 0, 'value', 68, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (78, 'r_X075V18D1AMV40A8CPGWMCGCVT', 'f1', 0, 0, 'value', 77, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (78, 'r_X075V18D1AMV40A8CPGWMCGCVT', 'f2', 0, 0, 'value', 77, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (78, 'r_X075V18D1AMV40A8CPGWMCGCVT', 'f3', 0, 0, 'value', 77, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);


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
INSERT INTO public.block_deps VALUES (78, 'duplicate', 0, 11, 'f1', 0, 'deps');
INSERT INTO public.block_deps VALUES (78, 'duplicate', 1, 11, 'f3', 0, 'deps');
INSERT INTO public.block_deps VALUES (79, 'matched/0', 0, 11, 'f1', 0, 'deps');
INSERT INTO public.block_deps VALUES (79, 'matched/0', 1, 11, 'f3', 0, 'deps');


--
-- Data for Name: catalog; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.catalog VALUES ('t5', 1, 'sl_GNTW5THHHYPF6432', '{"description":"what was spent each day","fields":[{"description":"the day","id":"f1","name":"day","type":"date"},{"description":"the sum","id":"f2","name":"total","type":"integer"},{"description":"how many","id":"f3","name":"n","type":"integer"}],"id":"t5","kind":"derived","name":"spent_by_day","rule":{"depends_on":[{"field":"f1","table":"t1"},{"field":"f2","table":"t1"}],"id":"r1","rsql":"rsql@1","scope":{"key":["f1"],"key_from_free_text":false,"kind":"group"},"sql":"SELECT \"t1\".\"f1\" AS \"f1\", CAST(sum(\"t1\".\"f2\") AS bigint) AS \"f2\", count(*) AS \"f3\" FROM \"t1\" GROUP BY 1","time_dependency":"bucketed","version":1}}', NULL, NULL);
INSERT INTO public.catalog VALUES ('t1', 1, 'sl_GNTW5THHHYPF6432', '{"description":"one row per expense","fields":[{"description":"the day","id":"f1","name":"date","required":true,"type":"date"},{"description":"how much, in yuan","id":"f2","name":"amount","type":"integer"},{"description":"what for","id":"f3","name":"note","type":"text"}],"id":"t1","kind":"base","name":"expenses","time":{"field":"f1","type":"event"}}', NULL, NULL);
INSERT INTO public.catalog VALUES ('t2', 1, 'sl_GNTW5THHHYPF6432', '{"description":"a monthly budget by kind","entity_key":["f1"],"fields":[{"description":"what the budget is for","id":"f1","name":"kind","required":true,"type":"text"},{"description":"the budget, in yuan","id":"f2","name":"amount","required":true,"type":"integer"}],"id":"t2","kind":"base","name":"budgets","time":{"granularity":"date","type":"state"}}', NULL, NULL);
INSERT INTO public.catalog VALUES ('t3', 1, 'sl_GNTW5THHHYPF6432', '{"description":"rides from an app","external_key":["f1","f2"],"fields":[{"description":"the app","id":"f1","name":"origin","type":"text"},{"description":"its ID there","id":"f2","name":"external_id","type":"text"},{"description":"how much","id":"f3","name":"fare","type":"integer"}],"id":"t3","kind":"base","name":"rides","time":{"type":"none"}}', NULL, NULL);
INSERT INTO public.catalog VALUES ('t4', 1, 'sl_GNTW5THHHYPF6432', '{"description":"one row per refund of an expense","fields":[{"description":"why","id":"f1","name":"note","required":true,"type":"text"},{"description":"the expense refunded","id":"f2","name":"expense","ref":{"table":"t1","target":"row"},"type":"ref"}],"id":"t4","kind":"base","name":"refunds","time":{"type":"none"}}', NULL, NULL);
INSERT INTO public.catalog VALUES ('t1', 2, 'sl_GNTW5THHHYPF6432', '{"description":"one row per expense","duplicate_keys":[["f1","f3"]],"fields":[{"description":"the day","id":"f1","name":"date","required":true,"type":"date"},{"description":"how much, in yuan","id":"f2","name":"amount","type":"integer"},{"description":"what for","id":"f3","name":"note","type":"text"}],"id":"t1","kind":"base","name":"expenses","time":{"field":"f1","type":"event"}}', NULL, NULL);
INSERT INTO public.catalog VALUES ('t2', 2, 'sl_GNTW5THHHYPF6432', '{"description":"a monthly budget by kind","entity_key":["f1"],"fields":[{"description":"what the budget is for","id":"f1","name":"kind","required":true,"type":"text"},{"description":"the budget, in yuan","id":"f2","name":"amount","required":true,"type":"integer"}],"id":"t2","kind":"base","name":"budgets","time":{"granularity":"date","type":"state"}}', NULL, NULL);
INSERT INTO public.catalog VALUES ('t4', 2, 'sl_GNTW5THHHYPF6432', '{"description":"one row per refund of an expense","fields":[{"description":"why","id":"f1","name":"note","required":true,"type":"text"},{"description":"the expense refunded","id":"f2","name":"expense","ref":{"table":"t1","target":"row"},"type":"ref"}],"id":"t4","kind":"base","name":"refunds","time":{"type":"none"}}', NULL, NULL);
INSERT INTO public.catalog VALUES ('t5', 2, 'sl_GNTW5THHHYPF6432', '{"description":"what was spent each day","fields":[{"description":"the day","id":"f1","name":"day","type":"date"},{"description":"the sum","id":"f2","name":"total","type":"integer"},{"description":"how many","id":"f3","name":"n","type":"integer"}],"id":"t5","kind":"derived","name":"spent_by_day","rule":{"depends_on":[{"field":"f1","table":"t1"},{"field":"f2","table":"t1"}],"id":"r1","rsql":"rsql@1","scope":{"key":["f1"],"key_from_free_text":false,"kind":"group"},"sql":"SELECT \"t1\".\"f1\" AS \"f1\", CAST(sum(\"t1\".\"f2\") AS bigint) AS \"f2\", count(*) AS \"f3\" FROM \"t1\" GROUP BY 1","time_dependency":"bucketed","version":1}}', NULL, NULL);


--
-- Data for Name: content; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.content VALUES (1, 'system', '{"kind":"system","principal":"system"}', 'a2a35fe2925b9b16c34e619069b782461a1ed680a95a60d70eeb5ce5f88ce770', NULL, NULL, NULL);
INSERT INTO public.content VALUES (1, 'tenant', '{"event_format":1,"storage_format":5,"tenant_id":"tn_5KTF59EVB2FQR4RJ95DASGER50"}', '29812aa6d1699a356995c2d57a18c79d8b7cc68ba93693dd466a7a346da142ad', NULL, NULL, NULL);
INSERT INTO public.content VALUES (1, 'user', '{"kind":"user","principal":"u_9Y4XEYT01A0BX9R0VEPPKGZD2Q"}', 'bba881cb5b015b8a72e3171d3918554fe89941efaadc7ad22ac664a09745b196', NULL, NULL, NULL);
INSERT INTO public.content VALUES (2, 'ctx', '{"now":"2026-11-26T10:24:00.367Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', 'b01ccd5403bdec22acfc0fe03f8cbf475e870ed92fa1267fe5dacf361531af6d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (2, 'draft', '{"base_version":null,"slot":"household","tables":[{"description":"one row per expense","fields":[{"description":"the day","name":"date","required":true,"type":"date"},{"description":"how much, in yuan","name":"amount","type":"integer"},{"description":"what for","name":"note","type":"text"}],"kind":"base","name":"expenses","time":{"field":"date","type":"event"}},{"description":"a monthly budget by kind","entity_key":["kind"],"fields":[{"description":"what the budget is for","name":"kind","required":true,"type":"text"},{"description":"the budget, in yuan","name":"amount","required":true,"type":"integer"}],"kind":"base","name":"budgets","time":{"granularity":"date","type":"state"}},{"description":"rides from an app","external_key":["origin","external_id"],"fields":[{"description":"the app","name":"origin","type":"text"},{"description":"its ID there","name":"external_id","type":"text"},{"description":"how much","name":"fare","type":"integer"}],"kind":"base","name":"rides","time":{"type":"none"}},{"description":"one row per refund of an expense","fields":[{"description":"why","name":"note","required":true,"type":"text"},{"description":"the expense refunded","name":"expense","ref":{"table":"expenses","target":"row"},"type":"ref"}],"kind":"base","name":"refunds","time":{"type":"none"}},{"description":"what was spent each day","fields":[{"description":"the day","name":"day"},{"description":"the sum","name":"total"},{"description":"how many","name":"n"}],"kind":"derived","name":"spent_by_day","rule":{"sql":"SELECT date AS day, sum(amount) AS total, count(*) AS n FROM expenses GROUP BY 1","time_dependency":"bucketed"}}],"timezone":"Asia/Shanghai"}', '6445068c0f251c0434a5deb3094dc975f2eabd6b2db0798f06876a7f4497f1b6', NULL, NULL, NULL);
INSERT INTO public.content VALUES (2, 'request_key', '{"key":"f7c33967e997d49e25c82eab595b057e15c3719df6aa4200eb974d580b775735"}', 'f9d68709f3e7da0bfbc58862117f18f6c862798cdb413691fb73b7e8221b3cac', NULL, NULL, NULL);
INSERT INTO public.content VALUES (2, 'target', '{"creates_slot":true,"draft_id":"d_660T17A0JDR8PFHK"}', 'c878741fd6c584467ece2061c9550ab64e73c570b71d10f7a86ddd30167645af', NULL, NULL, NULL);
INSERT INTO public.content VALUES (3, 'changes', '[{"auto":true,"change":"create_slot","class":"create","compatible_with_old_writes":true,"destructive":false,"target":{"slot":true}},{"auto":true,"change":"add_table","class":"create","compatible_with_old_writes":true,"destructive":false,"target":{"table":"t1"}},{"auto":true,"change":"add_table","class":"create","compatible_with_old_writes":true,"destructive":false,"target":{"table":"t2"}},{"auto":true,"change":"add_table","class":"create","compatible_with_old_writes":true,"destructive":false,"target":{"table":"t3"}},{"auto":true,"change":"add_table","class":"create","compatible_with_old_writes":true,"destructive":false,"target":{"table":"t4"}},{"auto":true,"change":"add_derived_table","class":"create","compatible_with_old_writes":true,"destructive":false,"target":{"table":"t5"}}]', '7693e6615a0b0b02e421cfc07d012ee09421e5b1c3597b0698dcf4214e131875', NULL, NULL, NULL);
INSERT INTO public.content VALUES (3, 'compiled', '{"compiler":1,"name":"household","rsql":"rsql@1","slot":"sl_GNTW5THHHYPF6432","sv":1,"tables":[{"description":"one row per expense","fields":[{"description":"the day","id":"f1","name":"date","required":true,"type":"date"},{"description":"how much, in yuan","id":"f2","name":"amount","type":"integer"},{"description":"what for","id":"f3","name":"note","type":"text"}],"id":"t1","kind":"base","name":"expenses","physical":{"table":"t_t1_v1"},"time":{"field":"f1","type":"event"}},{"description":"a monthly budget by kind","entity_key":["f1"],"fields":[{"description":"what the budget is for","id":"f1","name":"kind","required":true,"type":"text"},{"description":"the budget, in yuan","id":"f2","name":"amount","required":true,"type":"integer"}],"id":"t2","kind":"base","name":"budgets","physical":{"table":"t_t2_v1"},"time":{"granularity":"date","type":"state"}},{"description":"rides from an app","external_key":["f1","f2"],"fields":[{"description":"the app","id":"f1","name":"origin","type":"text"},{"description":"its ID there","id":"f2","name":"external_id","type":"text"},{"description":"how much","id":"f3","name":"fare","type":"integer"}],"id":"t3","kind":"base","name":"rides","physical":{"table":"t_t3_v1"},"time":{"type":"none"}},{"description":"one row per refund of an expense","fields":[{"description":"why","id":"f1","name":"note","required":true,"type":"text"},{"description":"the expense refunded","id":"f2","name":"expense","ref":{"table":"t1","target":"row"},"type":"ref"}],"id":"t4","kind":"base","name":"refunds","physical":{"table":"t_t4_v1"},"time":{"type":"none"}},{"description":"what was spent each day","fields":[{"description":"the day","id":"f1","name":"day","type":"date"},{"description":"the sum","id":"f2","name":"total","type":"integer"},{"description":"how many","id":"f3","name":"n","type":"integer"}],"id":"t5","kind":"derived","name":"spent_by_day","physical":{"table":"d_t5_v1"},"rule":{"depends_on":[{"field":"f1","table":"t1"},{"field":"f2","table":"t1"}],"id":"r1","rsql":"rsql@1","scope":{"key":["f1"],"key_from_free_text":false,"kind":"group"},"sql":"SELECT \"t1\".\"f1\" AS \"f1\", CAST(sum(\"t1\".\"f2\") AS bigint) AS \"f2\", count(*) AS \"f3\" FROM \"t1\" GROUP BY 1","time_dependency":"bucketed","version":1}}],"timezone":"Asia/Shanghai"}', '6fb1a5bd6a4f73de9e2cc8bcf6db6b20e671f65e1299f59ff71f4f4d9e20c084', NULL, NULL, NULL);
INSERT INTO public.content VALUES (3, 'target', '{"draft_id":"d_660T17A0JDR8PFHK","outcome":"applied","target_version":1}', '1b81d347bd703993ddc31ced1646220a1e349df43b7382e3e8c336d483fed5c1', NULL, NULL, NULL);
INSERT INTO public.content VALUES (4, 'target', '{"by":"auto","draft_id":"d_660T17A0JDR8PFHK","target_version":1}', 'bc3ef093213f63c6b474b1127434a8e543b66b418f380577872c72ba4805c7ca', NULL, NULL, NULL);
INSERT INTO public.content VALUES (5, 'policy', '{"auto_apply":["add_table","add_derived_table","add_optional_field","description","rename_unused","loosen_constraint","duplicate_keys","restructure_unused"],"effective_value_rule":"keep_current","high_impact":[],"policy_version":1,"rank":{"agent_inferred":1,"miss":0,"user_stated":2},"user_session_only":[]}', '41f24c1878d2f9158397f7d9f675bdff962fb35398d8e890b3c0189f76a21363', NULL, NULL, NULL);
INSERT INTO public.content VALUES (6, 'target', '{"draft_id":"d_660T17A0JDR8PFHK","rebuilt_tables":[],"to_version":1}', '7713f460e922aa838929430dd1342d4c67718543ee85158f2c1e13f9a48e5120', NULL, NULL, NULL);
INSERT INTO public.content VALUES (7, 'ctx', '{"now":"2026-11-26T10:24:00.409Z","ruleset_version":1}', 'a61df7e0b3ce7437b2fb28951c79d2d1f522c528eec42ffb9bbe6dd19d19adf5', NULL, NULL, NULL);
INSERT INTO public.content VALUES (7, 'name', '{"name":"sample agent"}', '0957e5e5000dc767fb05ce8147d97d2657ac9a78f515adbc977be857b71de0d1', NULL, NULL, NULL);
INSERT INTO public.content VALUES (7, 'principal', '{"kind":"connection","principal":"ci_13RVWVAK2CY9070YXR3ADTKAWX","scopes":["saveslot.read","saveslot.write","saveslot.schema"],"via":"token"}', 'ad3b23200a3ab977c2626bfde52f9a4ac943875311d5159bd4eaee44b01ada13', NULL, NULL, NULL);
INSERT INTO public.content VALUES (8, 'ctx', '{"now":"2026-11-26T10:24:00.412Z","ruleset_version":1}', '3d194719cfa75a2b75e2a6cb9fdd49ae1b4bfdf6acea80c97e79b37f2ddeac06', NULL, NULL, NULL);
INSERT INTO public.content VALUES (8, 'name', '{"name":"another agent"}', '95f97e5914d91f1ab0571d876aed20feb5977513c223d29b3d6c4ecf9f84847e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (8, 'principal', '{"kind":"connection","principal":"ci_28AEY7JR69A4PGD30R9SNHE1DN","scopes":["saveslot.read","saveslot.write","saveslot.schema"],"via":"token"}', '5ef4d3e3605227843c37e1bfb7e86f06a9765df97f1c02ab707dd71f4a64d4c9', NULL, NULL, NULL);
INSERT INTO public.content VALUES (9, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-26T10:24:00.415Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', '74f4e899e14c7831379b00e4580bfc634bae13249268e5610dd7c614d5771e76', NULL, NULL, NULL);
INSERT INTO public.content VALUES (9, 'ops/0/set/f1', '"2026-11-02"', 'bb1de3879fc3904da5b8b20834d8d58eac44c618f8305a7357557ae506daf77f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (9, 'ops/0/set/f2', '"45"', '2eecac45827ede372449b7bd78a82139db639d810ebce98caef91e5d1a2fe422', NULL, NULL, NULL);
INSERT INTO public.content VALUES (9, 'ops/0/set/f3', '"lunch"', '861315d6dc2fae3332121172cefb27dbbc4f45d0422d6c7a700e861baadf4f8d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (9, 'ops/0/target', '{"created":true,"intent":"insert","row":"r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC","table":"t1"}', '7d9c5b84b00641cbedff8b16b5cdc6303f62d61293e008e1b214bdd3cabb1c7c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (9, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (9, 'request_key', '{"key":"cffbcfc65163f33fd3f1e918bbfc78bb804293293194a2be25c7cdd1c24449e8"}', 'c47c48945cf9291211e55f9caba064b25428af6d08973c505ab7b45e6f8e7f80', NULL, NULL, NULL);
INSERT INTO public.content VALUES (10, 'target', '{"kind":"user_message","level":"user_stated","source_id":"s_W8YSD28CZ805DHSA"}', 'db5cf2704610bb41e2213b596440d2b49b07f9d00973470ea15d642c82744928', NULL, NULL, NULL);
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
INSERT INTO public.content VALUES (11, 'target', '{"cause":"request","created":true,"intent":"insert","op_index":0,"row":"r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC","sv":1,"table":"t1"}', '43c8857d18be7b008a90e73436cb3919cdcc7edd32e152cf77e8fdf58ddc4e57', NULL, NULL, NULL);
INSERT INTO public.content VALUES (12, 'checksum', '{"checksum":"47747ef5d44f61b2b8d2bca0722b3bccbd836a4860e44353c624370fb2e57386"}', '527f6e06439803548234e5f825f437597b39c7ff2a494893e5c624bef97bfb98', NULL, NULL, NULL);
INSERT INTO public.content VALUES (12, 'key', '{"values":["2026-11-02"]}', 'cc51a7db3e7d0a58c48bf5231237b844def245dd03281bd3f72ded939cff012c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (12, 'target', '{"emptied":false,"partition":"p_9H3HPRDHCKXPZR6K","read_pos":11,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', 'b99bb75aaa3b43aa8bd73815f1dee4a219d38190f6d48dd3223903f4b146c56e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (13, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-26T10:24:00.437Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', 'c938ff52d0953da8b998eda73d2db7cea572949d1d811001a1d5a9afbde282b8', NULL, NULL, NULL);
INSERT INTO public.content VALUES (13, 'ops/0/set/f1', '"2026-11-02"', 'bb1de3879fc3904da5b8b20834d8d58eac44c618f8305a7357557ae506daf77f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (13, 'ops/0/set/f2', '"30"', 'f20e4586c63ba3b2c06a97c4e585acea4a2977c3d8d81dc2d1f2275439ad90a7', NULL, NULL, NULL);
INSERT INTO public.content VALUES (13, 'ops/0/set/f3', '"taxi"', '7a064c2491cc802c8ed3d43507560ab951779574b21991954294405e57be3745', NULL, NULL, NULL);
INSERT INTO public.content VALUES (13, 'ops/0/target', '{"created":true,"intent":"insert","row":"r_T226J69Z95XDYC8Q9B84CZEQ0A","table":"t1"}', 'f3891afb12c664556e295bcda55a3e815e0f0239b2c9a724a91581998dd0d912', NULL, NULL, NULL);
INSERT INTO public.content VALUES (13, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (13, 'request_key', '{"key":"9f9015a7a09a2eae2ae68b0f79db0377c8ffd49e1ea66f1336cdb7e975e1a637"}', '868d382ffb3686413f188b165d09164704ee9adfb35ed789cd2a26b9b0b8a126', NULL, NULL, NULL);
INSERT INTO public.content VALUES (14, 'request', '{"intent":"insert","set":{"amount":30,"date":"2026-11-02","note":"taxi"},"table":"household.expenses"}', 'd9e9ed8dd8d23adf88d6185adafe2254e272a0ecd451d4e2f45bce543f3bfada', NULL, NULL, NULL);
INSERT INTO public.content VALUES (14, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_5SMT7F3GJGCS0C08"}', 'fcfd18eb0cc0fc786a437198fda7abefdce71410938d757c8a90a89b7e87988a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'fields/f1/0', '{"status":"applied","value":"2026-11-02"}', '96a119bb0a7bc53bfaa2b66ba49a944c8959ef63f8218c5af954c7f093c803a2', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'fields/f2/0', '{"status":"applied","value":"30"}', '1712bdc8cfafa74ec9f72dc98448d3d1c62b78b6a7e3151d98154cd62872d59e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'fields/f3/0', '{"status":"applied","value":"taxi"}', 'ca8af995f357da958ad27752fa8f8064ea0cccc9ebbc49097f1b971e69a186d4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'literal/f1/0', '{"segments":[{"result":"na","source":14}]}', 'e05b307243777b6813b055f65fdf8e07b3fc003f3f4cfe5c8d252c266a522d97', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'literal/f2/0', '{"segments":[{"result":"na","source":14}]}', 'e05b307243777b6813b055f65fdf8e07b3fc003f3f4cfe5c8d252c266a522d97', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'literal/f3/0', '{"segments":[{"result":"na","source":14}]}', 'e05b307243777b6813b055f65fdf8e07b3fc003f3f4cfe5c8d252c266a522d97', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'sources/f1/0', '[{"kind":"value","source":14}]', '0c2e432acf8d5e0ebb8b3ccff0fa23f57b1788d2c11a8b7dd55c5a4df69c37b0', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'sources/f2/0', '[{"kind":"value","source":14}]', '0c2e432acf8d5e0ebb8b3ccff0fa23f57b1788d2c11a8b7dd55c5a4df69c37b0', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'sources/f3/0', '[{"kind":"value","source":14}]', '0c2e432acf8d5e0ebb8b3ccff0fa23f57b1788d2c11a8b7dd55c5a4df69c37b0', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'target', '{"cause":"request","created":true,"intent":"insert","op_index":0,"row":"r_T226J69Z95XDYC8Q9B84CZEQ0A","sv":1,"table":"t1"}', 'fd2780a46b4375490e86de41b61999cb8f8a2c359c7b6a69472196981f41608a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (16, 'checksum', '{"checksum":"02cfce4fdae133910f70340dd233e8f0bba42d37f0c5d998442390dfdbb426f0"}', '8466d6b60445e9f1e7b0d5a4efd5d66ec181a0111ebfbce9da69eff2891cc0b3', NULL, NULL, NULL);
INSERT INTO public.content VALUES (16, 'target', '{"emptied":false,"partition":"p_9H3HPRDHCKXPZR6K","read_pos":15,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', 'd36ecaf95285ad7b5f3844e78656328dd102be691ea9aa018768399aab4b19fb', NULL, NULL, NULL);
INSERT INTO public.content VALUES (17, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-26T10:24:00.446Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', '34f7460ff2273e84e3ff8d56efa4005cb40b06090f2f948f0da8d46593698e2b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (17, 'ops/0/set/f1', '"2026-11-03"', 'd658e2a3b5597fab6e1c619fb80cdf08d37763c2d403667798cddcf65eeccb97', NULL, NULL, NULL);
INSERT INTO public.content VALUES (17, 'ops/0/set/f2', '"18"', '0234a350f4d56ae45c5ece57b08c54496f372bc570bd83a465fb6d2d85531479', NULL, NULL, NULL);
INSERT INTO public.content VALUES (17, 'ops/0/set/f3', '"coffee"', '0f52baaa23b045e196e5c8bffd06442c98eca166ca9d77582ce939d5f1b67a7d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (17, 'ops/0/target', '{"created":true,"intent":"insert","row":"r_15D0YYA6VPYZ1XG6404XSGF9P0","table":"t1"}', 'a9e46ace6b709146aa763d11ae78ca109b4871a456a365177507aa632fd348d4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (17, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (17, 'request_key', '{"key":"b202f2c2827ed3319f0ea354ad8f70b18839865d9c00aaabff1d9a0d6a1256ab"}', '5218b99c3a117ba865e8e86d705211cdbde1473ddf640239157dcae4d283b257', NULL, NULL, NULL);
INSERT INTO public.content VALUES (18, 'request', '{"intent":"insert","set":{"amount":18,"date":"2026-11-03","note":"coffee"},"table":"household.expenses"}', '6da0ef3e89920647fdb115c80b2a013c88124bcb6196612e78670c5eae4d9692', NULL, NULL, NULL);
INSERT INTO public.content VALUES (18, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_27C465DSY2DA5R06"}', '7b5affefaf624c62e19276f0c035362ac191e4694b61b3966f00fa6a11b070d6', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'fields/f1/0', '{"status":"applied","value":"2026-11-03"}', '54dff293fa73477624b85fd869155a45261fa9df38233ae3c67233b985538f91', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'fields/f2/0', '{"status":"applied","value":"18"}', '751b79871b4d159bc5c227b5a148469189fbce2f626be069f2569073af35daaa', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'fields/f3/0', '{"status":"applied","value":"coffee"}', '24ee69f41a25745b6cdb4e2910f9a6041cd302067b02f167fdc0e0e95f137c02', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'literal/f1/0', '{"segments":[{"result":"na","source":18}]}', '4a58ed960a93a8baf068beb9c9dc53968928ddc2e4c32292bb87467a49116653', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'literal/f2/0', '{"segments":[{"result":"na","source":18}]}', '4a58ed960a93a8baf068beb9c9dc53968928ddc2e4c32292bb87467a49116653', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'literal/f3/0', '{"segments":[{"result":"na","source":18}]}', '4a58ed960a93a8baf068beb9c9dc53968928ddc2e4c32292bb87467a49116653', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'sources/f1/0', '[{"kind":"value","source":18}]', '319b9de0cbecc6b80f3925d4ca8167b0a3934443f98d4627237125576b1ae684', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'sources/f2/0', '[{"kind":"value","source":18}]', '319b9de0cbecc6b80f3925d4ca8167b0a3934443f98d4627237125576b1ae684', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'sources/f3/0', '[{"kind":"value","source":18}]', '319b9de0cbecc6b80f3925d4ca8167b0a3934443f98d4627237125576b1ae684', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'target', '{"cause":"request","created":true,"intent":"insert","op_index":0,"row":"r_15D0YYA6VPYZ1XG6404XSGF9P0","sv":1,"table":"t1"}', 'de4f124581db8476d5bd0d2c32ef0b9f94e45eedb407726289068c94d2429dc1', NULL, NULL, NULL);
INSERT INTO public.content VALUES (20, 'checksum', '{"checksum":"2fdb99b9e376a0eeb9374c90106ded3f433d35bc1a11400eea77fa992ffc1b74"}', '2b6486c5a4c6121ac9f7a151dd594635971ef3202c83a53472eee255f03746ef', NULL, NULL, NULL);
INSERT INTO public.content VALUES (20, 'key', '{"values":["2026-11-03"]}', '197cbb7c11daaeba4de02e882703c19e248a409995fb839b5ad392c09d93f8dd', NULL, NULL, NULL);
INSERT INTO public.content VALUES (20, 'target', '{"emptied":false,"partition":"p_756ESA1YTGYB3EK2","read_pos":19,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', 'a960e3d0b18fd5645ffd17714b8b5f13e9b957f082d75711c495fd38d8b10754', NULL, NULL, NULL);
INSERT INTO public.content VALUES (21, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-26T10:24:00.455Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', '435ca5aaca48bb0b1c748401b5661c9c8bbd198381c15acda08774bc876a1495', NULL, NULL, NULL);
INSERT INTO public.content VALUES (21, 'ops/0/set/f2', '"54"', '6ce1ced1ac1f56f8cd7ee5c55d117fe99c805b89a603e36c41852fea49853068', NULL, NULL, NULL);
INSERT INTO public.content VALUES (21, 'ops/0/target', '{"intent":"correct","row":"r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC","table":"t1","ver":{"basis":"explicit","current":true,"op":9,"restore_count":0}}', '7b01397b7149085b6635425fde9e153df29ae73da0ccccff3b07a1ee676f5e83', NULL, NULL, NULL);
INSERT INTO public.content VALUES (21, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (21, 'request_key', '{"key":"4cbef7d0c51d63ce64e66be766cff178f7f54dd05e2735135c475fa85e72ad90"}', '0aa772ef8851283c6c368211e7688ece851fb83597f3d4584f3e0c37b9244aef', NULL, NULL, NULL);
INSERT INTO public.content VALUES (22, 'target', '{"kind":"user_message","level":"user_stated","source_id":"s_E0ERE1FV44S28PZ1"}', '06c071647ffeef2ba91091b40b37690148771b4d092219e476a63dca8fb108cc', NULL, NULL, NULL);
INSERT INTO public.content VALUES (22, 'text', '{"text":"sorry, lunch was 54"}', '09db22c6ce9b888483906e0876b820f9021653c803cd9a16790a11f4e740081b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (23, 'fields/f2/0', '{"status":"applied","value":"54"}', '3066d5922eca1709cab4c55d047596dc085c9289eb0e69902f10bdafc414ee89', NULL, NULL, NULL);
INSERT INTO public.content VALUES (23, 'literal/f2/0', '{"segments":[{"result":"hit","source":22}]}', '4f71b5712c5b41e18380034068b347aebb77c5689a10fd56ecdb06563ff837e8', NULL, NULL, NULL);
INSERT INTO public.content VALUES (23, 'sources/f2/0', '[{"kind":"value","source":22}]', '6dbed4dff6a4840169d6cfbd4eb235fde4756a6ffdd1b298f89c0adababc0022', NULL, NULL, NULL);
INSERT INTO public.content VALUES (23, 'target', '{"cause":"request","intent":"correct","op_index":0,"row":"r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC","sv":1,"table":"t1"}', '358fc920a8b9e35c7b9d7e368331ad0d71e113ccb1ccbb97cd4b064cc8252cea', NULL, NULL, NULL);
INSERT INTO public.content VALUES (24, 'checksum', '{"checksum":"3eaa57f629c2a16acdfd512fb6ff4bec8d27f9ae97841034db8e35931425ff82"}', '39adea92dc1a7ba45beaca0e29d34ad976f8b8c60620a2631154d90778de98cb', NULL, NULL, NULL);
INSERT INTO public.content VALUES (24, 'target', '{"emptied":false,"partition":"p_9H3HPRDHCKXPZR6K","read_pos":23,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', '373fdec0f8b45a2b68b884584f62d5f7cd61810af3077740d864666464b0e2b0', NULL, NULL, NULL);
INSERT INTO public.content VALUES (25, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-26T10:24:00.464Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', '559d24098263bb3b943b5150db063967404cdcc29c581befa92c2ef07e6b7dd1', NULL, NULL, NULL);
INSERT INTO public.content VALUES (25, 'ops/0/target', '{"intent":"revoke","row":"r_15D0YYA6VPYZ1XG6404XSGF9P0","table":"t1","ver":{"basis":"explicit","current":true,"op":17,"restore_count":0}}', '03ca971c8a253543b4693945c5779e64150099ff15179724317303aef367a1af', NULL, NULL, NULL);
INSERT INTO public.content VALUES (25, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (25, 'request_key', '{"key":"73726a56779c4e8742f661b905d04980116ce132e4de540143b4a1e2eda00b01"}', 'd39b92c28b5e8f7a600115c2f098c0c38d2d886240d578671013154dafbbe4ca', NULL, NULL, NULL);
INSERT INTO public.content VALUES (26, 'request', '{"intent":"revoke","row":"r_15D0YYA6VPYZ1XG6404XSGF9P0","table":"household.expenses","ver":"v17.0"}', 'c7ee1265c56c2cb4c56d53963a63a53f2f2f6b9aa6b74797bacc448f248d61c6', NULL, NULL, NULL);
INSERT INTO public.content VALUES (26, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_KHP7SN6E8GXXYYRW"}', 'a48bdf3f1fe3c3c15e02e906e0bb8d5209bc6cbf112df7c101c7e58360723846', NULL, NULL, NULL);
INSERT INTO public.content VALUES (27, 'existence/0', '{"scope":"whole","status":"applied"}', '2f44b7beb399a814e1e20abc7d4ccfb73d0038177fbe9f78c3a9f6d7c497e5a2', NULL, NULL, NULL);
INSERT INTO public.content VALUES (27, 'op_sources', '[26]', '9cab0519f56f13acec86572516e8ebe7b99aa40011ec3171c9c8af90c08cae7a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (27, 'target', '{"cause":"request","intent":"revoke","op_index":0,"row":"r_15D0YYA6VPYZ1XG6404XSGF9P0","sv":1,"table":"t1"}', '10b3906d9e48d7545c2d923ee3e6c6de851180d4d6c8246b4a8ee5bb95ed200f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (28, 'target', '{"emptied":true,"partition":"p_756ESA1YTGYB3EK2","read_pos":27,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', '7757bdc7441183f95edceb546ca75682dbc414760317966c3793219557671098', NULL, NULL, NULL);
INSERT INTO public.content VALUES (29, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-26T10:24:00.474Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', 'e9cea17baa84c609a3e35ccf779c7a7c8c726a39a6ee06aea01804088b99bf90', NULL, NULL, NULL);
INSERT INTO public.content VALUES (29, 'ops/0/set/f1', '"2026-11-04"', 'ba9fc93c7ed70a8b525f0a62023d41e1344542f7d58b17385ccc81443bf5421c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (29, 'ops/0/set/f2', '"9"', '986b79d4b69dffb1d19836f47b27073d95bf55201b3385aceb7e0687a21d8667', NULL, NULL, NULL);
INSERT INTO public.content VALUES (29, 'ops/0/set/f3', '"snack"', '176fabc59f5999b35a637537307adcad5b993e0c555bf86e403953b5bdd86a7e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (29, 'ops/0/target', '{"created":true,"intent":"insert","row":"r_WR69B2FVJQ1FTTB6ACJBMWQ49N","table":"t1"}', 'bc3ae84fcb957e059ffb9ce828b6e6179791f93cf8ef8b786c01bdcd42921a1d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (29, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (29, 'request_key', '{"key":"614c738e44325a96c3cfd36bbf7363d45268ad53434080ec9231ad3c9010cc7a"}', 'e92c5bb510189da972c55aa7a9e58f6aed8bba9b34a6f825852136d3f9ffa0c7', NULL, NULL, NULL);
INSERT INTO public.content VALUES (30, 'request', '{"intent":"insert","set":{"amount":9,"date":"2026-11-04","note":"snack"},"table":"household.expenses"}', '1e6e090a868923bafd27c360a50ab1d8bf00f4cedd7b02ccf64f898deee5a144', NULL, NULL, NULL);
INSERT INTO public.content VALUES (30, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_92YYN8AZKE98CS6H"}', 'd71f819cf645a12d9f413c716fdb4b71f2671da29f6ed5bfaefff052d051db43', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'fields/f1/0', '{"status":"applied","value":"2026-11-04"}', '44b6698d9440c789295afb873b3ac44d7074d41b719e4df1a846a31176d561ca', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'fields/f2/0', '{"status":"applied","value":"9"}', '61a0d6511cffcfb500d40f4e295289bdaef54675ed7241046e86da526085d56b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'fields/f3/0', '{"status":"applied","value":"snack"}', '79e9d32653ca14f4fdcec42e8e4b56080f01c897eeec3b97c1e7f22fc968a812', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'literal/f1/0', '{"segments":[{"result":"na","source":30}]}', '7af69cfa023aa24d18ec68e07573f47a474e1d13da839998df0e1c363cf6f334', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'literal/f2/0', '{"segments":[{"result":"na","source":30}]}', '7af69cfa023aa24d18ec68e07573f47a474e1d13da839998df0e1c363cf6f334', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'literal/f3/0', '{"segments":[{"result":"na","source":30}]}', '7af69cfa023aa24d18ec68e07573f47a474e1d13da839998df0e1c363cf6f334', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'sources/f1/0', '[{"kind":"value","source":30}]', '75e656324aefbcea4bd4431d6f5bedfcd073b73471966079df82048672fc3d66', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'sources/f2/0', '[{"kind":"value","source":30}]', '75e656324aefbcea4bd4431d6f5bedfcd073b73471966079df82048672fc3d66', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'sources/f3/0', '[{"kind":"value","source":30}]', '75e656324aefbcea4bd4431d6f5bedfcd073b73471966079df82048672fc3d66', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'target', '{"cause":"request","created":true,"intent":"insert","op_index":0,"row":"r_WR69B2FVJQ1FTTB6ACJBMWQ49N","sv":1,"table":"t1"}', '81f5b8adef5c9ef78a43891f1c2f09557916a0e7ac0be2d46bce92ad64fb0adb', NULL, NULL, NULL);
INSERT INTO public.content VALUES (32, 'checksum', '{"checksum":"352a37dda5548e17e41bc41d1faa41d33dfcf315b1b402cb40e86eb72eb109d9"}', 'f90a6949e3b50c947cbebb1eae26b3cd72eaadbef3fc613c8acfa2681db8358b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (32, 'key', '{"values":["2026-11-04"]}', '604bbd9e49c4a6737a3e5339db270d2778e5ed0ba7e814c136b4310d52da0b40', NULL, NULL, NULL);
INSERT INTO public.content VALUES (32, 'target', '{"emptied":false,"partition":"p_CB2PNKC8BDR84JE8","read_pos":31,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', '88add3360784e6ef9df4f50c4f3deb70a00c16e11c4437773fe74146d5924220', NULL, NULL, NULL);
INSERT INTO public.content VALUES (33, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-26T10:24:00.482Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', '048b453296bb798929dc6a8a83721a9614855b34c5f1acf4594e9ddaad860b58', NULL, NULL, NULL);
INSERT INTO public.content VALUES (33, 'ops/0/target', '{"intent":"revoke","row":"r_WR69B2FVJQ1FTTB6ACJBMWQ49N","table":"t1","ver":{"basis":"explicit","current":true,"op":29,"restore_count":0}}', 'aafee450bbe7e0a8deef01e2bbc2fbcf4d1a1cb218328896da2b04efe0d0f05f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (33, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (33, 'request_key', '{"key":"25bc9d12e49ee4cacdd1c4dca207f3afbfccd6f3cbe3cd8cddd4b8d5eddb0e7a"}', '1fa44646b844b9792d2536faf7138519374b2143e24b9ed3916bf4b64d95a769', NULL, NULL, NULL);
INSERT INTO public.content VALUES (34, 'request', '{"intent":"revoke","row":"r_WR69B2FVJQ1FTTB6ACJBMWQ49N","table":"household.expenses","ver":"v29.0"}', '5cb6b6533d6492c1958dbf76001ca1b00429ff48ebe613d764eb635379cb097e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (34, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_SSKACYGVXD9MFFZJ"}', '1721a6f54a1fe6ec143cbacc97c36f0883c59a68007a42b3aa6f432c63d3c599', NULL, NULL, NULL);
INSERT INTO public.content VALUES (35, 'existence/0', '{"scope":"whole","status":"applied"}', '2f44b7beb399a814e1e20abc7d4ccfb73d0038177fbe9f78c3a9f6d7c497e5a2', NULL, NULL, NULL);
INSERT INTO public.content VALUES (35, 'op_sources', '[34]', 'cf898e079ee71e303468636c3d556a4b0748b4d896c226e31cbdc1f1c20932e5', NULL, NULL, NULL);
INSERT INTO public.content VALUES (35, 'target', '{"cause":"request","intent":"revoke","op_index":0,"row":"r_WR69B2FVJQ1FTTB6ACJBMWQ49N","sv":1,"table":"t1"}', '6641110d2295d0552e282215c5b168f641ad60ac4d4c3f67b5744ddb7027d4d2', NULL, NULL, NULL);
INSERT INTO public.content VALUES (36, 'target', '{"emptied":true,"partition":"p_CB2PNKC8BDR84JE8","read_pos":35,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', '487d2b429c06ca8dd858d66d17d03587b07a466bc8031e586f0615e7f7dabf08', NULL, NULL, NULL);
INSERT INTO public.content VALUES (37, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-26T10:24:00.489Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', '04604f79c067223794a9e7205ab074b93e65f1be288d6d4008e60425c5e8eabd', NULL, NULL, NULL);
INSERT INTO public.content VALUES (37, 'ops/0/revert', '{"include_later":false,"undo_op":33}', '79752873190e2f65f33153cf3fb49caa616976cd990b5b33a7504ff220add01b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (37, 'ops/0/target', '{"intent":"revoke","row":"r_WR69B2FVJQ1FTTB6ACJBMWQ49N","table":"t1"}', '0ae017676ca18d931a1bc4b5a2e179946023d3ea50d1c614a0c2e6abf635dbe1', NULL, NULL, NULL);
INSERT INTO public.content VALUES (37, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (37, 'request_key', '{"key":"e774d76a8e980291c7d0b8158d87e13f3e0960d99a4269f6973a59dc7e568055"}', 'c50f4e075906870734ccf9fb1d9786a1a4edc6a615e0d1acd1ac78870af46127', NULL, NULL, NULL);
INSERT INTO public.content VALUES (38, 'request', '{"revert":{"undo":33},"row":"r_WR69B2FVJQ1FTTB6ACJBMWQ49N","table":"household.expenses"}', 'cdceb6430e7e40d0c08236ea0c5f02e3f977684feabc513b4a283faedd089c4c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (38, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_R01833QMNASB67KP"}', '5b5282140aa4da2b5d0e337f2b47794c4e4ab1586fdc8c95be27be7ad89f00ae', NULL, NULL, NULL);
INSERT INTO public.content VALUES (39, 'existence/0', '{"restored":true,"scope":"whole","status":"applied"}', '989e2e5071049ed6593c6ff63c96b6521f8c23fc8e1bfa4eb479dfb610f5a74f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (39, 'op_sources', '[38]', '3c2487b1e732eb168accd2f394b776519932cd77d5b74840e575428a0e87b71d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (39, 'revert', '{"before_op":33,"items":[{"event":35,"existence":true}]}', 'dcab9f5b1aecea8241e226a5962f39fff3421dc142c03c109ddf69dd08a2f9cd', NULL, NULL, NULL);
INSERT INTO public.content VALUES (39, 'target', '{"cause":"request","intent":"revoke","op_index":0,"row":"r_WR69B2FVJQ1FTTB6ACJBMWQ49N","sv":1,"table":"t1"}', '6641110d2295d0552e282215c5b168f641ad60ac4d4c3f67b5744ddb7027d4d2', NULL, NULL, NULL);
INSERT INTO public.content VALUES (40, 'checksum', '{"checksum":"352a37dda5548e17e41bc41d1faa41d33dfcf315b1b402cb40e86eb72eb109d9"}', 'f90a6949e3b50c947cbebb1eae26b3cd72eaadbef3fc613c8acfa2681db8358b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (40, 'target', '{"emptied":false,"partition":"p_CB2PNKC8BDR84JE8","read_pos":39,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', 'e2a5820c23b8db1f0fcc8cbc75f46df29be5ddd53f0b280d12edc7683df17656', NULL, NULL, NULL);
INSERT INTO public.content VALUES (41, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-26T10:24:00.497Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', '3214fea01a7349a02866a62cea985ec5fdf39596f557e5dc811397164d531c9b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (41, 'ops/0/set/f2', '"32"', 'ca30de1c42bd3e0fdbeb7fb612cbf42e8e757b6948b7a51a67827df28b65107b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (41, 'ops/0/target', '{"intent":"update","row":"r_T226J69Z95XDYC8Q9B84CZEQ0A","table":"t1","ver":{"basis":"explicit","current":true,"op":13,"restore_count":0}}', 'be57ea779c26eaabb45c6a6f87534af64c71804f7ec39eb9ce3bc3514f39c9f8', NULL, NULL, NULL);
INSERT INTO public.content VALUES (41, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (41, 'request_key', '{"key":"a1ca33c5264115c940eb1347cbb63d668693c13a31af436a4c6753d991bf0f51"}', 'b7c5454f532b48b798888e2af942e9dd101571235130ade9a05f5f65d7cfb803', NULL, NULL, NULL);
INSERT INTO public.content VALUES (42, 'request', '{"intent":"update","row":"r_T226J69Z95XDYC8Q9B84CZEQ0A","set":{"amount":32},"table":"household.expenses","ver":"v13.0"}', 'd93c92608b9cc33bf0f56233c7188bb7246536c750f5a7c748875134bd6a8436', NULL, NULL, NULL);
INSERT INTO public.content VALUES (42, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_QCSZMSTW3833DX8C"}', 'b79f098c8d254e6a764c7b8d949d10b0921fb0a57c3ad43773ad77cbfa7fd633', NULL, NULL, NULL);
INSERT INTO public.content VALUES (43, 'fields/f2/0', '{"status":"applied","value":"32"}', 'd01ac326febf20813c49818b031035331a6f1e7ded0b73a8b97106cec8d47823', NULL, NULL, NULL);
INSERT INTO public.content VALUES (43, 'literal/f2/0', '{"segments":[{"result":"na","source":42}]}', '1a687bdc91fa9ef800597fc2cd0f41c7108d749595bed18fb74240e3f9ea68ad', NULL, NULL, NULL);
INSERT INTO public.content VALUES (43, 'sources/f2/0', '[{"kind":"value","source":42}]', '3e7a7b48647625cc8a330c1532e3369fce25d168ab0f7550f5277aa9ece719ea', NULL, NULL, NULL);
INSERT INTO public.content VALUES (43, 'target', '{"cause":"request","intent":"update","op_index":0,"row":"r_T226J69Z95XDYC8Q9B84CZEQ0A","sv":1,"table":"t1"}', '54900bdd8505893c40461a458359b7a4e8e4e3a443465f6f150332c529e57b4a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (44, 'checksum', '{"checksum":"5aa3eee0bb3c73e7b833ae4779c454cd1706ac1c695777f62fbac858f284a139"}', 'a21a42a61794912949d594a6d2bf584300603cc131bfa770b320ee28bf982b08', NULL, NULL, NULL);
INSERT INTO public.content VALUES (44, 'target', '{"emptied":false,"partition":"p_9H3HPRDHCKXPZR6K","read_pos":43,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', '66b211c0ff40849516c8b58996b009280c694b587f73a57fda6693bf512c7bcf', NULL, NULL, NULL);
INSERT INTO public.content VALUES (45, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-26T10:24:00.504Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', '1c58f84e25b8bb1e85968dfdfc70c3098e46f686455b208eee193a8d25f310e1', NULL, NULL, NULL);
INSERT INTO public.content VALUES (45, 'ops/0/set/f2', '"35"', '4bf17f4cd842cc1812f81a696010ee962c1c6f4db784a26b47cfde3144db8ae4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (45, 'ops/0/target', '{"intent":"update","row":"r_T226J69Z95XDYC8Q9B84CZEQ0A","table":"t1","ver":{"basis":"explicit","op":13,"restore_count":0}}', '5c6a160be5848720db8bcd92c999d4e7610f2a497f3a3bb55d18895174151e1b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (45, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (45, 'request_key', '{"key":"8b9fedf0694d30621e71fc521fdaca8a9936c61c16fb0866031f3b4364e18b09"}', '1319449d2ef206e60f64ad12f3e2cf97ccd694701c630a6e63b52ae586b03137', NULL, NULL, NULL);
INSERT INTO public.content VALUES (46, 'request', '{"intent":"update","row":"r_T226J69Z95XDYC8Q9B84CZEQ0A","set":{"amount":35},"table":"household.expenses","ver":"v13.0"}', 'eaf04cff3c9a0b9b66c8b34c6db6ecf498835ec39fcab13f67801eef94e918c3', NULL, NULL, NULL);
INSERT INTO public.content VALUES (46, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_CPKSYSENZVCA7J9T"}', '88c650e9da7278087a42c4449150ef5a4edda7fe9f85617f39df399960fbf3f3', NULL, NULL, NULL);
INSERT INTO public.content VALUES (47, 'fields/f2/0', '{"status":"candidate","value":"35"}', '0a46b36e4a8dcb521e89b693b64fb7ed71b710c7c253e001ab2d859ae7e6c13c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (47, 'literal/f2/0', '{"segments":[{"result":"na","source":46}]}', 'ec9a7df5f7d36e2816c86bda732347207da16137a062374518ad63eab7918133', NULL, NULL, NULL);
INSERT INTO public.content VALUES (47, 'sources/f2/0', '[{"kind":"value","source":46}]', 'b073fca649b906c9bf85d19138aa9815cd7bdf17d1dc4c51b535ded225066ef9', NULL, NULL, NULL);
INSERT INTO public.content VALUES (47, 'target', '{"cause":"request","intent":"update","op_index":0,"row":"r_T226J69Z95XDYC8Q9B84CZEQ0A","sv":1,"table":"t1"}', '54900bdd8505893c40461a458359b7a4e8e4e3a443465f6f150332c529e57b4a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (48, 'candidates/0', '{"cause":"stale_write","deps":[{"event":47,"field":"f2","k":0}],"event":47,"intent":"update","items":[{"field":"f2","k":0,"value":"35"}],"seen":{"op":13,"restore_count":0}}', '065fc524c2f0fbb871cfbd39e9ee0066e0b87479a0bff27648841667910e752f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (48, 'current/0', '{"deps":[{"event":43,"field":"f2","k":0}],"field":"f2","op":41,"value":"32"}', '0c88032ef80c150050b77d11b9327972c67ab4ea3a6fbb5b5b8949dc6ef4dbb2', NULL, NULL, NULL);
INSERT INTO public.content VALUES (48, 'impact/0', '{"deps":[{"event":43,"field":"f2","k":0}],"kind":"reverted_write","op":41}', '781a112cf029985289bd07f26a2dea668fd6e9323c41b08e9dd99a5e79592e45', NULL, NULL, NULL);
INSERT INTO public.content VALUES (48, 'previous/0', '{"deps":[{"event":15,"field":"f2","k":0}],"field":"f2","value":"30"}', 'fae62666626a12c8b83c7a340e9588ee0da9a0d3a64b6136433e8578e60f82cc', NULL, NULL, NULL);
INSERT INTO public.content VALUES (48, 'target', '{"item":"pi_HW8HTKYH4BC5CGM5","merge_base_op":13,"origin_event":47,"policy_version":1,"reason":"stale_write","row":"r_T226J69Z95XDYC8Q9B84CZEQ0A","ruleset_version":1,"table":"t1","type":"conflict","unit":["f2"]}', 'fe209159236b78dd0ff1ecb62f3f4abe2a41d7b77e70fa35b69496fe38885fac', NULL, NULL, NULL);
INSERT INTO public.content VALUES (49, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-26T10:24:00.514Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', '1cf9eb545ccba8a503f51e1805ab22ad9123f460579d641f1e17c6523525a857', NULL, NULL, NULL);
INSERT INTO public.content VALUES (49, 'ops/0/premises/0', '{"fields":["f2"],"range":"whole","row":"r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC","state":"current","table":"t1","ver":{"basis":"explicit","op":21,"restore_count":0}}', 'b8b4043bb2d66ab6d6d7187d3e271bce72e49047a24b1e8bcdd7bf4a59f7dc1b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (49, 'ops/0/set/f1', '"half of lunch"', 'c41224c57a8fe82b0d2e8c579ce6599dedf399a406007932a8013d383f495748', NULL, NULL, NULL);
INSERT INTO public.content VALUES (49, 'ops/0/set/f2', '"r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC"', '123990316566ba098f4395b74f3ad3966eb284382d8d2f8b903a1783a589bd4a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (49, 'ops/0/target', '{"created":true,"intent":"insert","row":"r_DF4P6XP854WAKJA5KCZCN2K4F1","table":"t4"}', '7efafd3739f4e4f435f228a361e02f2e014cd04fdbd644b062443ab88b736ad2', NULL, NULL, NULL);
INSERT INTO public.content VALUES (49, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (49, 'request_key', '{"key":"7751276e9ca66262b1de6f608962a58a408b0330e71f20642201c43fd9abc641"}', '1e7800e47e43d64f4764969547496769c9377be8cbe440d0e6064be172c86502', NULL, NULL, NULL);
INSERT INTO public.content VALUES (50, 'request', '{"intent":"insert","premises":[{"fields":["amount"],"row":"r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC","table":"household.expenses","ver":"v21.0"}],"set":{"expense":"r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC","note":"half of lunch"},"table":"household.refunds"}', 'd22c5f35c4d1b0c047d558639779c50c1ca6294a6a1f9a4d60ce1b44af2372af', NULL, NULL, NULL);
INSERT INTO public.content VALUES (50, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_0KGK222570AWN263"}', '813e1229eaf635900252639683256d2a637076842d7c9858f090c6403f463605', NULL, NULL, NULL);
INSERT INTO public.content VALUES (51, 'fields/f1/0', '{"status":"applied","value":"half of lunch"}', '6731b651c19eec0bf119411356eedb0d936803628773af9b41f5c8023511d907', NULL, NULL, NULL);
INSERT INTO public.content VALUES (51, 'fields/f2/0', '{"status":"applied","value":"r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC"}', '3581142baa8eaa9fafe3151fbed0a06a8283ebdaaa33d109a02e0f903ddee30d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (51, 'literal/f1/0', '{"segments":[{"result":"na","source":50}]}', '47b1956d41eaa447fffc4d8db1ff7cdb9186a0bf686582c5531d51a398c87729', NULL, NULL, NULL);
INSERT INTO public.content VALUES (51, 'literal/f2/0', '{"segments":[{"result":"na","source":50}]}', '47b1956d41eaa447fffc4d8db1ff7cdb9186a0bf686582c5531d51a398c87729', NULL, NULL, NULL);
INSERT INTO public.content VALUES (51, 'sources/f1/0', '[{"kind":"value","source":50}]', 'cd8ffd1b682a43ec63e90b2f0816a49abf4870fae625151a8e201616ea0c273d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (51, 'sources/f2/0', '[{"kind":"value","source":50}]', 'cd8ffd1b682a43ec63e90b2f0816a49abf4870fae625151a8e201616ea0c273d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (51, 'target', '{"cause":"request","created":true,"intent":"insert","op_index":0,"row":"r_DF4P6XP854WAKJA5KCZCN2K4F1","sv":1,"table":"t4"}', '5f9c482601ce9ebc3f0c9dad79ca1502e9da640fca24ae2b81739b6e4cd66b7b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (52, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-26T10:24:00.521Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', '35c6dd5c6da8c478937558f5a6821c27161ceeaf149bf11adbc54ebc5dae2768', NULL, NULL, NULL);
INSERT INTO public.content VALUES (52, 'ops/0/set/f1', '"food"', '90960c7a6145a97cbb09d6478535c2b31f76050310286dabe9ae2463ee003850', NULL, NULL, NULL);
INSERT INTO public.content VALUES (52, 'ops/0/set/f2', '"5000"', '804856326d54d734f3b3212c16f6eef4ed73817278ad5262df1c40fc895feaca', NULL, NULL, NULL);
INSERT INTO public.content VALUES (52, 'ops/0/target', '{"by_entity_key":true,"created":true,"entity":"e_WXAAKENGDMG892R1XX11VYKR6W","intent":"update","table":"t2"}', '7850650b313ecaa9ecc93c71abc37da1571a18b349386cfaed2a863d939f4f24', NULL, NULL, NULL);
INSERT INTO public.content VALUES (52, 'ops/0/valid', '{"from":{"mode":"given","value":"2026-10-01"},"to":{"mode":"next_change"}}', '7273cec08b6fc076559e36a924c20ca07cbb746cfbe55c1528defa8ee63e7692', NULL, NULL, NULL);
INSERT INTO public.content VALUES (52, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (52, 'request_key', '{"key":"81a919af9767409553c63e13b5fcac68dc7583caa8e6ba67d899b087a1a1f54e"}', 'c77e823be8f698cb4c39008ce64b785851748c5bb76458944aa2418824c7e71e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (53, 'request', '{"entity_key":{"kind":"food"},"intent":"update","set":{"amount":5000},"table":"household.budgets","valid_from":"2026-10-01"}', 'e8c41a2624b6b6a263306b0402ba6c0950daa36a0e9f1dc65ef3082e621faa1e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (53, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_ZC19EXG3MMH98NJR"}', 'efe3041185af3d4fb7c47079fa9def8bf5a99433c257627eea3015f853a24e27', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'fields/f1/0', '{"status":"applied","value":"food"}', '3ce851fafc17dadf27fb8a73401c468b44acda2ff106fc54a0c477d259dd9fb7', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'fields/f2/0', '{"status":"applied","value":"5000"}', '0b0ab42381e2bb4d2859ec1864e72f7807787fd2bad4a716a2874538ba39f214', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'literal/f1/0', '{"segments":[{"result":"na","source":53}]}', 'b82e3ae156e1b50b66bf59d1eb89210ade76c884a0f4c0e8a77ece34fafe938a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'literal/f2/0', '{"segments":[{"result":"na","source":53}]}', 'b82e3ae156e1b50b66bf59d1eb89210ade76c884a0f4c0e8a77ece34fafe938a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'sources/f1/0', '[{"kind":"value","source":53}]', 'b863cc4850ac41d72e8c726892506c422beb9b9afad12203c31d774c5e150d73', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'sources/f2/0', '[{"kind":"value","source":53}]', 'b863cc4850ac41d72e8c726892506c422beb9b9afad12203c31d774c5e150d73', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'span/f1/0', '{"valid":{"from":"2026-10-01"}}', '80ba5cd58b91a2bf147edd7b90037d2a0c0f3aa70102ecbfa4458a539d352912', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'span/f2/0', '{"valid":{"from":"2026-10-01"}}', '80ba5cd58b91a2bf147edd7b90037d2a0c0f3aa70102ecbfa4458a539d352912', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'target', '{"cause":"request","created":true,"entity":"e_WXAAKENGDMG892R1XX11VYKR6W","intent":"update","op_index":0,"sv":1,"table":"t2"}', '53b9ca3540bdf2dbdb3a99b79d2fad4d76d078aaf52b5f2a8ef07bb88a7aa820', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'valid_sources', '[53]', '17673dea3b100a600846ee04777d0c0c2379258f5b5cb1757f7a36f4956a6c41', NULL, NULL, NULL);
INSERT INTO public.content VALUES (55, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-26T10:24:00.530Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', 'b0cb6df879176bcff1d213ff0cb7777492771828fba804ee17e535a07544edcb', NULL, NULL, NULL);
INSERT INTO public.content VALUES (55, 'ops/0/noop', '["f1"]', '6dbd1ae38d591a1d8818e127651ac0a0c7f78f1d180b0aa1aefb82008c3b0758', NULL, NULL, NULL);
INSERT INTO public.content VALUES (55, 'ops/0/set/f2', '"4000"', '91197d7b81dc27b9b94cf890932114c5ab712da496885ba5cc01ee4617bfaae0', NULL, NULL, NULL);
INSERT INTO public.content VALUES (55, 'ops/0/target', '{"by_entity_key":true,"entity":"e_WXAAKENGDMG892R1XX11VYKR6W","intent":"update","table":"t2","ver":{"basis":"fallback","current":true,"op":52,"restore_count":0}}', '2ba7f5dff7d45a0289c3fa9258e2595354b23cea9558354b25c213d8d868c9e0', NULL, NULL, NULL);
INSERT INTO public.content VALUES (55, 'ops/0/valid', '{"from":{"mode":"given","value":"2026-11-10"},"to":{"mode":"next_change"}}', '7c600349a954d222ff1f1271eaa0a9c540445c22d7e96a9a016d8d264664137a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (55, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (55, 'request_key', '{"key":"9a4704bafcecafa6e68847a8cbd33af5c2ea5729afa8399e5c5defa1b28ad2f9"}', 'e92517bec218d29057d9a9bf5205362caa777210e8081634aa3711f2352339f9', NULL, NULL, NULL);
INSERT INTO public.content VALUES (56, 'request', '{"entity_key":{"kind":"food"},"intent":"update","set":{"amount":4000},"table":"household.budgets","valid_from":"2026-11-10"}', '6de8c7b6772863dbbc50ebe46df7d75ea76e1602bc6d40942a71951ee91c85af', NULL, NULL, NULL);
INSERT INTO public.content VALUES (56, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_TP02MPHQ3S2JGCE2"}', '4a1660ab11e0f48ddc4ec7cef0328e28f2d46b6a6dee30dbe4e43e0a1ee5a033', NULL, NULL, NULL);
INSERT INTO public.content VALUES (57, 'fields/f2/0', '{"status":"applied","value":"4000"}', '8e23d82c7ddbe448c60657d8ef710ec0874d39aa72be68e930cab31f55ed2c3c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (57, 'literal/f2/0', '{"segments":[{"result":"na","source":56}]}', 'b903cb2ddcbb0e12413687f6058f52d2b871ebf7330699e026a4a5a316848009', NULL, NULL, NULL);
INSERT INTO public.content VALUES (57, 'sources/f2/0', '[{"kind":"value","source":56}]', '593e1a291dbc0675ec506bfa03f88dc9ca033e93fa172bb081c78882c74de2c0', NULL, NULL, NULL);
INSERT INTO public.content VALUES (57, 'span/f2/0', '{"valid":{"from":"2026-11-10"}}', '3b11f29fa3cdd8a4f4128418a46b42c472731a46787965a030d57bd4bc9016ee', NULL, NULL, NULL);
INSERT INTO public.content VALUES (57, 'target', '{"cause":"request","entity":"e_WXAAKENGDMG892R1XX11VYKR6W","intent":"update","op_index":0,"sv":1,"table":"t2"}', '6f96ef4db96808fa95e8a9f3b15bee09e9abc4f1d4a449a53c5178218a5df6dc', NULL, NULL, NULL);
INSERT INTO public.content VALUES (57, 'valid_sources', '[56]', '0494aeb56d68d0683dcdc2856752cd331cb1a9112b239e9a529519dbe29e3e63', NULL, NULL, NULL);
INSERT INTO public.content VALUES (58, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-26T10:24:00.537Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', 'b6df416f9913916980daa4cfc9dfe908c876e90b243f5e16629cd3b426d3c134', NULL, NULL, NULL);
INSERT INTO public.content VALUES (58, 'ops/0/noop', '["f1"]', '6dbd1ae38d591a1d8818e127651ac0a0c7f78f1d180b0aa1aefb82008c3b0758', NULL, NULL, NULL);
INSERT INTO public.content VALUES (58, 'ops/0/set/f2', '"4500"', 'bf1ac8b2c5a894f0bb4ebd1fb15ab12d2c6a92bd0fe856d165f96705ef3bd2f5', NULL, NULL, NULL);
INSERT INTO public.content VALUES (58, 'ops/0/target', '{"by_entity_key":true,"entity":"e_WXAAKENGDMG892R1XX11VYKR6W","intent":"update","table":"t2","ver":{"basis":"fallback","current":true,"op":55,"restore_count":0}}', '8721a2cdd73950c54e8eb83a7102787774994480b2750ef8b30cc84d19b33d89', NULL, NULL, NULL);
INSERT INTO public.content VALUES (58, 'ops/0/valid', '{"from":{"mode":"given","value":"2026-10-15"},"to":{"mode":"open"}}', '5d334a626a7551e0201ad822cbaca0e27e317959d36d6fdbcbf24f69dc964360', NULL, NULL, NULL);
INSERT INTO public.content VALUES (58, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (58, 'request_key', '{"key":"f50067c8f1d27b78631090519d5f0a10beaf593150530b4dd2f98b899d6d75c4"}', '2a82c5de901e66155288421a2bbf751533600951cee4232a576dc237ac7737b3', NULL, NULL, NULL);
INSERT INTO public.content VALUES (59, 'request', '{"entity_key":{"kind":"food"},"intent":"update","set":{"amount":4500},"table":"household.budgets","valid_from":"2026-10-15","valid_to":"open"}', 'c5d2dd03b95734ba4f02adf9455032dc2b9ed7da85f1b4e9b380424b0cadfa96', NULL, NULL, NULL);
INSERT INTO public.content VALUES (59, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_G5RBFAGDHBWA8XQC"}', 'cd769e216ee154874c8dcc462eb3c2b8227ab2186fdb9a7bb591bc3090e43018', NULL, NULL, NULL);
INSERT INTO public.content VALUES (60, 'fields/f2/0', '{"status":"awaiting","value":"4500"}', 'f288797fe8e450502df4528235299c293b805ae7d783357cf4b339617a2c52c6', NULL, NULL, NULL);
INSERT INTO public.content VALUES (60, 'literal/f2/0', '{"segments":[{"result":"na","source":59}]}', 'ef6f298ec294bf8b4ed2361ce3505c6bd7a185b4f16a066d5e0b80387b7f5db4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (60, 'sources/f2/0', '[{"kind":"value","source":59}]', 'ee85e2dc2bc2423f1d88a9ca67df8394e495c9665b1425dce963b25eff9c454d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (60, 'span/f2/0', '{"valid":{"from":"2026-10-15"}}', 'e6c0c70a14cb53d847c607a85603c051efee5a3734f0fb019615c85467cf1daf', NULL, NULL, NULL);
INSERT INTO public.content VALUES (60, 'target', '{"cause":"request","entity":"e_WXAAKENGDMG892R1XX11VYKR6W","intent":"update","op_index":0,"sv":1,"table":"t2"}', '6f96ef4db96808fa95e8a9f3b15bee09e9abc4f1d4a449a53c5178218a5df6dc', NULL, NULL, NULL);
INSERT INTO public.content VALUES (60, 'valid_sources', '[59]', '8f332db1356cb4786b468baab31bd75565bd751de9d984c92f9defbcc3ef172d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (67, 'ops/0/set/f3', '"12"', 'f9cacf3cb91a12e03bc4546834f95a50a4c5fe02276ac260148ea9296c442d39', NULL, NULL, NULL);
INSERT INTO public.content VALUES (61, 'current/0', '{"deps":[{"event":54,"field":"f2","k":0},{"event":57,"field":"f2","k":0},{"event":60,"field":"f2","k":0}],"field":"f2","op":52,"valid":{"from":"2026-10-15","to":"2026-11-10"},"value":"5000"}', '8073ae020c7890dea4e8000244d5f09095bed94efc3bbb260e09d99fccc843b9', NULL, NULL, NULL);
INSERT INTO public.content VALUES (61, 'current/1', '{"deps":[{"event":57,"field":"f2","k":0},{"event":60,"field":"f2","k":0}],"field":"f2","op":55,"valid":{"from":"2026-11-10"},"value":"4000"}', '12f8ff850df0f03ec83a43948411596d07d4044c5bc8f5519f8b066d63952ed7', NULL, NULL, NULL);
INSERT INTO public.content VALUES (61, 'impact/0', '{"deps":[{"event":54,"field":"f2","k":0},{"event":57,"field":"f2","k":0}],"field":"f2","kind":"overwritten_segment","op":52,"valid":{"from":"2026-10-15","to":"2026-11-10"},"value":"5000"}', '521fcc9f665137202a0ee51b79c5fe138d455d5d84ea89ce907809f9818960d3', NULL, NULL, NULL);
INSERT INTO public.content VALUES (61, 'impact/1', '{"deps":[{"event":57,"field":"f2","k":0}],"field":"f2","kind":"overwritten_segment","op":55,"valid":{"from":"2026-11-10"},"value":"4000"}', 'e2fe93e6bad541bd07dd7dc8b01c7c127aa53b6706e4e1e6302bdb61f0cf1afd', NULL, NULL, NULL);
INSERT INTO public.content VALUES (61, 'proposed/0', '{"deps":[{"event":60,"field":"f2","k":0}],"field":"f2","valid":{"from":"2026-10-15"},"value":"4500"}', 'f6faa8aff2ad990c5fd52f61ef4b8d9cdf80e7d8aac5f2ffc3f249a0100f640e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (61, 'scope_valid', '{"deps":[{"event":60,"field":"f2","k":0}],"spans":[{"from":"2026-10-15"}]}', 'f698a8f359bb795e6eecf79a199215ba88cfb1957109b0749c970a193722b048', NULL, NULL, NULL);
INSERT INTO public.content VALUES (61, 'target', '{"entity":"e_WXAAKENGDMG892R1XX11VYKR6W","item":"pi_8E6VV4JE0NQWXEC3","origin_event":60,"policy_version":1,"reason":"overwrites_change_point","ruleset_version":1,"table":"t2","type":"awaiting_confirmation","unit":["f2"]}', 'a6a8bbb35435cddef7b54e8b070fb593a03e1ac6ab65b2cd14c19e0a035fe095', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-26T10:24:00.545Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', 'abbf50b10566b317841e3d116465d98dabe9b29de48ab4965c16c71c85536bf5', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ops/0/set/f1', '"app"', '4e5ef144c51cd25230c144c3e1d8e842b9860b7a3cec2699d4e24e6517fc4b20', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ops/0/set/f2', '"k-1"', 'f613e2ddb1ed1aefc2d87a1bc773c3a3e671f40809ffe8875486d58482e5259a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ops/0/set/f3', '"10"', '536549599ec6c3b859cd3970025779a13d061783c73e663fea7f963e98379aa8', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ops/0/target', '{"by_external_key":true,"created":true,"intent":"update","row":"r_ZXQQZBZTZKVMZF3DR72Y0WPERW","table":"t3"}', '6c7cdb04ee7851ed2145e6feb044f29bb5eb61ab72504464c7b92fa71ebfaebf', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ops/1/set/f1', '"app"', '4e5ef144c51cd25230c144c3e1d8e842b9860b7a3cec2699d4e24e6517fc4b20', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ops/1/set/f2', '"k-2"', '242ae761454b02109f6b54c9077c298d68e7e96cf0087859efa80e54073f77aa', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ops/1/set/f3', '"21"', '6f8f349216adc47cfd723001f3dfbfc11179e1b36c31ce51c85056026f3d85b9', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ops/1/target', '{"by_external_key":true,"created":true,"intent":"update","row":"r_VN6ZHQ4XDW34A24P9YSQYPQ5S4","table":"t3"}', '39304da17c6de2ed4071890830574345a7b8766ab344a7af5fdc57aede471280', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'request', '{"op_count":2,"sv":1,"sv_basis":"explicit"}', 'e0cec6f32835f484f2a07b4776a1164f5e0b3d4ad918e86e9d189d29fce17780', NULL, NULL, NULL);
INSERT INTO public.content VALUES (63, 'request', '{"external_key":{"external_id":"k-1","origin":"app"},"intent":"update","set":{"fare":10},"table":"household.rides"}', '602bd852c41aaef9948bac4e79a237bad5b2c4ee7f721a2a8e6d4f5b741c490b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (63, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_7R30BHCGWE1N0PH6"}', '035745718e138bfa367ee9c22b2462256245cbd519e206af9c47b08580f3da6c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (64, 'request', '{"external_key":{"external_id":"k-2","origin":"app"},"intent":"update","set":{"fare":21},"table":"household.rides"}', '9070f120653e01cb1fdfa2c01ae8d9c0a844e997d9435b4f4ef900dd4ab4476f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (64, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":1,"source_id":"s_4V1ZBDMSRRE6408R"}', 'bafdca227b521c75e99648d691a10bbb9451535341fe3ff935ea10a3fc7677dc', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'fields/f1/0', '{"status":"applied","value":"app"}', 'c0f87af78708bddb29d36c257c2d3a389a9a16d6077ecd1f72132e2c36458a46', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'fields/f2/0', '{"status":"applied","value":"k-1"}', 'f1b5335622ffbf0c57f3cb8d1242f129d57eec003bddfd855a7ed1c5a204a1ca', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'fields/f3/0', '{"status":"applied","value":"10"}', 'c5d6a3109242c147dbe9c262ab4ffa606fdb23aeab545dcd9f6edd4229e4746d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'literal/f1/0', '{"segments":[{"result":"na","source":63}]}', 'e0841b0f39d829865177ccca851114fb9e7a5f13ced5e90f3d3327678303633a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'literal/f2/0', '{"segments":[{"result":"na","source":63}]}', 'e0841b0f39d829865177ccca851114fb9e7a5f13ced5e90f3d3327678303633a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'literal/f3/0', '{"segments":[{"result":"na","source":63}]}', 'e0841b0f39d829865177ccca851114fb9e7a5f13ced5e90f3d3327678303633a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'sources/f1/0', '[{"kind":"value","source":63}]', 'b3dcee24b53b92ebf82de486dc7e1f5721207475796e39f5ccf7c765c022c434', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'sources/f2/0', '[{"kind":"value","source":63}]', 'b3dcee24b53b92ebf82de486dc7e1f5721207475796e39f5ccf7c765c022c434', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'sources/f3/0', '[{"kind":"value","source":63}]', 'b3dcee24b53b92ebf82de486dc7e1f5721207475796e39f5ccf7c765c022c434', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'target', '{"cause":"request","created":true,"intent":"update","op_index":0,"row":"r_ZXQQZBZTZKVMZF3DR72Y0WPERW","sv":1,"table":"t3"}', '04889c85ebbe6ffe19e4fb469135ad7e9118b26d40cc9cc4c4fc66171e5d0c4f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'fields/f1/0', '{"status":"applied","value":"app"}', 'c0f87af78708bddb29d36c257c2d3a389a9a16d6077ecd1f72132e2c36458a46', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'fields/f2/0', '{"status":"applied","value":"k-2"}', 'a00fb3f1544a5603c809d0f2c45478c13646761f47ee0ae70eceacfc5973e616', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'fields/f3/0', '{"status":"applied","value":"21"}', 'db2af3002b6b171e6a8ddf6ac2b6b0d0afbeaa88d898be80c8493e77e97a47fd', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'literal/f1/0', '{"segments":[{"result":"na","source":64}]}', '33c84a6f0c71d09e6d7804f71b7e8a38bbd3ff78740063cb982ad2858f322260', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'literal/f2/0', '{"segments":[{"result":"na","source":64}]}', '33c84a6f0c71d09e6d7804f71b7e8a38bbd3ff78740063cb982ad2858f322260', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'literal/f3/0', '{"segments":[{"result":"na","source":64}]}', '33c84a6f0c71d09e6d7804f71b7e8a38bbd3ff78740063cb982ad2858f322260', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'sources/f1/0', '[{"kind":"value","source":64}]', '58b096f741dec54695b0d08a032222f771639c9bcb2dd1fa941aa16fd6baade4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'sources/f2/0', '[{"kind":"value","source":64}]', '58b096f741dec54695b0d08a032222f771639c9bcb2dd1fa941aa16fd6baade4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'sources/f3/0', '[{"kind":"value","source":64}]', '58b096f741dec54695b0d08a032222f771639c9bcb2dd1fa941aa16fd6baade4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'target', '{"cause":"request","created":true,"intent":"update","op_index":1,"row":"r_VN6ZHQ4XDW34A24P9YSQYPQ5S4","sv":1,"table":"t3"}', '0fa9ae7b5cabd1c53feccda7fdd1c850b02bd5bac9213d1b78d0eb11636d03a2', NULL, NULL, NULL);
INSERT INTO public.content VALUES (67, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-26T10:24:00.552Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', 'bad22e2856704ccde7d9d49902f8cd8b7f04ea3490a5bd3e99ba96f28233f930', NULL, NULL, NULL);
INSERT INTO public.content VALUES (67, 'ops/0/baseline', '{"f3":62}', '850f6f2f9e33426a9e5b1b478f780ef8e999f86ad52151a509a7c4f9f7864a44', NULL, NULL, NULL);
INSERT INTO public.content VALUES (67, 'ops/0/noop', '["f1","f2"]', '8fd6f2004d3e89f6c04b595c49979ed48da7f355575a31f9ae6a2456b6c9bca4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (67, 'ops/0/target', '{"by_external_key":true,"intent":"update","row":"r_ZXQQZBZTZKVMZF3DR72Y0WPERW","table":"t3","ver":{"basis":"external_key","op":62,"restore_count":0}}', '1e57af9c9cbebf844f893e3b6dfbb5e58e5591c5f6a00850168afaef8ce172a0', NULL, NULL, NULL);
INSERT INTO public.content VALUES (67, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (68, 'request', '{"external_key":{"external_id":"k-1","origin":"app"},"intent":"update","set":{"fare":12},"table":"household.rides"}', '78ff3623de3e1aca1b75daff2eecf8abd849fec8d2acd8cfd01d39fd79dd241c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (68, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_K993NMNJKQJ73GEM"}', 'ed4dace9dc5786615c0c4cbc0f080513e9d43b0043b90848fbfe2e077e3d7734', NULL, NULL, NULL);
INSERT INTO public.content VALUES (69, 'fields/f3/0', '{"status":"applied","value":"12"}', 'ea590704ad6cb667a1c44e5aee91b061a120ea192f3fb3d6c64f11c2ca83fcf8', NULL, NULL, NULL);
INSERT INTO public.content VALUES (69, 'literal/f3/0', '{"segments":[{"result":"na","source":68}]}', 'a85b1c503221104998ddbd9e272a8efe5e7fe98227785680540222545cd02ac0', NULL, NULL, NULL);
INSERT INTO public.content VALUES (69, 'sources/f3/0', '[{"kind":"value","source":68}]', '29d246f835e24bc3a7360376a47f538836990cd62f470717347de67553d26ef6', NULL, NULL, NULL);
INSERT INTO public.content VALUES (69, 'target', '{"cause":"request","intent":"update","op_index":0,"row":"r_ZXQQZBZTZKVMZF3DR72Y0WPERW","sv":1,"table":"t3"}', 'dbe6d571f92a79a063af9980e6c8141df3dd0fbe9a4f7978e77e4941c7543bb3', NULL, NULL, NULL);
INSERT INTO public.content VALUES (70, 'ctx', '{"now":"2026-11-26T10:24:00.574Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', '90b18a8d50141e751f0b3f9965e80c3788f6882109917d7d97ca2d4737f14cd3', NULL, NULL, NULL);
INSERT INTO public.content VALUES (70, 'draft', '{"base_version":1,"drop_tables":["rides"],"slot":"household","tables":[{"description":"one row per expense","duplicate_keys":[["date","note"]],"fields":[{"description":"the day","id":"f1","name":"date","required":true,"type":"date"},{"description":"how much, in yuan","id":"f2","name":"amount","type":"integer"},{"description":"what for","id":"f3","name":"note","type":"text"}],"id":"t1","kind":"base","name":"expenses","time":{"field":"date","type":"event"}}],"timezone":"Asia/Shanghai"}', '404066f1af66ec959a80f487f737bc56457ba04af40f9916346fbf691ea553cc', NULL, NULL, NULL);
INSERT INTO public.content VALUES (70, 'request_key', '{"key":"8ac4697d2eaaa1a2bf5f6639d280b41aba7a5a5f664cebefabf05b7d89b23774"}', '3326959c97d02c3fe5a9621a4ebb86b3ea1f509a69572db221a1a47c0063ae39', NULL, NULL, NULL);
INSERT INTO public.content VALUES (70, 'target', '{"base_version":1,"creates_slot":false,"draft_id":"d_DM4HXY997BWG7RRM"}', '17aa075631a3b6c182dbd35d74dd981c4c92e71899470ba42334f2efad923252', NULL, NULL, NULL);
INSERT INTO public.content VALUES (71, 'changes', '[{"auto":true,"change":"change_duplicate_keys","class":"metadata","compatible_with_old_writes":true,"destructive":false,"target":{"table":"t1"}},{"auto":false,"change":"drop_table","class":"metadata","compatible_with_old_writes":false,"destructive":true,"target":{"table":"t3"}}]', '39d231cfbce20ede4cf84a446c16daff6957092c68fec8a68511996bd78094ac', NULL, NULL, NULL);
INSERT INTO public.content VALUES (71, 'compiled', '{"compiler":1,"name":"household","rsql":"rsql@1","slot":"sl_GNTW5THHHYPF6432","sv":2,"tables":[{"description":"one row per expense","duplicate_keys":[["f1","f3"]],"fields":[{"description":"the day","id":"f1","name":"date","required":true,"type":"date"},{"description":"how much, in yuan","id":"f2","name":"amount","type":"integer"},{"description":"what for","id":"f3","name":"note","type":"text"}],"id":"t1","kind":"base","name":"expenses","physical":{"since":1,"table":"t_t1_v1"},"time":{"field":"f1","type":"event"}},{"description":"a monthly budget by kind","entity_key":["f1"],"fields":[{"description":"what the budget is for","id":"f1","name":"kind","required":true,"type":"text"},{"description":"the budget, in yuan","id":"f2","name":"amount","required":true,"type":"integer"}],"id":"t2","kind":"base","name":"budgets","physical":{"since":1,"table":"t_t2_v1"},"time":{"granularity":"date","type":"state"}},{"description":"one row per refund of an expense","fields":[{"description":"why","id":"f1","name":"note","required":true,"type":"text"},{"description":"the expense refunded","id":"f2","name":"expense","ref":{"table":"t1","target":"row"},"type":"ref"}],"id":"t4","kind":"base","name":"refunds","physical":{"since":1,"table":"t_t4_v1"},"time":{"type":"none"}},{"description":"what was spent each day","fields":[{"description":"the day","id":"f1","name":"day","type":"date"},{"description":"the sum","id":"f2","name":"total","type":"integer"},{"description":"how many","id":"f3","name":"n","type":"integer"}],"id":"t5","kind":"derived","name":"spent_by_day","physical":{"since":1,"table":"d_t5_v1"},"rule":{"depends_on":[{"field":"f1","table":"t1"},{"field":"f2","table":"t1"}],"id":"r1","rsql":"rsql@1","scope":{"key":["f1"],"key_from_free_text":false,"kind":"group"},"sql":"SELECT \"t1\".\"f1\" AS \"f1\", CAST(sum(\"t1\".\"f2\") AS bigint) AS \"f2\", count(*) AS \"f3\" FROM \"t1\" GROUP BY 1","time_dependency":"bucketed","version":1}}],"timezone":"Asia/Shanghai"}', 'f28286bdb52bde2dd68cd438edce2340445fefe2ca7ea42bfb09cb834fd173ee', NULL, NULL, NULL);
INSERT INTO public.content VALUES (71, 'target', '{"draft_id":"d_DM4HXY997BWG7RRM","outcome":"pending","target_version":2}', 'f025a13ea52505d707cee2406f6978057ea395cea3f7eaf1f8c6141b2298f960', NULL, NULL, NULL);
INSERT INTO public.content VALUES (72, 'target', '{"draft":"d_DM4HXY997BWG7RRM","item":"pi_YYGGWCXTQ5EVJ773","policy_version":1,"reason":"schema_change","ruleset_version":1,"type":"schema_change"}', 'cc207f8e0418552ad99f98f1e51d679e44ff5640c9f6ea1880927e63bc12c043', NULL, NULL, NULL);
INSERT INTO public.content VALUES (73, 'confirmation', '{"hash":"93db360ea5da113fdf456e481150c5e710bc69646db271b027a6dbcebcd0ee5b"}', '3e9bd1d126d25a0573f9d835561a6b42b01bcd22047bffbf4854becaf0b8c02c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (73, 'ctx', '{"now":"2026-11-26T10:24:00.580Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', '190ab341007fe2e53fb10a189bfdcc2aba84f313bf20261e89aed9d6df1c090f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (73, 'request_key', '{"key":"8437bf30160a2976c527a8bb9d060239f2857a346cd65c84865f74aa7e37e84d"}', 'af8ac759e843dbc02e348a47cdb17e63a496318ea56d33d0db4914e0f326ade9', NULL, NULL, NULL);
INSERT INTO public.content VALUES (73, 'target', '{"decision":"confirm","item":"pi_YYGGWCXTQ5EVJ773","item_op":70,"restore_count":0,"via":"call"}', '902deff24f5fe19a1dd8167eb44ae8432bd8649bbf845aeace506ad88e050394', NULL, NULL, NULL);
INSERT INTO public.content VALUES (74, 'target', '{"by":"resolve","draft_id":"d_DM4HXY997BWG7RRM","target_version":2}', '2ca7ab9d97e16a4cf24afaa7ecf442feee2f9c0cc150fc29437c75821f12a759', NULL, NULL, NULL);
INSERT INTO public.content VALUES (75, 'target', '{"draft_id":"d_DM4HXY997BWG7RRM","from_version":1,"rebuilt_tables":[],"to_version":2}', '930016606988bd99f331f38b5be1b386aac992477f42c566f8d121edb379d24e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (76, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-26T10:24:00.589Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', '2323d3c7b645a69fd8588d6cc2d0e7e0b65a0ed0f27f132fbd0af97dcaaca81e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (76, 'ops/0/set/f1', '"2026-11-02"', 'bb1de3879fc3904da5b8b20834d8d58eac44c618f8305a7357557ae506daf77f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (76, 'ops/0/set/f2', '"54"', '6ce1ced1ac1f56f8cd7ee5c55d117fe99c805b89a603e36c41852fea49853068', NULL, NULL, NULL);
INSERT INTO public.content VALUES (76, 'ops/0/set/f3', '"lunch"', '861315d6dc2fae3332121172cefb27dbbc4f45d0422d6c7a700e861baadf4f8d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (76, 'ops/0/target', '{"created":true,"intent":"insert","row":"r_X075V18D1AMV40A8CPGWMCGCVT","table":"t1"}', '18f1c913b44399cfef2f150ec4920d7be983b8fed09d59ae4ad0b3c6e35caa41', NULL, NULL, NULL);
INSERT INTO public.content VALUES (76, 'request', '{"op_count":1,"sv":2,"sv_basis":"explicit"}', 'a74c20685730197cad3bdf00d44171528e34875666d0088bb413439168684720', NULL, NULL, NULL);
INSERT INTO public.content VALUES (76, 'request_key', '{"key":"68d490fcfcd7a373cb7be1dcb3e038ae57484c580665aac5220b1001bc0634ef"}', '444f46d7ced6cd0384990bd5d38121473b7f9f733940b30a56bf65a3135f5404', NULL, NULL, NULL);
INSERT INTO public.content VALUES (77, 'request', '{"intent":"insert","set":{"amount":54,"date":"2026-11-02","note":"lunch"},"table":"household.expenses"}', '64abd79da09e7c9d152c42454e0bd41e06d67e29df69c6799ab66549d01ac863', NULL, NULL, NULL);
INSERT INTO public.content VALUES (77, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_84M2Z7R71EXNBJ1W"}', 'd6d1c06c727d18fe9166d3bfad074dbc6667a773517b85dbf628562b810039cd', NULL, NULL, NULL);
INSERT INTO public.content VALUES (78, 'duplicate', '{"deps":[{"event":11,"field":"f1","k":0},{"event":11,"field":"f3","k":0}],"keys":["f1","f3"],"matched":["r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC"]}', '828b876bb8c4fc505d59610e309e3d0ae2b86ac60bea8935c4d4fb581e01e493', NULL, NULL, NULL);
INSERT INTO public.content VALUES (78, 'fields/f1/0', '{"status":"applied","value":"2026-11-02"}', '96a119bb0a7bc53bfaa2b66ba49a944c8959ef63f8218c5af954c7f093c803a2', NULL, NULL, NULL);
INSERT INTO public.content VALUES (78, 'fields/f2/0', '{"status":"applied","value":"54"}', '3066d5922eca1709cab4c55d047596dc085c9289eb0e69902f10bdafc414ee89', NULL, NULL, NULL);
INSERT INTO public.content VALUES (78, 'fields/f3/0', '{"status":"applied","value":"lunch"}', 'a8db5f8cb5beb8cfabf3f12f93582fbff4f01c4d1eb78418794404af42f5b882', NULL, NULL, NULL);
INSERT INTO public.content VALUES (78, 'literal/f1/0', '{"segments":[{"result":"na","source":77}]}', '81e888daa6120c79b25f27fc5d8c481793d02789d0971c34a13d47155c5ff199', NULL, NULL, NULL);
INSERT INTO public.content VALUES (78, 'literal/f2/0', '{"segments":[{"result":"na","source":77}]}', '81e888daa6120c79b25f27fc5d8c481793d02789d0971c34a13d47155c5ff199', NULL, NULL, NULL);
INSERT INTO public.content VALUES (78, 'literal/f3/0', '{"segments":[{"result":"na","source":77}]}', '81e888daa6120c79b25f27fc5d8c481793d02789d0971c34a13d47155c5ff199', NULL, NULL, NULL);
INSERT INTO public.content VALUES (78, 'sources/f1/0', '[{"kind":"value","source":77}]', '22850f5523ca85c02320c00c5c5fe4e8fad64a89e93440d63dc8c883897241cf', NULL, NULL, NULL);
INSERT INTO public.content VALUES (78, 'sources/f2/0', '[{"kind":"value","source":77}]', '22850f5523ca85c02320c00c5c5fe4e8fad64a89e93440d63dc8c883897241cf', NULL, NULL, NULL);
INSERT INTO public.content VALUES (78, 'sources/f3/0', '[{"kind":"value","source":77}]', '22850f5523ca85c02320c00c5c5fe4e8fad64a89e93440d63dc8c883897241cf', NULL, NULL, NULL);
INSERT INTO public.content VALUES (78, 'target', '{"cause":"request","created":true,"intent":"insert","op_index":0,"row":"r_X075V18D1AMV40A8CPGWMCGCVT","sv":2,"table":"t1"}', '039dca2af8737e5e87d17de9a4b9e510f39476d24b8ceb351cd76a4d9cf22427', NULL, NULL, NULL);
INSERT INTO public.content VALUES (79, 'matched/0', '{"deps":[{"event":11,"field":"f1","k":0},{"event":11,"field":"f3","k":0}],"row":"r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC"}', '76de0553ad1c50792349c255d6497baed9ea013b800088251b147bff0d4f3bfd', NULL, NULL, NULL);
INSERT INTO public.content VALUES (79, 'target', '{"item":"pi_Y6E8WZM8RS817HH2","origin_event":78,"policy_version":1,"reason":"duplicate_keys","row":"r_X075V18D1AMV40A8CPGWMCGCVT","ruleset_version":1,"table":"t1","type":"flagged"}', 'dc337376bce7e313c7aa600e70334fa57f6991f190563edf908fa5a7bc2a10fa', NULL, NULL, NULL);
INSERT INTO public.content VALUES (80, 'checksum', '{"checksum":"de432ee0c24bcd914a70fefa7457ec86c06af752003ca5879b13c44543fbe0b6"}', '5adbe56a288cf0004001e455cd5ccc221f0eb732919443c0cb8a513d71836a66', NULL, NULL, NULL);
INSERT INTO public.content VALUES (80, 'target', '{"emptied":false,"partition":"p_9H3HPRDHCKXPZR6K","read_pos":79,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', '61db5a1837307b50ee0ab47d6f4e8515d212d5b7c46d5bc2baeadfb1f0bd4926', NULL, NULL, NULL);


--
-- Data for Name: counts; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.counts VALUES ('t4', '', 1);
INSERT INTO public.counts VALUES ('t2', '', 2);
INSERT INTO public.counts VALUES ('t3', '', 2);
INSERT INTO public.counts VALUES ('t1', '', 4);


--
-- Data for Name: d_t5_v1; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.d_t5_v1 VALUES ('p_CB2PNKC8BDR84JE8', '2026-11-04', 9, 1, 37);
INSERT INTO public.d_t5_v1 VALUES ('p_9H3HPRDHCKXPZR6K', '2026-11-02', 140, 3, 76);


--
-- Data for Name: deletions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: derived_reads; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.derived_reads VALUES (12, 't1', 'p_9H3HPRDHCKXPZR6K', 1, 11);
INSERT INTO public.derived_reads VALUES (16, 't1', 'p_9H3HPRDHCKXPZR6K', 1, 15);
INSERT INTO public.derived_reads VALUES (20, 't1', 'p_756ESA1YTGYB3EK2', 1, 19);
INSERT INTO public.derived_reads VALUES (24, 't1', 'p_9H3HPRDHCKXPZR6K', 1, 23);
INSERT INTO public.derived_reads VALUES (28, 't1', 'p_756ESA1YTGYB3EK2', 1, 27);
INSERT INTO public.derived_reads VALUES (32, 't1', 'p_CB2PNKC8BDR84JE8', 1, 31);
INSERT INTO public.derived_reads VALUES (36, 't1', 'p_CB2PNKC8BDR84JE8', 1, 35);
INSERT INTO public.derived_reads VALUES (40, 't1', 'p_CB2PNKC8BDR84JE8', 1, 39);
INSERT INTO public.derived_reads VALUES (44, 't1', 'p_9H3HPRDHCKXPZR6K', 1, 43);
INSERT INTO public.derived_reads VALUES (80, 't1', 'p_9H3HPRDHCKXPZR6K', 1, 79);


--
-- Data for Name: events; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.events VALUES (1, '{"actor":"u_9Y4XEYT01A0BX9R0VEPPKGZD2Q","at":"2026-11-26T10:24:00.178Z","node_id":"n_51191K0V5W9PV02H11XSW4JAEM","prev_hash":"0000000000000000000000000000000000000000000000000000000000000000","seq":1,"type":"tenant.genesis","v":1}', 'e6636119a0ffe0c8f3448ddb92ebb1c211c7be486cfa0aba3140ff3ea20d1de8', 'tenant.genesis', 'u_9Y4XEYT01A0BX9R0VEPPKGZD2Q', '2026-11-26T10:24:00.178Z', 1, NULL, NULL, NULL, NULL);
INSERT INTO public.events VALUES (2, '{"actor":"u_9Y4XEYT01A0BX9R0VEPPKGZD2Q","at":"2026-11-26T10:24:00.367Z","prev_hash":"e6636119a0ffe0c8f3448ddb92ebb1c211c7be486cfa0aba3140ff3ea20d1de8","seq":2,"slot":"sl_GNTW5THHHYPF6432","type":"schema.draft_submitted","v":1}', 'de6e8dc2056fd15c1a1580c8dc25898a3c8e06f12f44f4b9a0bdda515a332b48', 'schema.draft_submitted', 'u_9Y4XEYT01A0BX9R0VEPPKGZD2Q', '2026-11-26T10:24:00.367Z', 2, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (3, '{"actor":"u_9Y4XEYT01A0BX9R0VEPPKGZD2Q","at":"2026-11-26T10:24:00.367Z","op":2,"prev_hash":"de6e8dc2056fd15c1a1580c8dc25898a3c8e06f12f44f4b9a0bdda515a332b48","seq":3,"slot":"sl_GNTW5THHHYPF6432","type":"schema.compiled","v":1}', '39d8533cf61a2bf67674d5b019e221d0593c48fdbe7bca87359c8ee831e98c99', 'schema.compiled', 'u_9Y4XEYT01A0BX9R0VEPPKGZD2Q', '2026-11-26T10:24:00.367Z', 2, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (4, '{"actor":"u_9Y4XEYT01A0BX9R0VEPPKGZD2Q","at":"2026-11-26T10:24:00.367Z","op":2,"prev_hash":"39d8533cf61a2bf67674d5b019e221d0593c48fdbe7bca87359c8ee831e98c99","seq":4,"slot":"sl_GNTW5THHHYPF6432","type":"schema.confirmed","v":1}', 'ebf91bcfdd2c5fa95700f31b2477295190d9e81fda14e199a4292c1f388f3a3b', 'schema.confirmed', 'u_9Y4XEYT01A0BX9R0VEPPKGZD2Q', '2026-11-26T10:24:00.367Z', 2, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (5, '{"actor":"u_9Y4XEYT01A0BX9R0VEPPKGZD2Q","at":"2026-11-26T10:24:00.367Z","op":2,"prev_hash":"ebf91bcfdd2c5fa95700f31b2477295190d9e81fda14e199a4292c1f388f3a3b","seq":5,"slot":"sl_GNTW5THHHYPF6432","type":"slot.policy_set","v":1}', '77cb200f836ece1af66d010de02a2c931571fcbbe088f1a24e2d4bf2cdd84354', 'slot.policy_set', 'u_9Y4XEYT01A0BX9R0VEPPKGZD2Q', '2026-11-26T10:24:00.367Z', 2, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (6, '{"actor":"u_9Y4XEYT01A0BX9R0VEPPKGZD2Q","at":"2026-11-26T10:24:00.367Z","op":2,"prev_hash":"77cb200f836ece1af66d010de02a2c931571fcbbe088f1a24e2d4bf2cdd84354","seq":6,"slot":"sl_GNTW5THHHYPF6432","type":"schema.switched","v":1}', '02de00d353a0240f5d712896d8df3e0568ac4f37d699992b141578c22de02f73', 'schema.switched', 'u_9Y4XEYT01A0BX9R0VEPPKGZD2Q', '2026-11-26T10:24:00.367Z', 2, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (7, '{"actor":"u_9Y4XEYT01A0BX9R0VEPPKGZD2Q","at":"2026-11-26T10:24:00.409Z","prev_hash":"02de00d353a0240f5d712896d8df3e0568ac4f37d699992b141578c22de02f73","seq":7,"type":"principal.registered","v":1}', 'b06a8bd64fd27376f81ccf8eef41e8bb27a0ac417a800891469cb1116fecd8b1', 'principal.registered', 'u_9Y4XEYT01A0BX9R0VEPPKGZD2Q', '2026-11-26T10:24:00.409Z', 7, NULL, NULL, NULL, NULL);
INSERT INTO public.events VALUES (8, '{"actor":"u_9Y4XEYT01A0BX9R0VEPPKGZD2Q","at":"2026-11-26T10:24:00.412Z","prev_hash":"b06a8bd64fd27376f81ccf8eef41e8bb27a0ac417a800891469cb1116fecd8b1","seq":8,"type":"principal.registered","v":1}', 'b3aa532ffc18ff1cd09a7597a12a64ae36ec47a206a859a5ed140de4b3c8efc7', 'principal.registered', 'u_9Y4XEYT01A0BX9R0VEPPKGZD2Q', '2026-11-26T10:24:00.412Z', 8, NULL, NULL, NULL, NULL);
INSERT INTO public.events VALUES (9, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.415Z","prev_hash":"b3aa532ffc18ff1cd09a7597a12a64ae36ec47a206a859a5ed140de4b3c8efc7","seq":9,"slot":"sl_GNTW5THHHYPF6432","type":"write.head","v":1}', '0535444e8a02ea5325df56d020e2b004cddf384a73f67c60098d3002ba62b494', 'write.head', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.415Z', 9, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (10, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.415Z","op":9,"prev_hash":"0535444e8a02ea5325df56d020e2b004cddf384a73f67c60098d3002ba62b494","seq":10,"slot":"sl_GNTW5THHHYPF6432","type":"source.recorded","v":1}', 'c940bf4cdb3f57002405e918eca45f48cb748b4302035709d57423fd8466df4a', 'source.recorded', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.415Z', 9, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (11, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.415Z","op":9,"prev_hash":"c940bf4cdb3f57002405e918eca45f48cb748b4302035709d57423fd8466df4a","seq":11,"slot":"sl_GNTW5THHHYPF6432","type":"write.base","v":1}', '3c99b904acc348357baac2e1818de359bd36a5c3c6db0f26e31deb67044a01e7', 'write.base', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.415Z', 9, 'sl_GNTW5THHHYPF6432', 't1', 'r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC', NULL);
INSERT INTO public.events VALUES (12, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.415Z","op":9,"prev_hash":"3c99b904acc348357baac2e1818de359bd36a5c3c6db0f26e31deb67044a01e7","seq":12,"slot":"sl_GNTW5THHHYPF6432","type":"write.derived","v":1}', '9fec502193e36607f4724502a8c80b97e547c4c4d4205babe8d2a8536ac325bc', 'write.derived', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.415Z', 9, 'sl_GNTW5THHHYPF6432', 't5', NULL, NULL);
INSERT INTO public.events VALUES (13, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.437Z","prev_hash":"9fec502193e36607f4724502a8c80b97e547c4c4d4205babe8d2a8536ac325bc","seq":13,"slot":"sl_GNTW5THHHYPF6432","type":"write.head","v":1}', 'f5492ed46fada0ecd425b4660aac80bbe691f63ab5d057dedeca109b223cbbb9', 'write.head', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.437Z', 13, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (14, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.437Z","op":13,"prev_hash":"f5492ed46fada0ecd425b4660aac80bbe691f63ab5d057dedeca109b223cbbb9","seq":14,"slot":"sl_GNTW5THHHYPF6432","type":"source.recorded","v":1}', '11fb683965cc0400bc60169724a700c04661e50b19966889c322f7255777d254', 'source.recorded', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.437Z', 13, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (15, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.437Z","op":13,"prev_hash":"11fb683965cc0400bc60169724a700c04661e50b19966889c322f7255777d254","seq":15,"slot":"sl_GNTW5THHHYPF6432","type":"write.base","v":1}', 'c7335c88508416c7f544c4cf8c18784eed54f70b9cb281a85fa820a14bf99a5b', 'write.base', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.437Z', 13, 'sl_GNTW5THHHYPF6432', 't1', 'r_T226J69Z95XDYC8Q9B84CZEQ0A', NULL);
INSERT INTO public.events VALUES (16, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.437Z","op":13,"prev_hash":"c7335c88508416c7f544c4cf8c18784eed54f70b9cb281a85fa820a14bf99a5b","seq":16,"slot":"sl_GNTW5THHHYPF6432","type":"write.derived","v":1}', '6e5d555fb9ffb93593fcfea9d2ba55ed94c54e02065244d379a463e5e97aa71c', 'write.derived', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.437Z', 13, 'sl_GNTW5THHHYPF6432', 't5', NULL, NULL);
INSERT INTO public.events VALUES (17, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.446Z","prev_hash":"6e5d555fb9ffb93593fcfea9d2ba55ed94c54e02065244d379a463e5e97aa71c","seq":17,"slot":"sl_GNTW5THHHYPF6432","type":"write.head","v":1}', '5e30e7b4855c795badd09ee182f92f9bd8e7fbe9e75b1ff00635752af8633937', 'write.head', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.446Z', 17, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (18, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.446Z","op":17,"prev_hash":"5e30e7b4855c795badd09ee182f92f9bd8e7fbe9e75b1ff00635752af8633937","seq":18,"slot":"sl_GNTW5THHHYPF6432","type":"source.recorded","v":1}', 'f32dc56bbf900c1571ad20c022f3981acf8ed21533ce70b3daf15026a56e45c8', 'source.recorded', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.446Z', 17, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (19, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.446Z","op":17,"prev_hash":"f32dc56bbf900c1571ad20c022f3981acf8ed21533ce70b3daf15026a56e45c8","seq":19,"slot":"sl_GNTW5THHHYPF6432","type":"write.base","v":1}', 'ea3f27c77bc16fb3a46313ed1d278769bd31fc669cb8b84cddef037e4ba22608', 'write.base', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.446Z', 17, 'sl_GNTW5THHHYPF6432', 't1', 'r_15D0YYA6VPYZ1XG6404XSGF9P0', NULL);
INSERT INTO public.events VALUES (20, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.446Z","op":17,"prev_hash":"ea3f27c77bc16fb3a46313ed1d278769bd31fc669cb8b84cddef037e4ba22608","seq":20,"slot":"sl_GNTW5THHHYPF6432","type":"write.derived","v":1}', '882e4b59ea7b88b0d8a1c4800d8b396f53d8c476ea16995de2f36cadb33ec9c3', 'write.derived', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.446Z', 17, 'sl_GNTW5THHHYPF6432', 't5', NULL, NULL);
INSERT INTO public.events VALUES (21, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.455Z","prev_hash":"882e4b59ea7b88b0d8a1c4800d8b396f53d8c476ea16995de2f36cadb33ec9c3","seq":21,"slot":"sl_GNTW5THHHYPF6432","type":"write.head","v":1}', '8480604ce1148798da955b93af64d86d921484d2094cf050b8e9210ca3be97ce', 'write.head', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.455Z', 21, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (22, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.455Z","op":21,"prev_hash":"8480604ce1148798da955b93af64d86d921484d2094cf050b8e9210ca3be97ce","seq":22,"slot":"sl_GNTW5THHHYPF6432","type":"source.recorded","v":1}', '6dcf462a16452d5aecd9fea9ea25fcff2b52261ca722eb40dec113f6532c81e5', 'source.recorded', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.455Z', 21, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (23, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.455Z","op":21,"prev_hash":"6dcf462a16452d5aecd9fea9ea25fcff2b52261ca722eb40dec113f6532c81e5","seq":23,"slot":"sl_GNTW5THHHYPF6432","type":"write.base","v":1}', '4b6a9961304a1a5bbb986cde0fa4ea1ad61c53d0e0fa88af85a2eabbc42d2e1b', 'write.base', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.455Z', 21, 'sl_GNTW5THHHYPF6432', 't1', 'r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC', NULL);
INSERT INTO public.events VALUES (24, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.455Z","op":21,"prev_hash":"4b6a9961304a1a5bbb986cde0fa4ea1ad61c53d0e0fa88af85a2eabbc42d2e1b","seq":24,"slot":"sl_GNTW5THHHYPF6432","type":"write.derived","v":1}', '22cfa6af4894a4936b63c2d684b9b00ad7318ba10da717c97414e8fb0299b3ce', 'write.derived', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.455Z', 21, 'sl_GNTW5THHHYPF6432', 't5', NULL, NULL);
INSERT INTO public.events VALUES (25, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.464Z","prev_hash":"22cfa6af4894a4936b63c2d684b9b00ad7318ba10da717c97414e8fb0299b3ce","seq":25,"slot":"sl_GNTW5THHHYPF6432","type":"write.head","v":1}', '2d3e32bff1a9dbc900525c9224b70bca53dd3058d6b930c89e0c3b27738b2e8f', 'write.head', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.464Z', 25, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (26, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.464Z","op":25,"prev_hash":"2d3e32bff1a9dbc900525c9224b70bca53dd3058d6b930c89e0c3b27738b2e8f","seq":26,"slot":"sl_GNTW5THHHYPF6432","type":"source.recorded","v":1}', 'd1781391fe104b6e658257ba08b070d797d1320094be17ce3039bfee6b49c77a', 'source.recorded', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.464Z', 25, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (27, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.464Z","op":25,"prev_hash":"d1781391fe104b6e658257ba08b070d797d1320094be17ce3039bfee6b49c77a","seq":27,"slot":"sl_GNTW5THHHYPF6432","type":"write.base","v":1}', '500ffe72299d07b4bbeee2cd92da390962be1f6c89bc0bc1fb088b3ca3c1046f', 'write.base', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.464Z', 25, 'sl_GNTW5THHHYPF6432', 't1', 'r_15D0YYA6VPYZ1XG6404XSGF9P0', NULL);
INSERT INTO public.events VALUES (28, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.464Z","op":25,"prev_hash":"500ffe72299d07b4bbeee2cd92da390962be1f6c89bc0bc1fb088b3ca3c1046f","seq":28,"slot":"sl_GNTW5THHHYPF6432","type":"write.derived","v":1}', '3c6fe8369c842641f8824cc28b40199c4a043077f8602130a80f0b2dec5540b1', 'write.derived', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.464Z', 25, 'sl_GNTW5THHHYPF6432', 't5', NULL, NULL);
INSERT INTO public.events VALUES (29, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.474Z","prev_hash":"3c6fe8369c842641f8824cc28b40199c4a043077f8602130a80f0b2dec5540b1","seq":29,"slot":"sl_GNTW5THHHYPF6432","type":"write.head","v":1}', 'f690347937897bff5a87ed93b9d59b7eec70981c4166bba097cfa4cebc0e47fc', 'write.head', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.474Z', 29, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (30, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.474Z","op":29,"prev_hash":"f690347937897bff5a87ed93b9d59b7eec70981c4166bba097cfa4cebc0e47fc","seq":30,"slot":"sl_GNTW5THHHYPF6432","type":"source.recorded","v":1}', 'b324072e59355036847563b5ccc2ea1cd015b5e48ad41eb3dd69ec5102002b55', 'source.recorded', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.474Z', 29, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (31, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.474Z","op":29,"prev_hash":"b324072e59355036847563b5ccc2ea1cd015b5e48ad41eb3dd69ec5102002b55","seq":31,"slot":"sl_GNTW5THHHYPF6432","type":"write.base","v":1}', '2e0ea7120e3fedd2f6dee734dc6ffbc5dff4847f676764104ed233866489f9c8', 'write.base', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.474Z', 29, 'sl_GNTW5THHHYPF6432', 't1', 'r_WR69B2FVJQ1FTTB6ACJBMWQ49N', NULL);
INSERT INTO public.events VALUES (32, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.474Z","op":29,"prev_hash":"2e0ea7120e3fedd2f6dee734dc6ffbc5dff4847f676764104ed233866489f9c8","seq":32,"slot":"sl_GNTW5THHHYPF6432","type":"write.derived","v":1}', '8d02e542cdb40c1a3c8ffafb5867cbc57fc791a7cdd1e89356d3d8450199fd4f', 'write.derived', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.474Z', 29, 'sl_GNTW5THHHYPF6432', 't5', NULL, NULL);
INSERT INTO public.events VALUES (33, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.482Z","prev_hash":"8d02e542cdb40c1a3c8ffafb5867cbc57fc791a7cdd1e89356d3d8450199fd4f","seq":33,"slot":"sl_GNTW5THHHYPF6432","type":"write.head","v":1}', '624376eed2d661e38fafc87d5de4b64b37d6e3ab73c3fac7e47a14da5f721e66', 'write.head', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.482Z', 33, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (34, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.482Z","op":33,"prev_hash":"624376eed2d661e38fafc87d5de4b64b37d6e3ab73c3fac7e47a14da5f721e66","seq":34,"slot":"sl_GNTW5THHHYPF6432","type":"source.recorded","v":1}', '49a8410fbf5a8046ef44e11ccaa066f74c6f05c58b2fddcc9e16b714da71632f', 'source.recorded', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.482Z', 33, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (35, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.482Z","op":33,"prev_hash":"49a8410fbf5a8046ef44e11ccaa066f74c6f05c58b2fddcc9e16b714da71632f","seq":35,"slot":"sl_GNTW5THHHYPF6432","type":"write.base","v":1}', 'c7438d63807ca5ebb6f5f31a69d212b3bbb5fdf49283c0db6c441f1486dfe061', 'write.base', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.482Z', 33, 'sl_GNTW5THHHYPF6432', 't1', 'r_WR69B2FVJQ1FTTB6ACJBMWQ49N', NULL);
INSERT INTO public.events VALUES (36, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.482Z","op":33,"prev_hash":"c7438d63807ca5ebb6f5f31a69d212b3bbb5fdf49283c0db6c441f1486dfe061","seq":36,"slot":"sl_GNTW5THHHYPF6432","type":"write.derived","v":1}', '43d751de6a5ee8ea38b26e3da49a9f29d2a5ba4f0fb30a661d18eb5e8a72cdf8', 'write.derived', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.482Z', 33, 'sl_GNTW5THHHYPF6432', 't5', NULL, NULL);
INSERT INTO public.events VALUES (37, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.489Z","prev_hash":"43d751de6a5ee8ea38b26e3da49a9f29d2a5ba4f0fb30a661d18eb5e8a72cdf8","seq":37,"slot":"sl_GNTW5THHHYPF6432","type":"write.head","v":1}', '83fb3523d73d7eecdfd50d4a6db4ce83e6f013821e494418fe0b90fff2136c53', 'write.head', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.489Z', 37, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (38, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.489Z","op":37,"prev_hash":"83fb3523d73d7eecdfd50d4a6db4ce83e6f013821e494418fe0b90fff2136c53","seq":38,"slot":"sl_GNTW5THHHYPF6432","type":"source.recorded","v":1}', '1a4212e370409345352b1f1d859524cc964dfc6d0e2fadd748954d7cb07c0efd', 'source.recorded', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.489Z', 37, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (39, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.489Z","op":37,"prev_hash":"1a4212e370409345352b1f1d859524cc964dfc6d0e2fadd748954d7cb07c0efd","seq":39,"slot":"sl_GNTW5THHHYPF6432","type":"write.base","v":1}', '7f3d57887eb8e2a82d4aa78ac89cc13c8edb69e4dca14432176c576e9aa3a785', 'write.base', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.489Z', 37, 'sl_GNTW5THHHYPF6432', 't1', 'r_WR69B2FVJQ1FTTB6ACJBMWQ49N', NULL);
INSERT INTO public.events VALUES (40, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.489Z","op":37,"prev_hash":"7f3d57887eb8e2a82d4aa78ac89cc13c8edb69e4dca14432176c576e9aa3a785","seq":40,"slot":"sl_GNTW5THHHYPF6432","type":"write.derived","v":1}', 'aeb8d9a31044596eb8516e1a8f7bf3ff74221ee4fe59de1c92afa6aa1110652a', 'write.derived', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.489Z', 37, 'sl_GNTW5THHHYPF6432', 't5', NULL, NULL);
INSERT INTO public.events VALUES (41, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.497Z","prev_hash":"aeb8d9a31044596eb8516e1a8f7bf3ff74221ee4fe59de1c92afa6aa1110652a","seq":41,"slot":"sl_GNTW5THHHYPF6432","type":"write.head","v":1}', 'ad8dc04993f56f293a13e4ec0f6b1f8a69f3680209249500a7108d7b3f42ef75', 'write.head', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.497Z', 41, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (42, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.497Z","op":41,"prev_hash":"ad8dc04993f56f293a13e4ec0f6b1f8a69f3680209249500a7108d7b3f42ef75","seq":42,"slot":"sl_GNTW5THHHYPF6432","type":"source.recorded","v":1}', '6298c25134d8d002fab9ec0ca31aea02ffd1eff5e830ba182b18279ffcf50b31', 'source.recorded', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.497Z', 41, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (43, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.497Z","op":41,"prev_hash":"6298c25134d8d002fab9ec0ca31aea02ffd1eff5e830ba182b18279ffcf50b31","seq":43,"slot":"sl_GNTW5THHHYPF6432","type":"write.base","v":1}', '71b10450df261a9ec85900a18388a2957c15cf57e89cc5faa5e21a23e64c67e7', 'write.base', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.497Z', 41, 'sl_GNTW5THHHYPF6432', 't1', 'r_T226J69Z95XDYC8Q9B84CZEQ0A', NULL);
INSERT INTO public.events VALUES (44, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.497Z","op":41,"prev_hash":"71b10450df261a9ec85900a18388a2957c15cf57e89cc5faa5e21a23e64c67e7","seq":44,"slot":"sl_GNTW5THHHYPF6432","type":"write.derived","v":1}', 'a9de2c4abcb4a083f5269a963d11782483cbe436161080b13570c8a47de737ec', 'write.derived', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.497Z', 41, 'sl_GNTW5THHHYPF6432', 't5', NULL, NULL);
INSERT INTO public.events VALUES (45, '{"actor":"ci_28AEY7JR69A4PGD30R9SNHE1DN","at":"2026-11-26T10:24:00.504Z","prev_hash":"a9de2c4abcb4a083f5269a963d11782483cbe436161080b13570c8a47de737ec","seq":45,"slot":"sl_GNTW5THHHYPF6432","type":"write.head","v":1}', 'af519dadb112dc27091872981c5609af66aaa46ace33c470a570f4d48cc8b759', 'write.head', 'ci_28AEY7JR69A4PGD30R9SNHE1DN', '2026-11-26T10:24:00.504Z', 45, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (46, '{"actor":"ci_28AEY7JR69A4PGD30R9SNHE1DN","at":"2026-11-26T10:24:00.504Z","op":45,"prev_hash":"af519dadb112dc27091872981c5609af66aaa46ace33c470a570f4d48cc8b759","seq":46,"slot":"sl_GNTW5THHHYPF6432","type":"source.recorded","v":1}', '0f7b36d61516c520b0d867ca38ea1fa409489ae7e7cdfeb55c267718772c1247', 'source.recorded', 'ci_28AEY7JR69A4PGD30R9SNHE1DN', '2026-11-26T10:24:00.504Z', 45, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (47, '{"actor":"ci_28AEY7JR69A4PGD30R9SNHE1DN","at":"2026-11-26T10:24:00.504Z","op":45,"prev_hash":"0f7b36d61516c520b0d867ca38ea1fa409489ae7e7cdfeb55c267718772c1247","seq":47,"slot":"sl_GNTW5THHHYPF6432","type":"write.base","v":1}', '45dd549e224107b940907bba601293668b9629b44254e72a0876e59260cab83c', 'write.base', 'ci_28AEY7JR69A4PGD30R9SNHE1DN', '2026-11-26T10:24:00.504Z', 45, 'sl_GNTW5THHHYPF6432', 't1', 'r_T226J69Z95XDYC8Q9B84CZEQ0A', NULL);
INSERT INTO public.events VALUES (48, '{"actor":"ci_28AEY7JR69A4PGD30R9SNHE1DN","at":"2026-11-26T10:24:00.504Z","op":45,"prev_hash":"45dd549e224107b940907bba601293668b9629b44254e72a0876e59260cab83c","seq":48,"slot":"sl_GNTW5THHHYPF6432","type":"item.created","v":1}', '0775fdd680cfaa47574a30418c5feec20f1b48508e3c2e932832d86f18b81dc0', 'item.created', 'ci_28AEY7JR69A4PGD30R9SNHE1DN', '2026-11-26T10:24:00.504Z', 45, 'sl_GNTW5THHHYPF6432', 't1', 'r_T226J69Z95XDYC8Q9B84CZEQ0A', 47);
INSERT INTO public.events VALUES (49, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.514Z","prev_hash":"0775fdd680cfaa47574a30418c5feec20f1b48508e3c2e932832d86f18b81dc0","seq":49,"slot":"sl_GNTW5THHHYPF6432","type":"write.head","v":1}', 'd63e1cf26639ada551a6e6e081078249e1f068a7022c8f1d58ee779ac261860f', 'write.head', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.514Z', 49, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (50, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.514Z","op":49,"prev_hash":"d63e1cf26639ada551a6e6e081078249e1f068a7022c8f1d58ee779ac261860f","seq":50,"slot":"sl_GNTW5THHHYPF6432","type":"source.recorded","v":1}', '11f9bedd76f254e7692b886742f33b6b42aab145df4b3334e39e9d1acb4af435', 'source.recorded', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.514Z', 49, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (51, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.514Z","op":49,"prev_hash":"11f9bedd76f254e7692b886742f33b6b42aab145df4b3334e39e9d1acb4af435","seq":51,"slot":"sl_GNTW5THHHYPF6432","type":"write.base","v":1}', '4e20822e57784f699baa4e7b1cadf29fa9d009bc8dbb4d2632b75def3c49a6ca', 'write.base', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.514Z', 49, 'sl_GNTW5THHHYPF6432', 't4', 'r_DF4P6XP854WAKJA5KCZCN2K4F1', NULL);
INSERT INTO public.events VALUES (52, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.521Z","prev_hash":"4e20822e57784f699baa4e7b1cadf29fa9d009bc8dbb4d2632b75def3c49a6ca","seq":52,"slot":"sl_GNTW5THHHYPF6432","type":"write.head","v":1}', '84f904491f341710f83f94012c7f41c61fd25603f097d18bccd378e3d6e743a7', 'write.head', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.521Z', 52, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (53, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.521Z","op":52,"prev_hash":"84f904491f341710f83f94012c7f41c61fd25603f097d18bccd378e3d6e743a7","seq":53,"slot":"sl_GNTW5THHHYPF6432","type":"source.recorded","v":1}', 'fa92a2d5f9283d50589cb3d1c991ef08eba680030b2616685ac6ac5ba916d084', 'source.recorded', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.521Z', 52, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (54, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.521Z","op":52,"prev_hash":"fa92a2d5f9283d50589cb3d1c991ef08eba680030b2616685ac6ac5ba916d084","seq":54,"slot":"sl_GNTW5THHHYPF6432","type":"write.base","v":1}', '18d93a5789ac5cca764a18f1a943db5bab313d02d875e129ed7515c9299a78fb', 'write.base', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.521Z', 52, 'sl_GNTW5THHHYPF6432', 't2', 'e_WXAAKENGDMG892R1XX11VYKR6W', NULL);
INSERT INTO public.events VALUES (55, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.530Z","prev_hash":"18d93a5789ac5cca764a18f1a943db5bab313d02d875e129ed7515c9299a78fb","seq":55,"slot":"sl_GNTW5THHHYPF6432","type":"write.head","v":1}', '4fd29053627f2f60a62c8c515ea22c140fa39e0acffe36f82cc36fb2dfac1b13', 'write.head', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.530Z', 55, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (56, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.530Z","op":55,"prev_hash":"4fd29053627f2f60a62c8c515ea22c140fa39e0acffe36f82cc36fb2dfac1b13","seq":56,"slot":"sl_GNTW5THHHYPF6432","type":"source.recorded","v":1}', '1806c56140c542d6d388583a45c384db0920019ac5aa507bd0cab219733c9b5c', 'source.recorded', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.530Z', 55, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (57, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.530Z","op":55,"prev_hash":"1806c56140c542d6d388583a45c384db0920019ac5aa507bd0cab219733c9b5c","seq":57,"slot":"sl_GNTW5THHHYPF6432","type":"write.base","v":1}', '7b4cc0ddbcfa600f933e270e9c3a1d57f38e5b8764bfb2b75645207008053b31', 'write.base', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.530Z', 55, 'sl_GNTW5THHHYPF6432', 't2', 'e_WXAAKENGDMG892R1XX11VYKR6W', NULL);
INSERT INTO public.events VALUES (58, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.537Z","prev_hash":"7b4cc0ddbcfa600f933e270e9c3a1d57f38e5b8764bfb2b75645207008053b31","seq":58,"slot":"sl_GNTW5THHHYPF6432","type":"write.head","v":1}', 'fd8e96fe46580ba479e5980e5c5fc48378dda7778a39b81dd42bfef0f284fe9f', 'write.head', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.537Z', 58, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (59, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.537Z","op":58,"prev_hash":"fd8e96fe46580ba479e5980e5c5fc48378dda7778a39b81dd42bfef0f284fe9f","seq":59,"slot":"sl_GNTW5THHHYPF6432","type":"source.recorded","v":1}', 'cb0d442baa3b64cc45477b6f8882e33732f6063244afe4c89087bd6951ae4796', 'source.recorded', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.537Z', 58, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (60, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.537Z","op":58,"prev_hash":"cb0d442baa3b64cc45477b6f8882e33732f6063244afe4c89087bd6951ae4796","seq":60,"slot":"sl_GNTW5THHHYPF6432","type":"write.base","v":1}', 'e6a4da4467a98f273065da98484a885847cdabace92cc7dc6c40669773450427', 'write.base', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.537Z', 58, 'sl_GNTW5THHHYPF6432', 't2', 'e_WXAAKENGDMG892R1XX11VYKR6W', NULL);
INSERT INTO public.events VALUES (61, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.537Z","op":58,"prev_hash":"e6a4da4467a98f273065da98484a885847cdabace92cc7dc6c40669773450427","seq":61,"slot":"sl_GNTW5THHHYPF6432","type":"item.created","v":1}', 'a085c9090ad54bbc028cc24e731a4795d076cc51ad7861397bbb6105f2b90f52', 'item.created', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.537Z', 58, 'sl_GNTW5THHHYPF6432', 't2', 'e_WXAAKENGDMG892R1XX11VYKR6W', 60);
INSERT INTO public.events VALUES (62, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.545Z","prev_hash":"a085c9090ad54bbc028cc24e731a4795d076cc51ad7861397bbb6105f2b90f52","seq":62,"slot":"sl_GNTW5THHHYPF6432","type":"write.head","v":1}', '702dcb611d1af68a8ab89a688e2bab4ededb0352189f26ff36e02085eefdd93b', 'write.head', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.545Z', 62, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (63, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.545Z","op":62,"prev_hash":"702dcb611d1af68a8ab89a688e2bab4ededb0352189f26ff36e02085eefdd93b","seq":63,"slot":"sl_GNTW5THHHYPF6432","type":"source.recorded","v":1}', 'f2affc29e8c93f85d2470780a1c595f49d8fc151043a1389edf1edf81cf673c9', 'source.recorded', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.545Z', 62, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (64, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.545Z","op":62,"prev_hash":"f2affc29e8c93f85d2470780a1c595f49d8fc151043a1389edf1edf81cf673c9","seq":64,"slot":"sl_GNTW5THHHYPF6432","type":"source.recorded","v":1}', 'e75c84acdc336ad4608950c3038bcb9993f1859c6d0d5cc5b8f120b0c9ba5580', 'source.recorded', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.545Z', 62, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (65, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.545Z","op":62,"prev_hash":"e75c84acdc336ad4608950c3038bcb9993f1859c6d0d5cc5b8f120b0c9ba5580","seq":65,"slot":"sl_GNTW5THHHYPF6432","type":"write.base","v":1}', '9fc65c8df677bbe34adad0abf117869297443fbf7353e92295e67be80193dbf3', 'write.base', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.545Z', 62, 'sl_GNTW5THHHYPF6432', 't3', 'r_ZXQQZBZTZKVMZF3DR72Y0WPERW', NULL);
INSERT INTO public.events VALUES (66, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.545Z","op":62,"prev_hash":"9fc65c8df677bbe34adad0abf117869297443fbf7353e92295e67be80193dbf3","seq":66,"slot":"sl_GNTW5THHHYPF6432","type":"write.base","v":1}', '11c2e059477f82fc0c418e21ffdc30ae0e67b903cbcc631eadee2e13539f451b', 'write.base', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.545Z', 62, 'sl_GNTW5THHHYPF6432', 't3', 'r_VN6ZHQ4XDW34A24P9YSQYPQ5S4', NULL);
INSERT INTO public.events VALUES (67, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.552Z","prev_hash":"11c2e059477f82fc0c418e21ffdc30ae0e67b903cbcc631eadee2e13539f451b","seq":67,"slot":"sl_GNTW5THHHYPF6432","type":"write.head","v":1}', 'e070ff4870b4242f7674820a740606169d89c28353da7902693f7684843ec55e', 'write.head', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.552Z', 67, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (68, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.552Z","op":67,"prev_hash":"e070ff4870b4242f7674820a740606169d89c28353da7902693f7684843ec55e","seq":68,"slot":"sl_GNTW5THHHYPF6432","type":"source.recorded","v":1}', '3fe3bad65c07c7d64c0cd0f2f90368e9b93a294ea845748c3964541be6cc9932', 'source.recorded', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.552Z', 67, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (69, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.552Z","op":67,"prev_hash":"3fe3bad65c07c7d64c0cd0f2f90368e9b93a294ea845748c3964541be6cc9932","seq":69,"slot":"sl_GNTW5THHHYPF6432","type":"write.base","v":1}', '97f996f7e42c9a1e54e3e75dd6af1cca3bbf38bc22c195555ff55f0d601ef778', 'write.base', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.552Z', 67, 'sl_GNTW5THHHYPF6432', 't3', 'r_ZXQQZBZTZKVMZF3DR72Y0WPERW', NULL);
INSERT INTO public.events VALUES (70, '{"actor":"u_9Y4XEYT01A0BX9R0VEPPKGZD2Q","at":"2026-11-26T10:24:00.574Z","prev_hash":"97f996f7e42c9a1e54e3e75dd6af1cca3bbf38bc22c195555ff55f0d601ef778","seq":70,"slot":"sl_GNTW5THHHYPF6432","type":"schema.draft_submitted","v":1}', '70d60e6ba7058f12b605888e20afdbf5e5b4ae5aef5d6af61ee5c2d3d1ef09c0', 'schema.draft_submitted', 'u_9Y4XEYT01A0BX9R0VEPPKGZD2Q', '2026-11-26T10:24:00.574Z', 70, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (71, '{"actor":"u_9Y4XEYT01A0BX9R0VEPPKGZD2Q","at":"2026-11-26T10:24:00.574Z","op":70,"prev_hash":"70d60e6ba7058f12b605888e20afdbf5e5b4ae5aef5d6af61ee5c2d3d1ef09c0","seq":71,"slot":"sl_GNTW5THHHYPF6432","type":"schema.compiled","v":1}', '386d98ae86ab147b22d5f6fad5f8458631369d8bd154b719f82ccec2d1e93d12', 'schema.compiled', 'u_9Y4XEYT01A0BX9R0VEPPKGZD2Q', '2026-11-26T10:24:00.574Z', 70, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (72, '{"actor":"u_9Y4XEYT01A0BX9R0VEPPKGZD2Q","at":"2026-11-26T10:24:00.574Z","op":70,"prev_hash":"386d98ae86ab147b22d5f6fad5f8458631369d8bd154b719f82ccec2d1e93d12","seq":72,"slot":"sl_GNTW5THHHYPF6432","type":"item.created","v":1}', '2c1b27e5ea06f80e784ec892c02de6f9843511dc84c1ea9b38d4e98a05659a7d', 'item.created', 'u_9Y4XEYT01A0BX9R0VEPPKGZD2Q', '2026-11-26T10:24:00.574Z', 70, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (73, '{"actor":"u_9Y4XEYT01A0BX9R0VEPPKGZD2Q","at":"2026-11-26T10:24:00.580Z","prev_hash":"2c1b27e5ea06f80e784ec892c02de6f9843511dc84c1ea9b38d4e98a05659a7d","seq":73,"slot":"sl_GNTW5THHHYPF6432","type":"item.resolved","v":1}', '9ee4878ed33f3eed6bbb11cf165802736bd73c09e5b12321cd78d48a7482b272', 'item.resolved', 'u_9Y4XEYT01A0BX9R0VEPPKGZD2Q', '2026-11-26T10:24:00.580Z', 73, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (74, '{"actor":"u_9Y4XEYT01A0BX9R0VEPPKGZD2Q","at":"2026-11-26T10:24:00.580Z","op":73,"prev_hash":"9ee4878ed33f3eed6bbb11cf165802736bd73c09e5b12321cd78d48a7482b272","seq":74,"slot":"sl_GNTW5THHHYPF6432","type":"schema.confirmed","v":1}', '0585a06646d5d4da7aa05d91199a2e0e5e4cb8da04ff38c3e477a1d6ea7c9539', 'schema.confirmed', 'u_9Y4XEYT01A0BX9R0VEPPKGZD2Q', '2026-11-26T10:24:00.580Z', 73, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (75, '{"actor":"u_9Y4XEYT01A0BX9R0VEPPKGZD2Q","at":"2026-11-26T10:24:00.580Z","op":73,"prev_hash":"0585a06646d5d4da7aa05d91199a2e0e5e4cb8da04ff38c3e477a1d6ea7c9539","seq":75,"slot":"sl_GNTW5THHHYPF6432","type":"schema.switched","v":1}', '55e4022879faf738e884e08c2a84de30d9c4f0bbada63a15e7bed091051a32a2', 'schema.switched', 'u_9Y4XEYT01A0BX9R0VEPPKGZD2Q', '2026-11-26T10:24:00.580Z', 73, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (76, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.589Z","prev_hash":"55e4022879faf738e884e08c2a84de30d9c4f0bbada63a15e7bed091051a32a2","seq":76,"slot":"sl_GNTW5THHHYPF6432","type":"write.head","v":1}', '3fe19fe356772ebcf90a48eb578f3f2ab1fef89fea3abf6a1ced5ca1182d67c9', 'write.head', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.589Z', 76, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (77, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.589Z","op":76,"prev_hash":"3fe19fe356772ebcf90a48eb578f3f2ab1fef89fea3abf6a1ced5ca1182d67c9","seq":77,"slot":"sl_GNTW5THHHYPF6432","type":"source.recorded","v":1}', 'f8266bfa6d3aff8b0d3a2d65015383667e618317c57eb1639aed8ea852d911c6', 'source.recorded', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.589Z', 76, 'sl_GNTW5THHHYPF6432', NULL, NULL, NULL);
INSERT INTO public.events VALUES (78, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.589Z","op":76,"prev_hash":"f8266bfa6d3aff8b0d3a2d65015383667e618317c57eb1639aed8ea852d911c6","seq":78,"slot":"sl_GNTW5THHHYPF6432","type":"write.base","v":1}', '309e827d476f8cfe234b8197b9a5dcc7339b4dbf1a23c7e15796ba33356b9ea9', 'write.base', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.589Z', 76, 'sl_GNTW5THHHYPF6432', 't1', 'r_X075V18D1AMV40A8CPGWMCGCVT', NULL);
INSERT INTO public.events VALUES (79, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.589Z","op":76,"prev_hash":"309e827d476f8cfe234b8197b9a5dcc7339b4dbf1a23c7e15796ba33356b9ea9","seq":79,"slot":"sl_GNTW5THHHYPF6432","type":"item.created","v":1}', '39c4ba32f13dc473c2d53608d76ff7b92aa47677ef5ae9b22fd4dcadf7300d6a', 'item.created', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.589Z', 76, 'sl_GNTW5THHHYPF6432', 't1', 'r_X075V18D1AMV40A8CPGWMCGCVT', 78);
INSERT INTO public.events VALUES (80, '{"actor":"ci_13RVWVAK2CY9070YXR3ADTKAWX","at":"2026-11-26T10:24:00.589Z","op":76,"prev_hash":"39c4ba32f13dc473c2d53608d76ff7b92aa47677ef5ae9b22fd4dcadf7300d6a","seq":80,"slot":"sl_GNTW5THHHYPF6432","type":"write.derived","v":1}', 'ecbd9f5d7835d7be233342636214e2ccd7e96b66bedd61d6fbc410417ac82f75', 'write.derived', 'ci_13RVWVAK2CY9070YXR3ADTKAWX', '2026-11-26T10:24:00.589Z', 76, 'sl_GNTW5THHHYPF6432', 't5', NULL, NULL);


--
-- Data for Name: external_keys; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: field_name_usage; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: flags; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.flags VALUES ('t1', 'r_T226J69Z95XDYC8Q9B84CZEQ0A', 'disputed', 'pi_HW8HTKYH4BC5CGM5', '["f2"]', NULL);
INSERT INTO public.flags VALUES ('t2', 'e_WXAAKENGDMG892R1XX11VYKR6W', 'awaiting', 'pi_8E6VV4JE0NQWXEC3', '["f2"]', '[{"from":"2026-10-15"}]');
INSERT INTO public.flags VALUES ('t1', 'r_X075V18D1AMV40A8CPGWMCGCVT', 'flagged', 'pi_Y6E8WZM8RS817HH2', NULL, NULL);


--
-- Data for Name: last_read; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.last_read VALUES ('ci_13RVWVAK2CY9070YXR3ADTKAWX', '', 'e_WXAAKENGDMG892R1XX11VYKR6W', 'ver', 55, 0, 'rd_8TFNB3CJ799F6BEJ');
INSERT INTO public.last_read VALUES ('ci_13RVWVAK2CY9070YXR3ADTKAWX', '', 'r_ZXQQZBZTZKVMZF3DR72Y0WPERW', 'ver', 67, 0, 'rd_PC14K4TFXAJBHAXF');
INSERT INTO public.last_read VALUES ('ci_13RVWVAK2CY9070YXR3ADTKAWX', '', 'r_VN6ZHQ4XDW34A24P9YSQYPQ5S4', 'ver', 62, 0, 'rd_PC14K4TFXAJBHAXF');
INSERT INTO public.last_read VALUES ('ci_13RVWVAK2CY9070YXR3ADTKAWX', '', 'r_DF4P6XP854WAKJA5KCZCN2K4F1', 'ver', 49, 0, 'rd_JNGC03CYCMJZ70C2');
INSERT INTO public.last_read VALUES ('ci_28AEY7JR69A4PGD30R9SNHE1DN', '', 'r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC', 'ver', 21, 0, 'rd_32SQSSG2YDDE3XRV');
INSERT INTO public.last_read VALUES ('ci_28AEY7JR69A4PGD30R9SNHE1DN', '', 'sl_GNTW5THHHYPF6432', 'sv', 1, 0, 'rd_32SQSSG2YDDE3XRV');
INSERT INTO public.last_read VALUES ('ci_13RVWVAK2CY9070YXR3ADTKAWX', '', 'r_WR69B2FVJQ1FTTB6ACJBMWQ49N', 'ver', 37, 0, 'rd_8TDAD7CB1HN61NP2');
INSERT INTO public.last_read VALUES ('ci_13RVWVAK2CY9070YXR3ADTKAWX', '', 'r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC', 'ver', 21, 0, 'rd_8TDAD7CB1HN61NP2');
INSERT INTO public.last_read VALUES ('ci_13RVWVAK2CY9070YXR3ADTKAWX', '', 'r_T226J69Z95XDYC8Q9B84CZEQ0A', 'ver', 41, 0, 'rd_8TDAD7CB1HN61NP2');
INSERT INTO public.last_read VALUES ('ci_13RVWVAK2CY9070YXR3ADTKAWX', '', 'r_X075V18D1AMV40A8CPGWMCGCVT', 'ver', 76, 0, 'rd_8TDAD7CB1HN61NP2');
INSERT INTO public.last_read VALUES ('ci_13RVWVAK2CY9070YXR3ADTKAWX', '', 'sl_GNTW5THHHYPF6432', 'sv', 2, 0, 'rd_8TDAD7CB1HN61NP2');
INSERT INTO public.last_read VALUES ('u_9Y4XEYT01A0BX9R0VEPPKGZD2Q', '', 'r_WR69B2FVJQ1FTTB6ACJBMWQ49N', 'ver', 37, 0, 'rd_KBA4P7CS1C9MBY9K');
INSERT INTO public.last_read VALUES ('u_9Y4XEYT01A0BX9R0VEPPKGZD2Q', '', 'r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC', 'ver', 21, 0, 'rd_KBA4P7CS1C9MBY9K');
INSERT INTO public.last_read VALUES ('u_9Y4XEYT01A0BX9R0VEPPKGZD2Q', '', 'r_T226J69Z95XDYC8Q9B84CZEQ0A', 'ver', 41, 0, 'rd_KBA4P7CS1C9MBY9K');
INSERT INTO public.last_read VALUES ('u_9Y4XEYT01A0BX9R0VEPPKGZD2Q', '', 'r_X075V18D1AMV40A8CPGWMCGCVT', 'ver', 76, 0, 'rd_KBA4P7CS1C9MBY9K');
INSERT INTO public.last_read VALUES ('u_9Y4XEYT01A0BX9R0VEPPKGZD2Q', '', 'e_WXAAKENGDMG892R1XX11VYKR6W', 'ver', 55, 0, 'rd_S6WXX3VA7E8KN408');
INSERT INTO public.last_read VALUES ('u_9Y4XEYT01A0BX9R0VEPPKGZD2Q', '', 'sl_GNTW5THHHYPF6432', 'sv', 2, 0, 'rd_S6WXX3VA7E8KN408');


--
-- Data for Name: meta; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.meta VALUES ('storage_format', '5');
INSERT INTO public.meta VALUES ('session_settings', '["SET client_encoding = ''UTF8''","SET TIME ZONE ''UTC''","SET datestyle = ''ISO, YMD''","SET intervalstyle = ''iso_8601''","SET extra_float_digits = 3","SET standard_conforming_strings = on"]');
INSERT INTO public.meta VALUES ('tenant_id', 'tn_5KTF59EVB2FQR4RJ95DASGER50');
INSERT INTO public.meta VALUES ('ownership_epoch', '2');


--
-- Data for Name: migrations; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: partitions; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.partitions VALUES ('t5', 'p_9H3HPRDHCKXPZR6K', '["2026-11-02"]');
INSERT INTO public.partitions VALUES ('t5', 'p_756ESA1YTGYB3EK2', '["2026-11-03"]');
INSERT INTO public.partitions VALUES ('t5', 'p_CB2PNKC8BDR84JE8', '["2026-11-04"]');


--
-- Data for Name: pending_blocks; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: pending_entries; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.pending_entries VALUES ('pi_HW8HTKYH4BC5CGM5', 0, 48, 'candidates/0');
INSERT INTO public.pending_entries VALUES ('pi_HW8HTKYH4BC5CGM5', 1, 48, 'current/0');
INSERT INTO public.pending_entries VALUES ('pi_HW8HTKYH4BC5CGM5', 2, 48, 'impact/0');
INSERT INTO public.pending_entries VALUES ('pi_HW8HTKYH4BC5CGM5', 3, 48, 'previous/0');
INSERT INTO public.pending_entries VALUES ('pi_8E6VV4JE0NQWXEC3', 0, 61, 'current/0');
INSERT INTO public.pending_entries VALUES ('pi_8E6VV4JE0NQWXEC3', 1, 61, 'current/1');
INSERT INTO public.pending_entries VALUES ('pi_8E6VV4JE0NQWXEC3', 2, 61, 'impact/0');
INSERT INTO public.pending_entries VALUES ('pi_8E6VV4JE0NQWXEC3', 3, 61, 'impact/1');
INSERT INTO public.pending_entries VALUES ('pi_8E6VV4JE0NQWXEC3', 4, 61, 'proposed/0');
INSERT INTO public.pending_entries VALUES ('pi_8E6VV4JE0NQWXEC3', 5, 61, 'scope_valid');
INSERT INTO public.pending_entries VALUES ('pi_Y6E8WZM8RS817HH2', 0, 79, 'matched/0');


--
-- Data for Name: pending_items; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.pending_items VALUES ('pi_HW8HTKYH4BC5CGM5', 'conflict', 'sl_GNTW5THHHYPF6432', 't1', 'r_T226J69Z95XDYC8Q9B84CZEQ0A', 'open', NULL, 45);
INSERT INTO public.pending_items VALUES ('pi_8E6VV4JE0NQWXEC3', 'awaiting_confirmation', 'sl_GNTW5THHHYPF6432', 't2', 'e_WXAAKENGDMG892R1XX11VYKR6W', 'open', NULL, 58);
INSERT INTO public.pending_items VALUES ('pi_YYGGWCXTQ5EVJ773', 'schema_change', 'sl_GNTW5THHHYPF6432', NULL, NULL, 'resolved', 'confirm', 70);
INSERT INTO public.pending_items VALUES ('pi_Y6E8WZM8RS817HH2', 'flagged', 'sl_GNTW5THHHYPF6432', 't1', 'r_X075V18D1AMV40A8CPGWMCGCVT', 'open', NULL, 76);


--
-- Data for Name: possibly_affected; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: premise_decls; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.premise_decls VALUES (49, 0, 0, 't4', 'r_DF4P6XP854WAKJA5KCZCN2K4F1', 't1', 'r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC', '["f2"]', 'whole', NULL, 21, 0, 'current', NULL, NULL, 'ci_13RVWVAK2CY9070YXR3ADTKAWX');


--
-- Data for Name: premise_edges; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.premise_edges VALUES (51, 'f1', 0, 'r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC', 49, 0, 0);
INSERT INTO public.premise_edges VALUES (51, 'f2', 0, 'r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC', 49, 0, 0);


--
-- Data for Name: principals; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.principals VALUES ('u_9Y4XEYT01A0BX9R0VEPPKGZD2Q', 'user', NULL, NULL, NULL, NULL, NULL, 'active', 1);
INSERT INTO public.principals VALUES ('system', 'system', NULL, NULL, NULL, NULL, NULL, 'active', 1);
INSERT INTO public.principals VALUES ('ci_13RVWVAK2CY9070YXR3ADTKAWX', 'connection', 'sample agent', '["saveslot.read","saveslot.write","saveslot.schema"]', NULL, 'token', NULL, 'active', 7);
INSERT INTO public.principals VALUES ('ci_28AEY7JR69A4PGD30R9SNHE1DN', 'connection', 'another agent', '["saveslot.read","saveslot.write","saveslot.schema"]', NULL, 'token', NULL, 'active', 8);


--
-- Data for Name: read_log; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_H6FDHWWGCHQTBYJS', 1, 'ci_13RVWVAK2CY9070YXR3ADTKAWX', NULL, '2026-11-26T10:24:00.557Z', 67, 'query', false, false, 'sl_GNTW5THHHYPF6432', 1, 't1', '{"fields":["f1","f2","f3"],"order":[],"page":false,"table":"t1","time":"none","where":[]}', NULL, NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_8TFNB3CJ799F6BEJ', 2, 'ci_13RVWVAK2CY9070YXR3ADTKAWX', NULL, '2026-11-26T10:24:00.561Z', 67, 'query', false, false, 'sl_GNTW5THHHYPF6432', 1, 't2', '{"fields":["f1","f2"],"order":[],"page":false,"table":"t2","time":"none","where":[]}', '{"at":"2026-11-26"}', NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_PC14K4TFXAJBHAXF', 3, 'ci_13RVWVAK2CY9070YXR3ADTKAWX', NULL, '2026-11-26T10:24:00.563Z', 67, 'query', false, false, 'sl_GNTW5THHHYPF6432', 1, 't3', '{"fields":["f1","f2","f3"],"order":[],"page":false,"table":"t3","time":"none","where":[]}', NULL, NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_JNGC03CYCMJZ70C2', 4, 'ci_13RVWVAK2CY9070YXR3ADTKAWX', NULL, '2026-11-26T10:24:00.565Z', 67, 'query', false, false, 'sl_GNTW5THHHYPF6432', 1, 't4', '{"fields":["f1","f2"],"order":[],"page":false,"table":"t4","time":"none","where":[]}', NULL, NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_C8PB3305KYNM64B6', 5, 'ci_13RVWVAK2CY9070YXR3ADTKAWX', NULL, '2026-11-26T10:24:00.568Z', 67, 'query', false, false, 'sl_GNTW5THHHYPF6432', 1, 't5', '{"fields":["f1","f2","f3"],"order":[],"page":false,"table":"t5","time":"none","where":[]}', NULL, NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_32SQSSG2YDDE3XRV', 6, 'ci_28AEY7JR69A4PGD30R9SNHE1DN', NULL, '2026-11-26T10:24:00.570Z', 67, 'history', false, false, 'sl_GNTW5THHHYPF6432', 1, 't1', '{"mode":"timeline","table":"t1","target":"r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC"}', NULL, NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_8TDAD7CB1HN61NP2', 7, 'ci_13RVWVAK2CY9070YXR3ADTKAWX', NULL, '2026-11-26T10:24:00.598Z', 76, 'query', false, false, 'sl_GNTW5THHHYPF6432', 2, 't1', '{"fields":["f1","f2","f3"],"order":[],"page":false,"table":"t1","time":"none","where":[]}', NULL, NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_KBA4P7CS1C9MBY9K', 8, 'u_9Y4XEYT01A0BX9R0VEPPKGZD2Q', NULL, '2026-11-26T10:24:00.600Z', 76, 'query', false, false, 'sl_GNTW5THHHYPF6432', 2, 't1', '{"fields":["f1","f2","f3"],"order":[],"page":false,"table":"t1","time":"none","where":[]}', NULL, NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_BKJCZTTMT893PFW1', 9, 'u_9Y4XEYT01A0BX9R0VEPPKGZD2Q', NULL, '2026-11-26T10:24:00.602Z', 76, 'query', false, false, 'sl_GNTW5THHHYPF6432', 2, 't2', '{"fields":["f1","f2"],"order":[],"page":false,"table":"t2","time":"at","where":[]}', '{"at":"2026-10-05"}', NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_S6WXX3VA7E8KN408', 10, 'u_9Y4XEYT01A0BX9R0VEPPKGZD2Q', NULL, '2026-11-26T10:24:00.605Z', 76, 'query', false, false, 'sl_GNTW5THHHYPF6432', 2, 't2', '{"fields":["f1","f2"],"order":[],"page":false,"table":"t2","time":"at","where":[]}', '{"at":"2026-11-15"}', NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_D1FJNHR19AQCEQ5D', 11, 'u_9Y4XEYT01A0BX9R0VEPPKGZD2Q', NULL, '2026-11-26T10:24:00.607Z', 76, 'pending', false, false, NULL, NULL, NULL, '{"list":true,"slot":null,"status":"open","type":null}', NULL, NULL, NULL, NULL);


--
-- Data for Name: read_log_rows; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.read_log_rows VALUES ('rd_H6FDHWWGCHQTBYJS', 0, 't1', 'r_WR69B2FVJQ1FTTB6ACJBMWQ49N', 37, 0);
INSERT INTO public.read_log_rows VALUES ('rd_H6FDHWWGCHQTBYJS', 1, 't1', 'r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC', 21, 0);
INSERT INTO public.read_log_rows VALUES ('rd_H6FDHWWGCHQTBYJS', 2, 't1', 'r_T226J69Z95XDYC8Q9B84CZEQ0A', 41, 0);
INSERT INTO public.read_log_rows VALUES ('rd_8TFNB3CJ799F6BEJ', 0, 't2', 'e_WXAAKENGDMG892R1XX11VYKR6W', 55, 0);
INSERT INTO public.read_log_rows VALUES ('rd_PC14K4TFXAJBHAXF', 0, 't3', 'r_ZXQQZBZTZKVMZF3DR72Y0WPERW', 67, 0);
INSERT INTO public.read_log_rows VALUES ('rd_PC14K4TFXAJBHAXF', 1, 't3', 'r_VN6ZHQ4XDW34A24P9YSQYPQ5S4', 62, 0);
INSERT INTO public.read_log_rows VALUES ('rd_JNGC03CYCMJZ70C2', 0, 't4', 'r_DF4P6XP854WAKJA5KCZCN2K4F1', 49, 0);
INSERT INTO public.read_log_rows VALUES ('rd_C8PB3305KYNM64B6', 0, 't5', 'p_9H3HPRDHCKXPZR6K', 41, 0);
INSERT INTO public.read_log_rows VALUES ('rd_C8PB3305KYNM64B6', 1, 't5', 'p_CB2PNKC8BDR84JE8', 37, 0);
INSERT INTO public.read_log_rows VALUES ('rd_32SQSSG2YDDE3XRV', 0, 't1', 'r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC', 21, 0);
INSERT INTO public.read_log_rows VALUES ('rd_8TDAD7CB1HN61NP2', 0, 't1', 'r_WR69B2FVJQ1FTTB6ACJBMWQ49N', 37, 0);
INSERT INTO public.read_log_rows VALUES ('rd_8TDAD7CB1HN61NP2', 1, 't1', 'r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC', 21, 0);
INSERT INTO public.read_log_rows VALUES ('rd_8TDAD7CB1HN61NP2', 2, 't1', 'r_T226J69Z95XDYC8Q9B84CZEQ0A', 41, 0);
INSERT INTO public.read_log_rows VALUES ('rd_8TDAD7CB1HN61NP2', 3, 't1', 'r_X075V18D1AMV40A8CPGWMCGCVT', 76, 0);
INSERT INTO public.read_log_rows VALUES ('rd_KBA4P7CS1C9MBY9K', 0, 't1', 'r_WR69B2FVJQ1FTTB6ACJBMWQ49N', 37, 0);
INSERT INTO public.read_log_rows VALUES ('rd_KBA4P7CS1C9MBY9K', 1, 't1', 'r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC', 21, 0);
INSERT INTO public.read_log_rows VALUES ('rd_KBA4P7CS1C9MBY9K', 2, 't1', 'r_T226J69Z95XDYC8Q9B84CZEQ0A', 41, 0);
INSERT INTO public.read_log_rows VALUES ('rd_KBA4P7CS1C9MBY9K', 3, 't1', 'r_X075V18D1AMV40A8CPGWMCGCVT', 76, 0);
INSERT INTO public.read_log_rows VALUES ('rd_BKJCZTTMT893PFW1', 0, 't2', 'e_WXAAKENGDMG892R1XX11VYKR6W', 55, 0);
INSERT INTO public.read_log_rows VALUES ('rd_S6WXX3VA7E8KN408', 0, 't2', 'e_WXAAKENGDMG892R1XX11VYKR6W', 55, 0);


--
-- Data for Name: request_keys; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.request_keys VALUES ('f7c33967e997d49e25c82eab595b057e15c3719df6aa4200eb974d580b775735', 2, '2026-11-26T10:24:00.367Z', NULL);
INSERT INTO public.request_keys VALUES ('cffbcfc65163f33fd3f1e918bbfc78bb804293293194a2be25c7cdd1c24449e8', 9, '2026-11-26T10:24:00.415Z', NULL);
INSERT INTO public.request_keys VALUES ('9f9015a7a09a2eae2ae68b0f79db0377c8ffd49e1ea66f1336cdb7e975e1a637', 13, '2026-11-26T10:24:00.437Z', NULL);
INSERT INTO public.request_keys VALUES ('b202f2c2827ed3319f0ea354ad8f70b18839865d9c00aaabff1d9a0d6a1256ab', 17, '2026-11-26T10:24:00.446Z', NULL);
INSERT INTO public.request_keys VALUES ('4cbef7d0c51d63ce64e66be766cff178f7f54dd05e2735135c475fa85e72ad90', 21, '2026-11-26T10:24:00.455Z', NULL);
INSERT INTO public.request_keys VALUES ('73726a56779c4e8742f661b905d04980116ce132e4de540143b4a1e2eda00b01', 25, '2026-11-26T10:24:00.464Z', NULL);
INSERT INTO public.request_keys VALUES ('614c738e44325a96c3cfd36bbf7363d45268ad53434080ec9231ad3c9010cc7a', 29, '2026-11-26T10:24:00.474Z', NULL);
INSERT INTO public.request_keys VALUES ('25bc9d12e49ee4cacdd1c4dca207f3afbfccd6f3cbe3cd8cddd4b8d5eddb0e7a', 33, '2026-11-26T10:24:00.482Z', NULL);
INSERT INTO public.request_keys VALUES ('e774d76a8e980291c7d0b8158d87e13f3e0960d99a4269f6973a59dc7e568055', 37, '2026-11-26T10:24:00.489Z', NULL);
INSERT INTO public.request_keys VALUES ('a1ca33c5264115c940eb1347cbb63d668693c13a31af436a4c6753d991bf0f51', 41, '2026-11-26T10:24:00.497Z', NULL);
INSERT INTO public.request_keys VALUES ('8b9fedf0694d30621e71fc521fdaca8a9936c61c16fb0866031f3b4364e18b09', 45, '2026-11-26T10:24:00.504Z', NULL);
INSERT INTO public.request_keys VALUES ('7751276e9ca66262b1de6f608962a58a408b0330e71f20642201c43fd9abc641', 49, '2026-11-26T10:24:00.514Z', NULL);
INSERT INTO public.request_keys VALUES ('81a919af9767409553c63e13b5fcac68dc7583caa8e6ba67d899b087a1a1f54e', 52, '2026-11-26T10:24:00.521Z', NULL);
INSERT INTO public.request_keys VALUES ('9a4704bafcecafa6e68847a8cbd33af5c2ea5729afa8399e5c5defa1b28ad2f9', 55, '2026-11-26T10:24:00.530Z', NULL);
INSERT INTO public.request_keys VALUES ('f50067c8f1d27b78631090519d5f0a10beaf593150530b4dd2f98b899d6d75c4', 58, '2026-11-26T10:24:00.537Z', NULL);
INSERT INTO public.request_keys VALUES ('8ac4697d2eaaa1a2bf5f6639d280b41aba7a5a5f664cebefabf05b7d89b23774', 70, '2026-11-26T10:24:00.574Z', NULL);
INSERT INTO public.request_keys VALUES ('8437bf30160a2976c527a8bb9d060239f2857a346cd65c84865f74aa7e37e84d', 73, '2026-11-26T10:24:00.580Z', NULL);
INSERT INTO public.request_keys VALUES ('68d490fcfcd7a373cb7be1dcb3e038ae57484c580665aac5220b1001bc0634ef', 76, '2026-11-26T10:24:00.589Z', NULL);


--
-- Data for Name: residue_progress; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: row_origins; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.row_origins VALUES ('r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC', 't1', 11);
INSERT INTO public.row_origins VALUES ('r_T226J69Z95XDYC8Q9B84CZEQ0A', 't1', 15);
INSERT INTO public.row_origins VALUES ('r_15D0YYA6VPYZ1XG6404XSGF9P0', 't1', 19);
INSERT INTO public.row_origins VALUES ('r_WR69B2FVJQ1FTTB6ACJBMWQ49N', 't1', 31);
INSERT INTO public.row_origins VALUES ('r_DF4P6XP854WAKJA5KCZCN2K4F1', 't4', 51);
INSERT INTO public.row_origins VALUES ('e_WXAAKENGDMG892R1XX11VYKR6W', 't2', 54);
INSERT INTO public.row_origins VALUES ('r_ZXQQZBZTZKVMZF3DR72Y0WPERW', 't3', 65);
INSERT INTO public.row_origins VALUES ('r_VN6ZHQ4XDW34A24P9YSQYPQ5S4', 't3', 66);
INSERT INTO public.row_origins VALUES ('r_X075V18D1AMV40A8CPGWMCGCVT', 't1', 78);


--
-- Data for Name: schema_versions; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.schema_versions VALUES ('sl_GNTW5THHHYPF6432', 1, 3, 'd_660T17A0JDR8PFHK', 6, 'retired');
INSERT INTO public.schema_versions VALUES ('sl_GNTW5THHHYPF6432', 2, 71, 'd_DM4HXY997BWG7RRM', 75, 'current');


--
-- Data for Name: slots; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.slots VALUES ('sl_GNTW5THHHYPF6432', 'household', 'Asia/Shanghai', 2, 5, 1);


--
-- Data for Name: sources; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.sources VALUES (10, 's_W8YSD28CZ805DHSA', 'user_message', 'user_stated', 'sl_GNTW5THHHYPF6432', 'present');
INSERT INTO public.sources VALUES (14, 's_5SMT7F3GJGCS0C08', 'api_call', 'agent_inferred', 'sl_GNTW5THHHYPF6432', 'present');
INSERT INTO public.sources VALUES (18, 's_27C465DSY2DA5R06', 'api_call', 'agent_inferred', 'sl_GNTW5THHHYPF6432', 'present');
INSERT INTO public.sources VALUES (22, 's_E0ERE1FV44S28PZ1', 'user_message', 'user_stated', 'sl_GNTW5THHHYPF6432', 'present');
INSERT INTO public.sources VALUES (26, 's_KHP7SN6E8GXXYYRW', 'api_call', 'agent_inferred', 'sl_GNTW5THHHYPF6432', 'present');
INSERT INTO public.sources VALUES (30, 's_92YYN8AZKE98CS6H', 'api_call', 'agent_inferred', 'sl_GNTW5THHHYPF6432', 'present');
INSERT INTO public.sources VALUES (34, 's_SSKACYGVXD9MFFZJ', 'api_call', 'agent_inferred', 'sl_GNTW5THHHYPF6432', 'present');
INSERT INTO public.sources VALUES (38, 's_R01833QMNASB67KP', 'api_call', 'agent_inferred', 'sl_GNTW5THHHYPF6432', 'present');
INSERT INTO public.sources VALUES (42, 's_QCSZMSTW3833DX8C', 'api_call', 'agent_inferred', 'sl_GNTW5THHHYPF6432', 'present');
INSERT INTO public.sources VALUES (46, 's_CPKSYSENZVCA7J9T', 'api_call', 'agent_inferred', 'sl_GNTW5THHHYPF6432', 'present');
INSERT INTO public.sources VALUES (50, 's_0KGK222570AWN263', 'api_call', 'agent_inferred', 'sl_GNTW5THHHYPF6432', 'present');
INSERT INTO public.sources VALUES (53, 's_ZC19EXG3MMH98NJR', 'api_call', 'agent_inferred', 'sl_GNTW5THHHYPF6432', 'present');
INSERT INTO public.sources VALUES (56, 's_TP02MPHQ3S2JGCE2', 'api_call', 'agent_inferred', 'sl_GNTW5THHHYPF6432', 'present');
INSERT INTO public.sources VALUES (59, 's_G5RBFAGDHBWA8XQC', 'api_call', 'agent_inferred', 'sl_GNTW5THHHYPF6432', 'present');
INSERT INTO public.sources VALUES (63, 's_7R30BHCGWE1N0PH6', 'api_call', 'agent_inferred', 'sl_GNTW5THHHYPF6432', 'present');
INSERT INTO public.sources VALUES (64, 's_4V1ZBDMSRRE6408R', 'api_call', 'agent_inferred', 'sl_GNTW5THHHYPF6432', 'present');
INSERT INTO public.sources VALUES (68, 's_K993NMNJKQJ73GEM', 'api_call', 'agent_inferred', 'sl_GNTW5THHHYPF6432', 'present');
INSERT INTO public.sources VALUES (77, 's_84M2Z7R71EXNBJ1W', 'api_call', 'agent_inferred', 'sl_GNTW5THHHYPF6432', 'present');


--
-- Data for Name: t_t1_v1; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.t_t1_v1 VALUES ('r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC', false, '2026-11-02', 54, 'lunch');
INSERT INTO public.t_t1_v1 VALUES ('r_15D0YYA6VPYZ1XG6404XSGF9P0', true, '2026-11-03', 18, 'coffee');
INSERT INTO public.t_t1_v1 VALUES ('r_WR69B2FVJQ1FTTB6ACJBMWQ49N', false, '2026-11-04', 9, 'snack');
INSERT INTO public.t_t1_v1 VALUES ('r_T226J69Z95XDYC8Q9B84CZEQ0A', false, '2026-11-02', 32, 'taxi');
INSERT INTO public.t_t1_v1 VALUES ('r_X075V18D1AMV40A8CPGWMCGCVT', false, '2026-11-02', 54, 'lunch');


--
-- Data for Name: t_t1_v1__ver; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.t_t1_v1__ver VALUES ('r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC', 'f1', 9, NULL, 'insert', 11, 'f1', 0, NULL, NULL, '2026-11-02', NULL, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC', 'f3', 9, NULL, 'insert', 11, 'f3', 0, NULL, NULL, NULL, NULL, 'lunch');
INSERT INTO public.t_t1_v1__ver VALUES ('r_T226J69Z95XDYC8Q9B84CZEQ0A', 'f1', 13, NULL, 'insert', 15, 'f1', 0, NULL, NULL, '2026-11-02', NULL, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_T226J69Z95XDYC8Q9B84CZEQ0A', 'f3', 13, NULL, 'insert', 15, 'f3', 0, NULL, NULL, NULL, NULL, 'taxi');
INSERT INTO public.t_t1_v1__ver VALUES ('r_15D0YYA6VPYZ1XG6404XSGF9P0', 'f1', 17, NULL, 'insert', 19, 'f1', 0, NULL, NULL, '2026-11-03', NULL, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_15D0YYA6VPYZ1XG6404XSGF9P0', 'f2', 17, NULL, 'insert', 19, 'f2', 0, NULL, NULL, NULL, 18, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_15D0YYA6VPYZ1XG6404XSGF9P0', 'f3', 17, NULL, 'insert', 19, 'f3', 0, NULL, NULL, NULL, NULL, 'coffee');
INSERT INTO public.t_t1_v1__ver VALUES ('r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC', 'f2', 9, 21, 'insert', 11, 'f2', 0, NULL, NULL, NULL, 45, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC', 'f2', 21, NULL, 'correct', 23, 'f2', 0, NULL, NULL, NULL, 54, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_15D0YYA6VPYZ1XG6404XSGF9P0', 'existence', 25, NULL, 'revoke', 27, 'existence', 0, true, NULL, NULL, NULL, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_WR69B2FVJQ1FTTB6ACJBMWQ49N', 'f1', 29, NULL, 'insert', 31, 'f1', 0, NULL, NULL, '2026-11-04', NULL, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_WR69B2FVJQ1FTTB6ACJBMWQ49N', 'f2', 29, NULL, 'insert', 31, 'f2', 0, NULL, NULL, NULL, 9, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_WR69B2FVJQ1FTTB6ACJBMWQ49N', 'f3', 29, NULL, 'insert', 31, 'f3', 0, NULL, NULL, NULL, NULL, 'snack');
INSERT INTO public.t_t1_v1__ver VALUES ('r_WR69B2FVJQ1FTTB6ACJBMWQ49N', 'existence', 33, 37, 'revoke', 35, 'existence', 0, true, NULL, NULL, NULL, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_WR69B2FVJQ1FTTB6ACJBMWQ49N', 'existence', 37, NULL, 'revoke', 39, 'existence', 0, NULL, NULL, NULL, NULL, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_T226J69Z95XDYC8Q9B84CZEQ0A', 'f2', 13, 41, 'insert', 15, 'f2', 0, NULL, NULL, NULL, 30, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_T226J69Z95XDYC8Q9B84CZEQ0A', 'f2', 41, NULL, 'update', 43, 'f2', 0, NULL, NULL, NULL, 32, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_X075V18D1AMV40A8CPGWMCGCVT', 'f1', 76, NULL, 'insert', 78, 'f1', 0, NULL, NULL, '2026-11-02', NULL, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_X075V18D1AMV40A8CPGWMCGCVT', 'f2', 76, NULL, 'insert', 78, 'f2', 0, NULL, NULL, NULL, 54, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_X075V18D1AMV40A8CPGWMCGCVT', 'f3', 76, NULL, 'insert', 78, 'f3', 0, NULL, NULL, NULL, NULL, 'lunch');


--
-- Data for Name: t_t2_v1; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.t_t2_v1 VALUES ('e_WXAAKENGDMG892R1XX11VYKR6W', '2026-10-01', '2026-11-10', 'food', 5000);
INSERT INTO public.t_t2_v1 VALUES ('e_WXAAKENGDMG892R1XX11VYKR6W', '2026-11-10', NULL, 'food', 4000);


--
-- Data for Name: t_t2_v1__ver; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.t_t2_v1__ver VALUES ('e_WXAAKENGDMG892R1XX11VYKR6W', 'f1', '2026-10-01', NULL, 52, NULL, 'update', 54, 'f1', 0, NULL, NULL, 'food', NULL);
INSERT INTO public.t_t2_v1__ver VALUES ('e_WXAAKENGDMG892R1XX11VYKR6W', 'f2', '2026-10-01', NULL, 52, 55, 'update', 54, 'f2', 0, NULL, NULL, NULL, 5000);
INSERT INTO public.t_t2_v1__ver VALUES ('e_WXAAKENGDMG892R1XX11VYKR6W', 'f2', '2026-10-01', '2026-11-10', 55, NULL, 'update', 54, 'f2', 0, NULL, NULL, NULL, 5000);
INSERT INTO public.t_t2_v1__ver VALUES ('e_WXAAKENGDMG892R1XX11VYKR6W', 'f2', '2026-11-10', NULL, 55, NULL, 'update', 57, 'f2', 0, NULL, NULL, NULL, 4000);


--
-- Data for Name: t_t3_v1; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.t_t3_v1 VALUES ('r_VN6ZHQ4XDW34A24P9YSQYPQ5S4', false, 'app', 'k-2', 21);
INSERT INTO public.t_t3_v1 VALUES ('r_ZXQQZBZTZKVMZF3DR72Y0WPERW', false, 'app', 'k-1', 12);


--
-- Data for Name: t_t3_v1__ver; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.t_t3_v1__ver VALUES ('r_ZXQQZBZTZKVMZF3DR72Y0WPERW', 'f1', 62, NULL, 'update', 65, 'f1', 0, NULL, NULL, 'app', NULL, NULL);
INSERT INTO public.t_t3_v1__ver VALUES ('r_ZXQQZBZTZKVMZF3DR72Y0WPERW', 'f2', 62, NULL, 'update', 65, 'f2', 0, NULL, NULL, NULL, 'k-1', NULL);
INSERT INTO public.t_t3_v1__ver VALUES ('r_VN6ZHQ4XDW34A24P9YSQYPQ5S4', 'f1', 62, NULL, 'update', 66, 'f1', 0, NULL, NULL, 'app', NULL, NULL);
INSERT INTO public.t_t3_v1__ver VALUES ('r_VN6ZHQ4XDW34A24P9YSQYPQ5S4', 'f2', 62, NULL, 'update', 66, 'f2', 0, NULL, NULL, NULL, 'k-2', NULL);
INSERT INTO public.t_t3_v1__ver VALUES ('r_VN6ZHQ4XDW34A24P9YSQYPQ5S4', 'f3', 62, NULL, 'update', 66, 'f3', 0, NULL, NULL, NULL, NULL, 21);
INSERT INTO public.t_t3_v1__ver VALUES ('r_ZXQQZBZTZKVMZF3DR72Y0WPERW', 'f3', 62, 67, 'update', 65, 'f3', 0, NULL, NULL, NULL, NULL, 10);
INSERT INTO public.t_t3_v1__ver VALUES ('r_ZXQQZBZTZKVMZF3DR72Y0WPERW', 'f3', 67, NULL, 'update', 69, 'f3', 0, NULL, NULL, NULL, NULL, 12);


--
-- Data for Name: t_t4_v1; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.t_t4_v1 VALUES ('r_DF4P6XP854WAKJA5KCZCN2K4F1', false, 'half of lunch', 'r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC');


--
-- Data for Name: t_t4_v1__ver; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.t_t4_v1__ver VALUES ('r_DF4P6XP854WAKJA5KCZCN2K4F1', 'f1', 49, NULL, 'insert', 51, 'f1', 0, NULL, NULL, 'half of lunch', NULL);
INSERT INTO public.t_t4_v1__ver VALUES ('r_DF4P6XP854WAKJA5KCZCN2K4F1', 'f2', 49, NULL, 'insert', 51, 'f2', 0, NULL, NULL, NULL, 'r_4GNBSJ2K6QZQ0A2E0MZSSGYNKC');


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

\unrestrict 8Hhpk0LJ26pplc2CbDANO2lFIYGj8e9otW7fUgVNFPHhdpCuCz66wUV6joFchk8

