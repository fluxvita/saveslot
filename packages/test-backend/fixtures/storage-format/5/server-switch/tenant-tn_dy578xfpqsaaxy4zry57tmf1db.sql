--
-- PostgreSQL database dump
--

\restrict tnYPUEQJM3QRdQVGNReYmlzsWc81UZlobFmx21EjYDg5KoaW6iQE6tPbcnmRd9q

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

INSERT INTO public.base_sources VALUES (11, 'r_C4WC0TZ9MW9KV39M6FM7M2BGEW', 'f1', 0, 0, 'value', 10, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (11, 'r_C4WC0TZ9MW9KV39M6FM7M2BGEW', 'f2', 0, 0, 'value', 10, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (11, 'r_C4WC0TZ9MW9KV39M6FM7M2BGEW', 'f3', 0, 0, 'value', 10, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (15, 'r_50D60TYRBBBBC4YYA5JR7XPFQC', 'f1', 0, 0, 'value', 14, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (15, 'r_50D60TYRBBBBC4YYA5JR7XPFQC', 'f2', 0, 0, 'value', 14, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (15, 'r_50D60TYRBBBBC4YYA5JR7XPFQC', 'f3', 0, 0, 'value', 14, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (19, 'r_XKM34Y62T0YDHRY8NEE15FJ0QK', 'f1', 0, 0, 'value', 18, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (19, 'r_XKM34Y62T0YDHRY8NEE15FJ0QK', 'f2', 0, 0, 'value', 18, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (19, 'r_XKM34Y62T0YDHRY8NEE15FJ0QK', 'f3', 0, 0, 'value', 18, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (23, 'r_C4WC0TZ9MW9KV39M6FM7M2BGEW', 'f2', 0, 0, 'value', 22, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (27, 'r_XKM34Y62T0YDHRY8NEE15FJ0QK', 'existence', 0, 0, 'operation', 26, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (31, 'r_T85ET4XD7CJG6DYYPF7TXJ32S4', 'f1', 0, 0, 'value', 30, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (31, 'r_T85ET4XD7CJG6DYYPF7TXJ32S4', 'f2', 0, 0, 'value', 30, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (31, 'r_T85ET4XD7CJG6DYYPF7TXJ32S4', 'f3', 0, 0, 'value', 30, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (35, 'r_T85ET4XD7CJG6DYYPF7TXJ32S4', 'existence', 0, 0, 'operation', 34, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[{"op":37,"valid":[{"from":null,"to":null}]}]', NULL, NULL);
INSERT INTO public.base_sources VALUES (39, 'r_T85ET4XD7CJG6DYYPF7TXJ32S4', 'existence', 0, 0, 'operation', 38, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (43, 'r_50D60TYRBBBBC4YYA5JR7XPFQC', 'f2', 0, 0, 'value', 42, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (51, 'r_Q4GGB4SGJ8C2HAYPACA4F35J5P', 'f1', 0, 0, 'value', 50, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (51, 'r_Q4GGB4SGJ8C2HAYPACA4F35J5P', 'f2', 0, 0, 'value', 50, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (54, 'e_A0WPAB33GA6A9KGT7CK6B0V7NP', 'f1', 0, 0, 'value', 53, NULL, NULL, NULL, NULL, 'applied', '2026-10-01', NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (54, 'e_A0WPAB33GA6A9KGT7CK6B0V7NP', 'f1', 0, 1, 'interval', 53, NULL, NULL, NULL, NULL, 'applied', '2026-10-01', NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (54, 'e_A0WPAB33GA6A9KGT7CK6B0V7NP', 'f2', 0, 0, 'value', 53, NULL, NULL, NULL, NULL, 'applied', '2026-10-01', NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (54, 'e_A0WPAB33GA6A9KGT7CK6B0V7NP', 'f2', 0, 1, 'interval', 53, NULL, NULL, NULL, NULL, 'applied', '2026-10-01', NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (57, 'e_A0WPAB33GA6A9KGT7CK6B0V7NP', 'f2', 0, 0, 'value', 56, NULL, NULL, NULL, NULL, 'applied', '2026-11-10', NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (57, 'e_A0WPAB33GA6A9KGT7CK6B0V7NP', 'f2', 0, 1, 'interval', 56, NULL, NULL, NULL, NULL, 'applied', '2026-11-10', NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (65, 'r_CNBK4Y7984NPCYQ612C00Z4GV3', 'f1', 0, 0, 'value', 63, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (65, 'r_CNBK4Y7984NPCYQ612C00Z4GV3', 'f2', 0, 0, 'value', 63, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (65, 'r_CNBK4Y7984NPCYQ612C00Z4GV3', 'f3', 0, 0, 'value', 63, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (66, 'r_CBA9K83Z66TNQJJ6Z0QM703JFP', 'f1', 0, 0, 'value', 64, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (66, 'r_CBA9K83Z66TNQJJ6Z0QM703JFP', 'f2', 0, 0, 'value', 64, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (66, 'r_CBA9K83Z66TNQJJ6Z0QM703JFP', 'f3', 0, 0, 'value', 64, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (69, 'r_CNBK4Y7984NPCYQ612C00Z4GV3', 'f3', 0, 0, 'value', 68, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (78, 'r_047CXK0KKCHDC8T7TT1ZNG3F7R', 'f1', 0, 0, 'value', 77, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (78, 'r_047CXK0KKCHDC8T7TT1ZNG3F7R', 'f2', 0, 0, 'value', 77, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (78, 'r_047CXK0KKCHDC8T7TT1ZNG3F7R', 'f3', 0, 0, 'value', 77, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);


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

INSERT INTO public.catalog VALUES ('t5', 1, 'sl_BYREFGP1VJ4RR4G4', '{"description":"what was spent each day","fields":[{"description":"the day","id":"f1","name":"day","type":"date"},{"description":"the sum","id":"f2","name":"total","type":"integer"},{"description":"how many","id":"f3","name":"n","type":"integer"}],"id":"t5","kind":"derived","name":"spent_by_day","rule":{"depends_on":[{"field":"f1","table":"t1"},{"field":"f2","table":"t1"}],"id":"r1","rsql":"rsql@1","scope":{"key":["f1"],"key_from_free_text":false,"kind":"group"},"sql":"SELECT \"t1\".\"f1\" AS \"f1\", CAST(sum(\"t1\".\"f2\") AS bigint) AS \"f2\", count(*) AS \"f3\" FROM \"t1\" GROUP BY 1","time_dependency":"bucketed","version":1}}', NULL, NULL);
INSERT INTO public.catalog VALUES ('t1', 1, 'sl_BYREFGP1VJ4RR4G4', '{"description":"one row per expense","fields":[{"description":"the day","id":"f1","name":"date","required":true,"type":"date"},{"description":"how much, in yuan","id":"f2","name":"amount","type":"integer"},{"description":"what for","id":"f3","name":"note","type":"text"}],"id":"t1","kind":"base","name":"expenses","time":{"field":"f1","type":"event"}}', NULL, NULL);
INSERT INTO public.catalog VALUES ('t2', 1, 'sl_BYREFGP1VJ4RR4G4', '{"description":"a monthly budget by kind","entity_key":["f1"],"fields":[{"description":"what the budget is for","id":"f1","name":"kind","required":true,"type":"text"},{"description":"the budget, in yuan","id":"f2","name":"amount","required":true,"type":"integer"}],"id":"t2","kind":"base","name":"budgets","time":{"granularity":"date","type":"state"}}', NULL, NULL);
INSERT INTO public.catalog VALUES ('t3', 1, 'sl_BYREFGP1VJ4RR4G4', '{"description":"rides from an app","external_key":["f1","f2"],"fields":[{"description":"the app","id":"f1","name":"origin","type":"text"},{"description":"its ID there","id":"f2","name":"external_id","type":"text"},{"description":"how much","id":"f3","name":"fare","type":"integer"}],"id":"t3","kind":"base","name":"rides","time":{"type":"none"}}', NULL, NULL);
INSERT INTO public.catalog VALUES ('t4', 1, 'sl_BYREFGP1VJ4RR4G4', '{"description":"one row per refund of an expense","fields":[{"description":"why","id":"f1","name":"note","required":true,"type":"text"},{"description":"the expense refunded","id":"f2","name":"expense","ref":{"table":"t1","target":"row"},"type":"ref"}],"id":"t4","kind":"base","name":"refunds","time":{"type":"none"}}', NULL, NULL);
INSERT INTO public.catalog VALUES ('t1', 2, 'sl_BYREFGP1VJ4RR4G4', '{"description":"one row per expense","duplicate_keys":[["f1","f3"]],"fields":[{"description":"the day","id":"f1","name":"date","required":true,"type":"date"},{"description":"how much, in yuan","id":"f2","name":"amount","type":"integer"},{"description":"what for","id":"f3","name":"note","type":"text"}],"id":"t1","kind":"base","name":"expenses","time":{"field":"f1","type":"event"}}', NULL, NULL);
INSERT INTO public.catalog VALUES ('t2', 2, 'sl_BYREFGP1VJ4RR4G4', '{"description":"a monthly budget by kind","entity_key":["f1"],"fields":[{"description":"what the budget is for","id":"f1","name":"kind","required":true,"type":"text"},{"description":"the budget, in yuan","id":"f2","name":"amount","required":true,"type":"integer"}],"id":"t2","kind":"base","name":"budgets","time":{"granularity":"date","type":"state"}}', NULL, NULL);
INSERT INTO public.catalog VALUES ('t4', 2, 'sl_BYREFGP1VJ4RR4G4', '{"description":"one row per refund of an expense","fields":[{"description":"why","id":"f1","name":"note","required":true,"type":"text"},{"description":"the expense refunded","id":"f2","name":"expense","ref":{"table":"t1","target":"row"},"type":"ref"}],"id":"t4","kind":"base","name":"refunds","time":{"type":"none"}}', NULL, NULL);
INSERT INTO public.catalog VALUES ('t5', 2, 'sl_BYREFGP1VJ4RR4G4', '{"description":"what was spent each day","fields":[{"description":"the day","id":"f1","name":"day","type":"date"},{"description":"the sum","id":"f2","name":"total","type":"integer"},{"description":"how many","id":"f3","name":"n","type":"integer"}],"id":"t5","kind":"derived","name":"spent_by_day","rule":{"depends_on":[{"field":"f1","table":"t1"},{"field":"f2","table":"t1"}],"id":"r1","rsql":"rsql@1","scope":{"key":["f1"],"key_from_free_text":false,"kind":"group"},"sql":"SELECT \"t1\".\"f1\" AS \"f1\", CAST(sum(\"t1\".\"f2\") AS bigint) AS \"f2\", count(*) AS \"f3\" FROM \"t1\" GROUP BY 1","time_dependency":"bucketed","version":1}}', NULL, NULL);


--
-- Data for Name: content; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.content VALUES (1, 'system', '{"kind":"system","principal":"system"}', 'a2a35fe2925b9b16c34e619069b782461a1ed680a95a60d70eeb5ce5f88ce770', NULL, NULL, NULL);
INSERT INTO public.content VALUES (1, 'tenant', '{"event_format":1,"storage_format":5,"tenant_id":"tn_DY578XFPQSAAXY4ZRY57TMF1DB"}', '9a60a51188ad3515889655c29a44b71c02ede14300c4806d23db6692e7792c27', NULL, NULL, NULL);
INSERT INTO public.content VALUES (1, 'user', '{"kind":"user","principal":"u_56KR08SH4FN38WQ94ZVTTS80BE"}', 'd0c376b0099746c3c893733486cde286b4fd82d89599d03b5bee26ca0d79fe1d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (2, 'ctx', '{"now":"2026-11-26T10:24:00.803Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', 'b91f47d3c823ee7c7440c503853a660ef2076ff297aa5d673f06f25ece74b481', NULL, NULL, NULL);
INSERT INTO public.content VALUES (2, 'draft', '{"base_version":null,"slot":"household","tables":[{"description":"one row per expense","fields":[{"description":"the day","name":"date","required":true,"type":"date"},{"description":"how much, in yuan","name":"amount","type":"integer"},{"description":"what for","name":"note","type":"text"}],"kind":"base","name":"expenses","time":{"field":"date","type":"event"}},{"description":"a monthly budget by kind","entity_key":["kind"],"fields":[{"description":"what the budget is for","name":"kind","required":true,"type":"text"},{"description":"the budget, in yuan","name":"amount","required":true,"type":"integer"}],"kind":"base","name":"budgets","time":{"granularity":"date","type":"state"}},{"description":"rides from an app","external_key":["origin","external_id"],"fields":[{"description":"the app","name":"origin","type":"text"},{"description":"its ID there","name":"external_id","type":"text"},{"description":"how much","name":"fare","type":"integer"}],"kind":"base","name":"rides","time":{"type":"none"}},{"description":"one row per refund of an expense","fields":[{"description":"why","name":"note","required":true,"type":"text"},{"description":"the expense refunded","name":"expense","ref":{"table":"expenses","target":"row"},"type":"ref"}],"kind":"base","name":"refunds","time":{"type":"none"}},{"description":"what was spent each day","fields":[{"description":"the day","name":"day"},{"description":"the sum","name":"total"},{"description":"how many","name":"n"}],"kind":"derived","name":"spent_by_day","rule":{"sql":"SELECT date AS day, sum(amount) AS total, count(*) AS n FROM expenses GROUP BY 1","time_dependency":"bucketed"}}],"timezone":"Asia/Shanghai"}', '6445068c0f251c0434a5deb3094dc975f2eabd6b2db0798f06876a7f4497f1b6', NULL, NULL, NULL);
INSERT INTO public.content VALUES (2, 'request_key', '{"key":"80d4b84b03821b8faa3a3605a5c826e8a8d2ac0603f295314f944d8d1f548cdd"}', '093ebad463daac33885beaef45229c6345666978f8adfdc5c5803fd042f744bf', NULL, NULL, NULL);
INSERT INTO public.content VALUES (2, 'target', '{"creates_slot":true,"draft_id":"d_53A1MTZ4XX93YYEM"}', 'd70b8b1dc62bf0389e983de41036ca30ba5f0413023b44bc30a3595d23462d26', NULL, NULL, NULL);
INSERT INTO public.content VALUES (3, 'changes', '[{"auto":true,"change":"create_slot","class":"create","compatible_with_old_writes":true,"destructive":false,"target":{"slot":true}},{"auto":true,"change":"add_table","class":"create","compatible_with_old_writes":true,"destructive":false,"target":{"table":"t1"}},{"auto":true,"change":"add_table","class":"create","compatible_with_old_writes":true,"destructive":false,"target":{"table":"t2"}},{"auto":true,"change":"add_table","class":"create","compatible_with_old_writes":true,"destructive":false,"target":{"table":"t3"}},{"auto":true,"change":"add_table","class":"create","compatible_with_old_writes":true,"destructive":false,"target":{"table":"t4"}},{"auto":true,"change":"add_derived_table","class":"create","compatible_with_old_writes":true,"destructive":false,"target":{"table":"t5"}}]', '7693e6615a0b0b02e421cfc07d012ee09421e5b1c3597b0698dcf4214e131875', NULL, NULL, NULL);
INSERT INTO public.content VALUES (3, 'compiled', '{"compiler":1,"name":"household","rsql":"rsql@1","slot":"sl_BYREFGP1VJ4RR4G4","sv":1,"tables":[{"description":"one row per expense","fields":[{"description":"the day","id":"f1","name":"date","required":true,"type":"date"},{"description":"how much, in yuan","id":"f2","name":"amount","type":"integer"},{"description":"what for","id":"f3","name":"note","type":"text"}],"id":"t1","kind":"base","name":"expenses","physical":{"table":"t_t1_v1"},"time":{"field":"f1","type":"event"}},{"description":"a monthly budget by kind","entity_key":["f1"],"fields":[{"description":"what the budget is for","id":"f1","name":"kind","required":true,"type":"text"},{"description":"the budget, in yuan","id":"f2","name":"amount","required":true,"type":"integer"}],"id":"t2","kind":"base","name":"budgets","physical":{"table":"t_t2_v1"},"time":{"granularity":"date","type":"state"}},{"description":"rides from an app","external_key":["f1","f2"],"fields":[{"description":"the app","id":"f1","name":"origin","type":"text"},{"description":"its ID there","id":"f2","name":"external_id","type":"text"},{"description":"how much","id":"f3","name":"fare","type":"integer"}],"id":"t3","kind":"base","name":"rides","physical":{"table":"t_t3_v1"},"time":{"type":"none"}},{"description":"one row per refund of an expense","fields":[{"description":"why","id":"f1","name":"note","required":true,"type":"text"},{"description":"the expense refunded","id":"f2","name":"expense","ref":{"table":"t1","target":"row"},"type":"ref"}],"id":"t4","kind":"base","name":"refunds","physical":{"table":"t_t4_v1"},"time":{"type":"none"}},{"description":"what was spent each day","fields":[{"description":"the day","id":"f1","name":"day","type":"date"},{"description":"the sum","id":"f2","name":"total","type":"integer"},{"description":"how many","id":"f3","name":"n","type":"integer"}],"id":"t5","kind":"derived","name":"spent_by_day","physical":{"table":"d_t5_v1"},"rule":{"depends_on":[{"field":"f1","table":"t1"},{"field":"f2","table":"t1"}],"id":"r1","rsql":"rsql@1","scope":{"key":["f1"],"key_from_free_text":false,"kind":"group"},"sql":"SELECT \"t1\".\"f1\" AS \"f1\", CAST(sum(\"t1\".\"f2\") AS bigint) AS \"f2\", count(*) AS \"f3\" FROM \"t1\" GROUP BY 1","time_dependency":"bucketed","version":1}}],"timezone":"Asia/Shanghai"}', '9aad45e7429e2f95a0326cb42da67a3717ad7f1dccf2270e4e6ce5ff8418f90a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (3, 'target', '{"draft_id":"d_53A1MTZ4XX93YYEM","outcome":"applied","target_version":1}', 'ae86c2dabaa6f8f86afdacf744afb18e595dd7aebc9586f74717c6836020d0ce', NULL, NULL, NULL);
INSERT INTO public.content VALUES (4, 'target', '{"by":"auto","draft_id":"d_53A1MTZ4XX93YYEM","target_version":1}', 'fb5fa4accdcf419a73e8a74623f801829232a18d5b9e261188897de0f27f46e4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (5, 'policy', '{"auto_apply":["add_table","add_derived_table","add_optional_field","description","rename_unused","loosen_constraint","duplicate_keys","restructure_unused"],"effective_value_rule":"keep_current","high_impact":[],"policy_version":1,"rank":{"agent_inferred":1,"miss":0,"user_stated":2},"user_session_only":[]}', '41f24c1878d2f9158397f7d9f675bdff962fb35398d8e890b3c0189f76a21363', NULL, NULL, NULL);
INSERT INTO public.content VALUES (6, 'target', '{"draft_id":"d_53A1MTZ4XX93YYEM","rebuilt_tables":[],"to_version":1}', '90a345ca04cef963e960813d22bd8cdacade130f81893cfcdce09d7b43bfa9de', NULL, NULL, NULL);
INSERT INTO public.content VALUES (7, 'ctx', '{"now":"2026-11-26T10:24:00.817Z","ruleset_version":1}', '0cfc8a28d7a8c4e2e7356c3eb30158c559f69126dc995821545207443ff44fae', NULL, NULL, NULL);
INSERT INTO public.content VALUES (7, 'name', '{"name":"sample agent"}', '0957e5e5000dc767fb05ce8147d97d2657ac9a78f515adbc977be857b71de0d1', NULL, NULL, NULL);
INSERT INTO public.content VALUES (7, 'principal', '{"kind":"connection","principal":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","scopes":["saveslot.read","saveslot.write","saveslot.schema"],"via":"token"}', '394480c6b55876d0737b479d2833b3c7e2b6b5c4b1e1de6f5d8a82b98848bf0a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (8, 'ctx', '{"now":"2026-11-26T10:24:00.818Z","ruleset_version":1}', '21dc10062a4909b94deffd0010cee66971529b84187f119cd273ad78b30ccb5f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (8, 'name', '{"name":"another agent"}', '95f97e5914d91f1ab0571d876aed20feb5977513c223d29b3d6c4ecf9f84847e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (8, 'principal', '{"kind":"connection","principal":"ci_MQ1E9ZQKDSK2NPCKTM2CSHEVSB","scopes":["saveslot.read","saveslot.write","saveslot.schema"],"via":"token"}', '7109543ed4e57b19a0f4ef2cef892e89d3b24763933e036e857b79b6c93f9c63', NULL, NULL, NULL);
INSERT INTO public.content VALUES (9, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-26T10:24:00.820Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', '33a3f5507a7337ed9be553e43264c83974a13bbc54f8144d2164a6c8b338160f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (9, 'ops/0/set/f1', '"2026-11-02"', 'bb1de3879fc3904da5b8b20834d8d58eac44c618f8305a7357557ae506daf77f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (9, 'ops/0/set/f2', '"45"', '2eecac45827ede372449b7bd78a82139db639d810ebce98caef91e5d1a2fe422', NULL, NULL, NULL);
INSERT INTO public.content VALUES (9, 'ops/0/set/f3', '"lunch"', '861315d6dc2fae3332121172cefb27dbbc4f45d0422d6c7a700e861baadf4f8d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (9, 'ops/0/target', '{"created":true,"intent":"insert","row":"r_C4WC0TZ9MW9KV39M6FM7M2BGEW","table":"t1"}', '082511ac4b3ef5c12bde05dfa0b9543b9c83054207beb68df4805acd39110892', NULL, NULL, NULL);
INSERT INTO public.content VALUES (9, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (9, 'request_key', '{"key":"395dd48c9a5877ff423ab7c2ab0474645a31c4c1248afcf07d40ba7040b4354a"}', '58eddcfc11df5469f22151d2da76b9fb56a384a28064f83106461cda94f52aab', NULL, NULL, NULL);
INSERT INTO public.content VALUES (10, 'target', '{"kind":"user_message","level":"user_stated","source_id":"s_0GTPPFQZV4Y8YBA0"}', '9966b74dacb56429a0b3514fb229d881dcf02bc3a07b1362fe00903f21523181', NULL, NULL, NULL);
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
INSERT INTO public.content VALUES (11, 'target', '{"cause":"request","created":true,"intent":"insert","op_index":0,"row":"r_C4WC0TZ9MW9KV39M6FM7M2BGEW","sv":1,"table":"t1"}', 'fe7a76d9af82ba892e11f1db8f96fb89ca123035c79fbb536bfbefd7f8f71de7', NULL, NULL, NULL);
INSERT INTO public.content VALUES (12, 'checksum', '{"checksum":"47747ef5d44f61b2b8d2bca0722b3bccbd836a4860e44353c624370fb2e57386"}', '527f6e06439803548234e5f825f437597b39c7ff2a494893e5c624bef97bfb98', NULL, NULL, NULL);
INSERT INTO public.content VALUES (12, 'key', '{"values":["2026-11-02"]}', 'cc51a7db3e7d0a58c48bf5231237b844def245dd03281bd3f72ded939cff012c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (12, 'target', '{"emptied":false,"partition":"p_1A6GGZGCVMBPEGH2","read_pos":11,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', 'ddb62b59c364aced98ded11c936a3296369da37403cc06e8012eccca294ccf8a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (13, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-26T10:24:00.830Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', 'a1b7497e256381a2e1deccf56f41e60ba58e80ea3cd030c9e480aff60a2b4645', NULL, NULL, NULL);
INSERT INTO public.content VALUES (13, 'ops/0/set/f1', '"2026-11-02"', 'bb1de3879fc3904da5b8b20834d8d58eac44c618f8305a7357557ae506daf77f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (13, 'ops/0/set/f2', '"30"', 'f20e4586c63ba3b2c06a97c4e585acea4a2977c3d8d81dc2d1f2275439ad90a7', NULL, NULL, NULL);
INSERT INTO public.content VALUES (13, 'ops/0/set/f3', '"taxi"', '7a064c2491cc802c8ed3d43507560ab951779574b21991954294405e57be3745', NULL, NULL, NULL);
INSERT INTO public.content VALUES (13, 'ops/0/target', '{"created":true,"intent":"insert","row":"r_50D60TYRBBBBC4YYA5JR7XPFQC","table":"t1"}', '7db0beaacfed566e4a05c927f01562245fac7813644fc4db57fea962cee0af82', NULL, NULL, NULL);
INSERT INTO public.content VALUES (13, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (13, 'request_key', '{"key":"a89a10deec681c134fcdc303ff30e822fc4e6d7d9ff33fdec5103cfb62626f92"}', 'd6bd9a45740e27f1abe49f1f8abf3f244a1dc67c4174f1b9e7870819fd51134c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (14, 'request', '{"intent":"insert","set":{"amount":30,"date":"2026-11-02","note":"taxi"},"table":"household.expenses"}', 'd9e9ed8dd8d23adf88d6185adafe2254e272a0ecd451d4e2f45bce543f3bfada', NULL, NULL, NULL);
INSERT INTO public.content VALUES (14, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_1KKJ8ZF4WKZARZ6M"}', '98fc70e91d4deccfc1d2f9fdbe424b62279bff6e235ab7a6c1e5e95bace1a5b5', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'fields/f1/0', '{"status":"applied","value":"2026-11-02"}', '96a119bb0a7bc53bfaa2b66ba49a944c8959ef63f8218c5af954c7f093c803a2', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'fields/f2/0', '{"status":"applied","value":"30"}', '1712bdc8cfafa74ec9f72dc98448d3d1c62b78b6a7e3151d98154cd62872d59e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'fields/f3/0', '{"status":"applied","value":"taxi"}', 'ca8af995f357da958ad27752fa8f8064ea0cccc9ebbc49097f1b971e69a186d4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'literal/f1/0', '{"segments":[{"result":"na","source":14}]}', 'e05b307243777b6813b055f65fdf8e07b3fc003f3f4cfe5c8d252c266a522d97', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'literal/f2/0', '{"segments":[{"result":"na","source":14}]}', 'e05b307243777b6813b055f65fdf8e07b3fc003f3f4cfe5c8d252c266a522d97', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'literal/f3/0', '{"segments":[{"result":"na","source":14}]}', 'e05b307243777b6813b055f65fdf8e07b3fc003f3f4cfe5c8d252c266a522d97', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'sources/f1/0', '[{"kind":"value","source":14}]', '0c2e432acf8d5e0ebb8b3ccff0fa23f57b1788d2c11a8b7dd55c5a4df69c37b0', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'sources/f2/0', '[{"kind":"value","source":14}]', '0c2e432acf8d5e0ebb8b3ccff0fa23f57b1788d2c11a8b7dd55c5a4df69c37b0', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'sources/f3/0', '[{"kind":"value","source":14}]', '0c2e432acf8d5e0ebb8b3ccff0fa23f57b1788d2c11a8b7dd55c5a4df69c37b0', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'target', '{"cause":"request","created":true,"intent":"insert","op_index":0,"row":"r_50D60TYRBBBBC4YYA5JR7XPFQC","sv":1,"table":"t1"}', 'd422964fda6e45887f302c23d1d4ae3b8581f1050719a4b931bc51c05b0eaa64', NULL, NULL, NULL);
INSERT INTO public.content VALUES (16, 'checksum', '{"checksum":"02cfce4fdae133910f70340dd233e8f0bba42d37f0c5d998442390dfdbb426f0"}', '8466d6b60445e9f1e7b0d5a4efd5d66ec181a0111ebfbce9da69eff2891cc0b3', NULL, NULL, NULL);
INSERT INTO public.content VALUES (16, 'target', '{"emptied":false,"partition":"p_1A6GGZGCVMBPEGH2","read_pos":15,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', 'c07822f490760308e9d769d68b9945d5cd34dedaf6277dfa6f21a1e698874c7a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (17, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-26T10:24:00.837Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', 'cc1775083022eeeab4b9d7b9db22a9b13ab3045ddddd611f083f04b4735705c3', NULL, NULL, NULL);
INSERT INTO public.content VALUES (17, 'ops/0/set/f1', '"2026-11-03"', 'd658e2a3b5597fab6e1c619fb80cdf08d37763c2d403667798cddcf65eeccb97', NULL, NULL, NULL);
INSERT INTO public.content VALUES (17, 'ops/0/set/f2', '"18"', '0234a350f4d56ae45c5ece57b08c54496f372bc570bd83a465fb6d2d85531479', NULL, NULL, NULL);
INSERT INTO public.content VALUES (17, 'ops/0/set/f3', '"coffee"', '0f52baaa23b045e196e5c8bffd06442c98eca166ca9d77582ce939d5f1b67a7d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (17, 'ops/0/target', '{"created":true,"intent":"insert","row":"r_XKM34Y62T0YDHRY8NEE15FJ0QK","table":"t1"}', 'd997c51b35261eb47b10adc8bb98ea693c36d62b2355404a2280c6dbcaa3046b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (17, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (17, 'request_key', '{"key":"c6ce38606c6dd025d60da5d6fb71675d4b1b42b851990862c1e8da0673eb763e"}', 'a36b2d0a3513164f29cc0d7b5efe70b663c75a24446d490276016dcca03a738a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (18, 'request', '{"intent":"insert","set":{"amount":18,"date":"2026-11-03","note":"coffee"},"table":"household.expenses"}', '6da0ef3e89920647fdb115c80b2a013c88124bcb6196612e78670c5eae4d9692', NULL, NULL, NULL);
INSERT INTO public.content VALUES (18, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_W51J7R3BJP0BZ0DQ"}', '7e7e016af74b116225b645f758b024781bd1f48231ff9bf55b8c8e9dfbeee03f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'fields/f1/0', '{"status":"applied","value":"2026-11-03"}', '54dff293fa73477624b85fd869155a45261fa9df38233ae3c67233b985538f91', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'fields/f2/0', '{"status":"applied","value":"18"}', '751b79871b4d159bc5c227b5a148469189fbce2f626be069f2569073af35daaa', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'fields/f3/0', '{"status":"applied","value":"coffee"}', '24ee69f41a25745b6cdb4e2910f9a6041cd302067b02f167fdc0e0e95f137c02', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'literal/f1/0', '{"segments":[{"result":"na","source":18}]}', '4a58ed960a93a8baf068beb9c9dc53968928ddc2e4c32292bb87467a49116653', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'literal/f2/0', '{"segments":[{"result":"na","source":18}]}', '4a58ed960a93a8baf068beb9c9dc53968928ddc2e4c32292bb87467a49116653', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'literal/f3/0', '{"segments":[{"result":"na","source":18}]}', '4a58ed960a93a8baf068beb9c9dc53968928ddc2e4c32292bb87467a49116653', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'sources/f1/0', '[{"kind":"value","source":18}]', '319b9de0cbecc6b80f3925d4ca8167b0a3934443f98d4627237125576b1ae684', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'sources/f2/0', '[{"kind":"value","source":18}]', '319b9de0cbecc6b80f3925d4ca8167b0a3934443f98d4627237125576b1ae684', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'sources/f3/0', '[{"kind":"value","source":18}]', '319b9de0cbecc6b80f3925d4ca8167b0a3934443f98d4627237125576b1ae684', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'target', '{"cause":"request","created":true,"intent":"insert","op_index":0,"row":"r_XKM34Y62T0YDHRY8NEE15FJ0QK","sv":1,"table":"t1"}', '0736f92fefed0d5b51af98fec13c55d16e19a7b8caa608c2932003a44886005c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (20, 'checksum', '{"checksum":"2fdb99b9e376a0eeb9374c90106ded3f433d35bc1a11400eea77fa992ffc1b74"}', '2b6486c5a4c6121ac9f7a151dd594635971ef3202c83a53472eee255f03746ef', NULL, NULL, NULL);
INSERT INTO public.content VALUES (20, 'key', '{"values":["2026-11-03"]}', '197cbb7c11daaeba4de02e882703c19e248a409995fb839b5ad392c09d93f8dd', NULL, NULL, NULL);
INSERT INTO public.content VALUES (20, 'target', '{"emptied":false,"partition":"p_RCBX19D6XW61VY3W","read_pos":19,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', '19c53c980ead577a29a9461b885ca7f15cd2fc53c1f449aadf62f07ec41f7e87', NULL, NULL, NULL);
INSERT INTO public.content VALUES (21, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-26T10:24:00.844Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', '7bc237df43d093ef44c67e26a12f047d60926c07be806ee4109e14d962cac2f3', NULL, NULL, NULL);
INSERT INTO public.content VALUES (21, 'ops/0/set/f2', '"54"', '6ce1ced1ac1f56f8cd7ee5c55d117fe99c805b89a603e36c41852fea49853068', NULL, NULL, NULL);
INSERT INTO public.content VALUES (21, 'ops/0/target', '{"intent":"correct","row":"r_C4WC0TZ9MW9KV39M6FM7M2BGEW","table":"t1","ver":{"basis":"explicit","current":true,"op":9,"restore_count":0}}', 'ed2e4a78152cee93c3dd9698abe6006f61e9ab9dda11ac967f887cc1246e6a47', NULL, NULL, NULL);
INSERT INTO public.content VALUES (21, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (21, 'request_key', '{"key":"ed30af8ca1525cf9c855d2f260c45796932b237d262fbb7a6f8724755201f439"}', 'b486bf510faa34ce3b76dd6f2f172f3be4a5870f7835aa3d9b47f1a9e42c9766', NULL, NULL, NULL);
INSERT INTO public.content VALUES (22, 'target', '{"kind":"user_message","level":"user_stated","source_id":"s_GH58NAEE6B0YZ0CT"}', '83b9834ec728bb9045df28032335fcad89f5527dbe687c41ab459b1e799de3c1', NULL, NULL, NULL);
INSERT INTO public.content VALUES (22, 'text', '{"text":"sorry, lunch was 54"}', '09db22c6ce9b888483906e0876b820f9021653c803cd9a16790a11f4e740081b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (23, 'fields/f2/0', '{"status":"applied","value":"54"}', '3066d5922eca1709cab4c55d047596dc085c9289eb0e69902f10bdafc414ee89', NULL, NULL, NULL);
INSERT INTO public.content VALUES (23, 'literal/f2/0', '{"segments":[{"result":"hit","source":22}]}', '4f71b5712c5b41e18380034068b347aebb77c5689a10fd56ecdb06563ff837e8', NULL, NULL, NULL);
INSERT INTO public.content VALUES (23, 'sources/f2/0', '[{"kind":"value","source":22}]', '6dbed4dff6a4840169d6cfbd4eb235fde4756a6ffdd1b298f89c0adababc0022', NULL, NULL, NULL);
INSERT INTO public.content VALUES (23, 'target', '{"cause":"request","intent":"correct","op_index":0,"row":"r_C4WC0TZ9MW9KV39M6FM7M2BGEW","sv":1,"table":"t1"}', 'b60f279716ad01826e4d66e529fd94e6d2ddbeced197107b445db60cbf285cf9', NULL, NULL, NULL);
INSERT INTO public.content VALUES (24, 'checksum', '{"checksum":"3eaa57f629c2a16acdfd512fb6ff4bec8d27f9ae97841034db8e35931425ff82"}', '39adea92dc1a7ba45beaca0e29d34ad976f8b8c60620a2631154d90778de98cb', NULL, NULL, NULL);
INSERT INTO public.content VALUES (24, 'target', '{"emptied":false,"partition":"p_1A6GGZGCVMBPEGH2","read_pos":23,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', '61793ad326654ec48cdcc0bf07eb571c11f260f6ce806d9a6c3fc6647db4800f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (25, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-26T10:24:00.851Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', 'f9fd5467ad8cd96e9a006836b11b2056ebf3489821a09b128872da29316a64e8', NULL, NULL, NULL);
INSERT INTO public.content VALUES (25, 'ops/0/target', '{"intent":"revoke","row":"r_XKM34Y62T0YDHRY8NEE15FJ0QK","table":"t1","ver":{"basis":"explicit","current":true,"op":17,"restore_count":0}}', 'eea2c4c5d8a75ca5806df72e3372698950ddaef4f90868c39c038afaf5836afa', NULL, NULL, NULL);
INSERT INTO public.content VALUES (25, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (25, 'request_key', '{"key":"5f54188eff6a1ba8a4c08afc74c3f0104e5034f322c4ff71bb6ffd83c19e878a"}', 'e3b481fd98bd79461aa4c54bb7d892990f48c9303656439f88ba10b31586f8e4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (26, 'request', '{"intent":"revoke","row":"r_XKM34Y62T0YDHRY8NEE15FJ0QK","table":"household.expenses","ver":"v17.0"}', '1197573bdcd32549043c0aa84366f87e537c0db7b988b71c783f0be86323564f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (26, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_FK43AV340CXV8SY4"}', 'ecce13a55d510808309f22d01ec4b5d8cf184f2ac0b79f6c9573238b5c8b0eeb', NULL, NULL, NULL);
INSERT INTO public.content VALUES (27, 'existence/0', '{"scope":"whole","status":"applied"}', '2f44b7beb399a814e1e20abc7d4ccfb73d0038177fbe9f78c3a9f6d7c497e5a2', NULL, NULL, NULL);
INSERT INTO public.content VALUES (27, 'op_sources', '[26]', '9cab0519f56f13acec86572516e8ebe7b99aa40011ec3171c9c8af90c08cae7a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (27, 'target', '{"cause":"request","intent":"revoke","op_index":0,"row":"r_XKM34Y62T0YDHRY8NEE15FJ0QK","sv":1,"table":"t1"}', 'ae1e5ed96771a5f76897b6b63913485c0e18d16b2938e55dc5cc83e7f141103f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (28, 'target', '{"emptied":true,"partition":"p_RCBX19D6XW61VY3W","read_pos":27,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', '15a8e49cc07dc83ececec5473bcf44502b72a5394696541dcc1e914736cd8255', NULL, NULL, NULL);
INSERT INTO public.content VALUES (29, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-26T10:24:00.858Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', '587110e7ab01b17781a41569f99e6b653128da6a5f9e46b70db20951f48394b4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (29, 'ops/0/set/f1', '"2026-11-04"', 'ba9fc93c7ed70a8b525f0a62023d41e1344542f7d58b17385ccc81443bf5421c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (29, 'ops/0/set/f2', '"9"', '986b79d4b69dffb1d19836f47b27073d95bf55201b3385aceb7e0687a21d8667', NULL, NULL, NULL);
INSERT INTO public.content VALUES (29, 'ops/0/set/f3', '"snack"', '176fabc59f5999b35a637537307adcad5b993e0c555bf86e403953b5bdd86a7e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (29, 'ops/0/target', '{"created":true,"intent":"insert","row":"r_T85ET4XD7CJG6DYYPF7TXJ32S4","table":"t1"}', '32dbb0fdf86bf6483f0f73c3c45ed70f9a4082efc8598c2f50eacec19c9c9680', NULL, NULL, NULL);
INSERT INTO public.content VALUES (29, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (29, 'request_key', '{"key":"9b7f97927b2d5525845e332c0143d0133d3f0f2c4d9267548399a0a202f305e0"}', '7fabfc33adbbf9c3ef1bafc30864a6b5fba3f0fee51f96877fa0bffb1495992b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (30, 'request', '{"intent":"insert","set":{"amount":9,"date":"2026-11-04","note":"snack"},"table":"household.expenses"}', '1e6e090a868923bafd27c360a50ab1d8bf00f4cedd7b02ccf64f898deee5a144', NULL, NULL, NULL);
INSERT INTO public.content VALUES (30, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_GZD5R8J5RB4N04P6"}', '4cd876789869a313ddc189045ff04e7f3526484799821a02935a98aad1f56aa8', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'fields/f1/0', '{"status":"applied","value":"2026-11-04"}', '44b6698d9440c789295afb873b3ac44d7074d41b719e4df1a846a31176d561ca', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'fields/f2/0', '{"status":"applied","value":"9"}', '61a0d6511cffcfb500d40f4e295289bdaef54675ed7241046e86da526085d56b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'fields/f3/0', '{"status":"applied","value":"snack"}', '79e9d32653ca14f4fdcec42e8e4b56080f01c897eeec3b97c1e7f22fc968a812', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'literal/f1/0', '{"segments":[{"result":"na","source":30}]}', '7af69cfa023aa24d18ec68e07573f47a474e1d13da839998df0e1c363cf6f334', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'literal/f2/0', '{"segments":[{"result":"na","source":30}]}', '7af69cfa023aa24d18ec68e07573f47a474e1d13da839998df0e1c363cf6f334', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'literal/f3/0', '{"segments":[{"result":"na","source":30}]}', '7af69cfa023aa24d18ec68e07573f47a474e1d13da839998df0e1c363cf6f334', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'sources/f1/0', '[{"kind":"value","source":30}]', '75e656324aefbcea4bd4431d6f5bedfcd073b73471966079df82048672fc3d66', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'sources/f2/0', '[{"kind":"value","source":30}]', '75e656324aefbcea4bd4431d6f5bedfcd073b73471966079df82048672fc3d66', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'sources/f3/0', '[{"kind":"value","source":30}]', '75e656324aefbcea4bd4431d6f5bedfcd073b73471966079df82048672fc3d66', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'target', '{"cause":"request","created":true,"intent":"insert","op_index":0,"row":"r_T85ET4XD7CJG6DYYPF7TXJ32S4","sv":1,"table":"t1"}', 'e7995718ea8b97eb237bbdbba21fd78b5ab3079d0ff82639902e317d3e52899a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (32, 'checksum', '{"checksum":"352a37dda5548e17e41bc41d1faa41d33dfcf315b1b402cb40e86eb72eb109d9"}', 'f90a6949e3b50c947cbebb1eae26b3cd72eaadbef3fc613c8acfa2681db8358b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (32, 'key', '{"values":["2026-11-04"]}', '604bbd9e49c4a6737a3e5339db270d2778e5ed0ba7e814c136b4310d52da0b40', NULL, NULL, NULL);
INSERT INTO public.content VALUES (32, 'target', '{"emptied":false,"partition":"p_TKDQNSS61VC5BNW4","read_pos":31,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', '98e97a3d353a964e476914ad0a9b3a85c45ead2ad5fa6f9a94da593d1cad2e29', NULL, NULL, NULL);
INSERT INTO public.content VALUES (33, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-26T10:24:00.865Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', '055420e9ae36998da4b76bcf63af9ce50f606ab1a5ad309fa70ab45146066410', NULL, NULL, NULL);
INSERT INTO public.content VALUES (33, 'ops/0/target', '{"intent":"revoke","row":"r_T85ET4XD7CJG6DYYPF7TXJ32S4","table":"t1","ver":{"basis":"explicit","current":true,"op":29,"restore_count":0}}', 'a1204aa259b0d8d934c115949e83d8c9490681124f5710e188666daca1f2de06', NULL, NULL, NULL);
INSERT INTO public.content VALUES (33, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (33, 'request_key', '{"key":"f977fc61cf77bebe1a8a046e1770ebfb7e26751e79d2c312e9e724dc1f70b23f"}', '9aa819ef3528b8ea0c55a9cd9fb434f330e98b49d7f25db6502551dd63167776', NULL, NULL, NULL);
INSERT INTO public.content VALUES (34, 'request', '{"intent":"revoke","row":"r_T85ET4XD7CJG6DYYPF7TXJ32S4","table":"household.expenses","ver":"v29.0"}', '0d5c340f74694f2cb3f5b5f5649d3d446afe201692eb7123d654f735921c43f5', NULL, NULL, NULL);
INSERT INTO public.content VALUES (34, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_DK7P053MNKA0AXTC"}', '8985e560ab172008c28424c299b62244a0415a9891bbb502dc1bed458c52d775', NULL, NULL, NULL);
INSERT INTO public.content VALUES (35, 'existence/0', '{"scope":"whole","status":"applied"}', '2f44b7beb399a814e1e20abc7d4ccfb73d0038177fbe9f78c3a9f6d7c497e5a2', NULL, NULL, NULL);
INSERT INTO public.content VALUES (35, 'op_sources', '[34]', 'cf898e079ee71e303468636c3d556a4b0748b4d896c226e31cbdc1f1c20932e5', NULL, NULL, NULL);
INSERT INTO public.content VALUES (35, 'target', '{"cause":"request","intent":"revoke","op_index":0,"row":"r_T85ET4XD7CJG6DYYPF7TXJ32S4","sv":1,"table":"t1"}', 'bdfdbd083bddba355d750126a3bb55122f7ecee3036881fe7ed2f59bc8c67fb6', NULL, NULL, NULL);
INSERT INTO public.content VALUES (36, 'target', '{"emptied":true,"partition":"p_TKDQNSS61VC5BNW4","read_pos":35,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', '0e7d36b653ae5301ac9680d57779105899493e6957e9f94cb20071635aee23ad', NULL, NULL, NULL);
INSERT INTO public.content VALUES (37, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-26T10:24:00.870Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', 'c3bd18cb87d280d08f234ca686eb76838ac4b026c64556cbfc98704c7239a664', NULL, NULL, NULL);
INSERT INTO public.content VALUES (37, 'ops/0/revert', '{"include_later":false,"undo_op":33}', '79752873190e2f65f33153cf3fb49caa616976cd990b5b33a7504ff220add01b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (37, 'ops/0/target', '{"intent":"revoke","row":"r_T85ET4XD7CJG6DYYPF7TXJ32S4","table":"t1"}', '5b5fc378a7019914bf48486725598ef15c261ae3045443c890015d8703809baa', NULL, NULL, NULL);
INSERT INTO public.content VALUES (37, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (37, 'request_key', '{"key":"cc90e9b0c78411e2e099b36b59428d82071c71dc675c701ce4a529396d97b0aa"}', '7e79caf7d23924ce396047e8890f05fe61947ea8e66a7e390c4ac9fbbf3551c3', NULL, NULL, NULL);
INSERT INTO public.content VALUES (38, 'request', '{"revert":{"undo":33},"row":"r_T85ET4XD7CJG6DYYPF7TXJ32S4","table":"household.expenses"}', '2cb9456431d34f6ad809210dab7d453f1dcc0b93e5d361c94323f91a564b0c63', NULL, NULL, NULL);
INSERT INTO public.content VALUES (38, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_EH4A6XDYG5NVW8FH"}', 'a3aef72a34128416e529c922dacdc204d4fd6cd9ddabba63d48bb5f500d51401', NULL, NULL, NULL);
INSERT INTO public.content VALUES (39, 'existence/0', '{"restored":true,"scope":"whole","status":"applied"}', '989e2e5071049ed6593c6ff63c96b6521f8c23fc8e1bfa4eb479dfb610f5a74f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (39, 'op_sources', '[38]', '3c2487b1e732eb168accd2f394b776519932cd77d5b74840e575428a0e87b71d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (39, 'revert', '{"before_op":33,"items":[{"event":35,"existence":true}]}', 'dcab9f5b1aecea8241e226a5962f39fff3421dc142c03c109ddf69dd08a2f9cd', NULL, NULL, NULL);
INSERT INTO public.content VALUES (39, 'target', '{"cause":"request","intent":"revoke","op_index":0,"row":"r_T85ET4XD7CJG6DYYPF7TXJ32S4","sv":1,"table":"t1"}', 'bdfdbd083bddba355d750126a3bb55122f7ecee3036881fe7ed2f59bc8c67fb6', NULL, NULL, NULL);
INSERT INTO public.content VALUES (40, 'checksum', '{"checksum":"352a37dda5548e17e41bc41d1faa41d33dfcf315b1b402cb40e86eb72eb109d9"}', 'f90a6949e3b50c947cbebb1eae26b3cd72eaadbef3fc613c8acfa2681db8358b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (40, 'target', '{"emptied":false,"partition":"p_TKDQNSS61VC5BNW4","read_pos":39,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', 'f6918467f09558401c8e672f1b172c04773dd0baac68704a67ee16ddb6035e78', NULL, NULL, NULL);
INSERT INTO public.content VALUES (41, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-26T10:24:00.876Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', '2cc112dcfa7391a011bcfa2a52b0652225811536a33404af52407a20799294c3', NULL, NULL, NULL);
INSERT INTO public.content VALUES (41, 'ops/0/set/f2', '"32"', 'ca30de1c42bd3e0fdbeb7fb612cbf42e8e757b6948b7a51a67827df28b65107b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (41, 'ops/0/target', '{"intent":"update","row":"r_50D60TYRBBBBC4YYA5JR7XPFQC","table":"t1","ver":{"basis":"explicit","current":true,"op":13,"restore_count":0}}', '749be6a3c3bd4e4dffab8aa8bb9bde0dde4c785da7311e33e09f464b9f35ce43', NULL, NULL, NULL);
INSERT INTO public.content VALUES (41, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (41, 'request_key', '{"key":"90702a1317ecc19db7969adacb42372c2fd03138bf23b4a6b299eb71f5447842"}', '48e0248636e9c64d5825c86a4655d133a6fda0deedd5d13d0dbdd9c66eeb7332', NULL, NULL, NULL);
INSERT INTO public.content VALUES (42, 'request', '{"intent":"update","row":"r_50D60TYRBBBBC4YYA5JR7XPFQC","set":{"amount":32},"table":"household.expenses","ver":"v13.0"}', 'c6a5afcf5a70e4dd4062570f9925c112289f001663c5fd04e19a57f891c2c8b7', NULL, NULL, NULL);
INSERT INTO public.content VALUES (42, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_H19JTSQ0T8CRDX98"}', '955b65bfe13902234cdb2c730b8389b90d80526e940d29e8cc219e2c785ff9d9', NULL, NULL, NULL);
INSERT INTO public.content VALUES (43, 'fields/f2/0', '{"status":"applied","value":"32"}', 'd01ac326febf20813c49818b031035331a6f1e7ded0b73a8b97106cec8d47823', NULL, NULL, NULL);
INSERT INTO public.content VALUES (43, 'literal/f2/0', '{"segments":[{"result":"na","source":42}]}', '1a687bdc91fa9ef800597fc2cd0f41c7108d749595bed18fb74240e3f9ea68ad', NULL, NULL, NULL);
INSERT INTO public.content VALUES (43, 'sources/f2/0', '[{"kind":"value","source":42}]', '3e7a7b48647625cc8a330c1532e3369fce25d168ab0f7550f5277aa9ece719ea', NULL, NULL, NULL);
INSERT INTO public.content VALUES (43, 'target', '{"cause":"request","intent":"update","op_index":0,"row":"r_50D60TYRBBBBC4YYA5JR7XPFQC","sv":1,"table":"t1"}', '8d9b526b60a3ead8571e05ee6eb2a7a10b281f7e758a7549b9ad0d3787260edc', NULL, NULL, NULL);
INSERT INTO public.content VALUES (44, 'checksum', '{"checksum":"5aa3eee0bb3c73e7b833ae4779c454cd1706ac1c695777f62fbac858f284a139"}', 'a21a42a61794912949d594a6d2bf584300603cc131bfa770b320ee28bf982b08', NULL, NULL, NULL);
INSERT INTO public.content VALUES (44, 'target', '{"emptied":false,"partition":"p_1A6GGZGCVMBPEGH2","read_pos":43,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', '5033aa9c813c1633d088e57c113dc39ef64ab48772f60a84a465e54169578aa5', NULL, NULL, NULL);
INSERT INTO public.content VALUES (45, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-26T10:24:00.882Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', 'e8ebe82a7295f5661ea81bdacee18988b72e02549dbe7198b1df0f1d2d85df8b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (45, 'ops/0/set/f2', '"35"', '4bf17f4cd842cc1812f81a696010ee962c1c6f4db784a26b47cfde3144db8ae4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (45, 'ops/0/target', '{"intent":"update","row":"r_50D60TYRBBBBC4YYA5JR7XPFQC","table":"t1","ver":{"basis":"explicit","op":13,"restore_count":0}}', 'c15b407d2ed0137da6fb9fe4b8006c629d37b2e8c3bb78f3cec91297269c9937', NULL, NULL, NULL);
INSERT INTO public.content VALUES (45, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (45, 'request_key', '{"key":"831bbb57c1d2ef7eca3c3113a667fe1ca135fb86f3189db8c65ba1e6ee3a8d22"}', 'eca9e9782dc81c1cf6bc53569caf4e87e308133b18f9ccbabde869151d869061', NULL, NULL, NULL);
INSERT INTO public.content VALUES (46, 'request', '{"intent":"update","row":"r_50D60TYRBBBBC4YYA5JR7XPFQC","set":{"amount":35},"table":"household.expenses","ver":"v13.0"}', '49bf0385d6e35bf9ff17e25e3b916ce6c93051ece7cef826b4c29b52e4e14051', NULL, NULL, NULL);
INSERT INTO public.content VALUES (46, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_5FQBNVZQ3KZETG48"}', 'bfe72db3cb20b131ed633a38c8ad1f3a51aac3b5f7cdd00f66b02872d19987a9', NULL, NULL, NULL);
INSERT INTO public.content VALUES (47, 'fields/f2/0', '{"status":"candidate","value":"35"}', '0a46b36e4a8dcb521e89b693b64fb7ed71b710c7c253e001ab2d859ae7e6c13c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (47, 'literal/f2/0', '{"segments":[{"result":"na","source":46}]}', 'ec9a7df5f7d36e2816c86bda732347207da16137a062374518ad63eab7918133', NULL, NULL, NULL);
INSERT INTO public.content VALUES (47, 'sources/f2/0', '[{"kind":"value","source":46}]', 'b073fca649b906c9bf85d19138aa9815cd7bdf17d1dc4c51b535ded225066ef9', NULL, NULL, NULL);
INSERT INTO public.content VALUES (47, 'target', '{"cause":"request","intent":"update","op_index":0,"row":"r_50D60TYRBBBBC4YYA5JR7XPFQC","sv":1,"table":"t1"}', '8d9b526b60a3ead8571e05ee6eb2a7a10b281f7e758a7549b9ad0d3787260edc', NULL, NULL, NULL);
INSERT INTO public.content VALUES (48, 'candidates/0', '{"cause":"stale_write","deps":[{"event":47,"field":"f2","k":0}],"event":47,"intent":"update","items":[{"field":"f2","k":0,"value":"35"}],"seen":{"op":13,"restore_count":0}}', '065fc524c2f0fbb871cfbd39e9ee0066e0b87479a0bff27648841667910e752f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (48, 'current/0', '{"deps":[{"event":43,"field":"f2","k":0}],"field":"f2","op":41,"value":"32"}', '0c88032ef80c150050b77d11b9327972c67ab4ea3a6fbb5b5b8949dc6ef4dbb2', NULL, NULL, NULL);
INSERT INTO public.content VALUES (48, 'impact/0', '{"deps":[{"event":43,"field":"f2","k":0}],"kind":"reverted_write","op":41}', '781a112cf029985289bd07f26a2dea668fd6e9323c41b08e9dd99a5e79592e45', NULL, NULL, NULL);
INSERT INTO public.content VALUES (48, 'previous/0', '{"deps":[{"event":15,"field":"f2","k":0}],"field":"f2","value":"30"}', 'fae62666626a12c8b83c7a340e9588ee0da9a0d3a64b6136433e8578e60f82cc', NULL, NULL, NULL);
INSERT INTO public.content VALUES (48, 'target', '{"item":"pi_JNX4SDNEBQJXPVKJ","merge_base_op":13,"origin_event":47,"policy_version":1,"reason":"stale_write","row":"r_50D60TYRBBBBC4YYA5JR7XPFQC","ruleset_version":1,"table":"t1","type":"conflict","unit":["f2"]}', '6871bf516d82874b00d730648106bb5fa6d977eb02cb7a5e6aa8c242f63b6eeb', NULL, NULL, NULL);
INSERT INTO public.content VALUES (49, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-26T10:24:00.889Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', 'a648ae3fe9c1b75152f1e786cb217e09ad09beb14edfbfed10c29935035b3b54', NULL, NULL, NULL);
INSERT INTO public.content VALUES (49, 'ops/0/premises/0', '{"fields":["f2"],"range":"whole","row":"r_C4WC0TZ9MW9KV39M6FM7M2BGEW","state":"current","table":"t1","ver":{"basis":"explicit","op":21,"restore_count":0}}', '823386102d05c652f3bbf96a8b803fe75698b51a58301c09883ecb07b69e88a5', NULL, NULL, NULL);
INSERT INTO public.content VALUES (49, 'ops/0/set/f1', '"half of lunch"', 'c41224c57a8fe82b0d2e8c579ce6599dedf399a406007932a8013d383f495748', NULL, NULL, NULL);
INSERT INTO public.content VALUES (49, 'ops/0/set/f2', '"r_C4WC0TZ9MW9KV39M6FM7M2BGEW"', 'd838e0a50c0a68e3512e7a7629e4a71a15cee7019cf70a2ca19a3c47d2fe881b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (49, 'ops/0/target', '{"created":true,"intent":"insert","row":"r_Q4GGB4SGJ8C2HAYPACA4F35J5P","table":"t4"}', '556e5e4eafb08cc2d74a3ad838b5a3c1b71ab7ab645024b1b6fbf19d13699074', NULL, NULL, NULL);
INSERT INTO public.content VALUES (49, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (49, 'request_key', '{"key":"a767311fc35a168777fcab70d3f5338c6e698ebfc1a70bd7ad33d9e35a29e9dd"}', '60dd08e68434b8c0b157323b44100347d0040ac26900c4a5463be826abca5ec1', NULL, NULL, NULL);
INSERT INTO public.content VALUES (50, 'request', '{"intent":"insert","premises":[{"fields":["amount"],"row":"r_C4WC0TZ9MW9KV39M6FM7M2BGEW","table":"household.expenses","ver":"v21.0"}],"set":{"expense":"r_C4WC0TZ9MW9KV39M6FM7M2BGEW","note":"half of lunch"},"table":"household.refunds"}', '7238d7b05eb06a9cebd6389b0cd2df03adeff1a48b4ac607c8515946553bb7ad', NULL, NULL, NULL);
INSERT INTO public.content VALUES (50, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_GXXA1A2W0BJJYN9D"}', '6613a6e0845da4e2c9c91a6f3749dbfcccd025060fcc442e12a7ddb47a46cfd4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (51, 'fields/f1/0', '{"status":"applied","value":"half of lunch"}', '6731b651c19eec0bf119411356eedb0d936803628773af9b41f5c8023511d907', NULL, NULL, NULL);
INSERT INTO public.content VALUES (51, 'fields/f2/0', '{"status":"applied","value":"r_C4WC0TZ9MW9KV39M6FM7M2BGEW"}', 'a443a728a33ecfa8555674f7e3133bddd19383ae25e56219fbd08c979add89ee', NULL, NULL, NULL);
INSERT INTO public.content VALUES (51, 'literal/f1/0', '{"segments":[{"result":"na","source":50}]}', '47b1956d41eaa447fffc4d8db1ff7cdb9186a0bf686582c5531d51a398c87729', NULL, NULL, NULL);
INSERT INTO public.content VALUES (51, 'literal/f2/0', '{"segments":[{"result":"na","source":50}]}', '47b1956d41eaa447fffc4d8db1ff7cdb9186a0bf686582c5531d51a398c87729', NULL, NULL, NULL);
INSERT INTO public.content VALUES (51, 'sources/f1/0', '[{"kind":"value","source":50}]', 'cd8ffd1b682a43ec63e90b2f0816a49abf4870fae625151a8e201616ea0c273d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (51, 'sources/f2/0', '[{"kind":"value","source":50}]', 'cd8ffd1b682a43ec63e90b2f0816a49abf4870fae625151a8e201616ea0c273d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (51, 'target', '{"cause":"request","created":true,"intent":"insert","op_index":0,"row":"r_Q4GGB4SGJ8C2HAYPACA4F35J5P","sv":1,"table":"t4"}', '392f2c58a779f8e83224ae7b3ea6118949281153e9cf159a32ca7d74c3e98e97', NULL, NULL, NULL);
INSERT INTO public.content VALUES (52, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-26T10:24:00.895Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', '43a5af17f2e4348e4dd5441f3fe3ed435bbcb688afd1bf528ef7b28db8b48899', NULL, NULL, NULL);
INSERT INTO public.content VALUES (52, 'ops/0/set/f1', '"food"', '90960c7a6145a97cbb09d6478535c2b31f76050310286dabe9ae2463ee003850', NULL, NULL, NULL);
INSERT INTO public.content VALUES (52, 'ops/0/set/f2', '"5000"', '804856326d54d734f3b3212c16f6eef4ed73817278ad5262df1c40fc895feaca', NULL, NULL, NULL);
INSERT INTO public.content VALUES (52, 'ops/0/target', '{"by_entity_key":true,"created":true,"entity":"e_A0WPAB33GA6A9KGT7CK6B0V7NP","intent":"update","table":"t2"}', '140e5df3cbd71abca7a122cccf1bde07713108268ac955b31c332467c735b3c1', NULL, NULL, NULL);
INSERT INTO public.content VALUES (52, 'ops/0/valid', '{"from":{"mode":"given","value":"2026-10-01"},"to":{"mode":"next_change"}}', '7273cec08b6fc076559e36a924c20ca07cbb746cfbe55c1528defa8ee63e7692', NULL, NULL, NULL);
INSERT INTO public.content VALUES (52, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (52, 'request_key', '{"key":"f6d061eff79d48b008f8a62ac2b6b4fcd2ba544518803322b6741cab24243b84"}', '39b397ffdde5375a6688e5992fc66d6b9d23181ca02d93c5d806858117d97bb1', NULL, NULL, NULL);
INSERT INTO public.content VALUES (53, 'request', '{"entity_key":{"kind":"food"},"intent":"update","set":{"amount":5000},"table":"household.budgets","valid_from":"2026-10-01"}', 'e8c41a2624b6b6a263306b0402ba6c0950daa36a0e9f1dc65ef3082e621faa1e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (53, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_J2JJMEC1XCRGAT3W"}', '2377f8aecadb564e4ccabf14d301e8ecfae38d6080f9f67ced89657a8e332503', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'fields/f1/0', '{"status":"applied","value":"food"}', '3ce851fafc17dadf27fb8a73401c468b44acda2ff106fc54a0c477d259dd9fb7', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'fields/f2/0', '{"status":"applied","value":"5000"}', '0b0ab42381e2bb4d2859ec1864e72f7807787fd2bad4a716a2874538ba39f214', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'literal/f1/0', '{"segments":[{"result":"na","source":53}]}', 'b82e3ae156e1b50b66bf59d1eb89210ade76c884a0f4c0e8a77ece34fafe938a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'literal/f2/0', '{"segments":[{"result":"na","source":53}]}', 'b82e3ae156e1b50b66bf59d1eb89210ade76c884a0f4c0e8a77ece34fafe938a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'sources/f1/0', '[{"kind":"value","source":53}]', 'b863cc4850ac41d72e8c726892506c422beb9b9afad12203c31d774c5e150d73', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'sources/f2/0', '[{"kind":"value","source":53}]', 'b863cc4850ac41d72e8c726892506c422beb9b9afad12203c31d774c5e150d73', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'span/f1/0', '{"valid":{"from":"2026-10-01"}}', '80ba5cd58b91a2bf147edd7b90037d2a0c0f3aa70102ecbfa4458a539d352912', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'span/f2/0', '{"valid":{"from":"2026-10-01"}}', '80ba5cd58b91a2bf147edd7b90037d2a0c0f3aa70102ecbfa4458a539d352912', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'target', '{"cause":"request","created":true,"entity":"e_A0WPAB33GA6A9KGT7CK6B0V7NP","intent":"update","op_index":0,"sv":1,"table":"t2"}', '621cc2c90fabadac3095452cc36444b745e6271a0e6b14ab11b1a061960dc184', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'valid_sources', '[53]', '17673dea3b100a600846ee04777d0c0c2379258f5b5cb1757f7a36f4956a6c41', NULL, NULL, NULL);
INSERT INTO public.content VALUES (55, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-26T10:24:00.901Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', 'cc373fb470c794e705a74e7e3537efa6660c83ced91f36a595f618b8d6f1e0d0', NULL, NULL, NULL);
INSERT INTO public.content VALUES (55, 'ops/0/noop', '["f1"]', '6dbd1ae38d591a1d8818e127651ac0a0c7f78f1d180b0aa1aefb82008c3b0758', NULL, NULL, NULL);
INSERT INTO public.content VALUES (55, 'ops/0/set/f2', '"4000"', '91197d7b81dc27b9b94cf890932114c5ab712da496885ba5cc01ee4617bfaae0', NULL, NULL, NULL);
INSERT INTO public.content VALUES (55, 'ops/0/target', '{"by_entity_key":true,"entity":"e_A0WPAB33GA6A9KGT7CK6B0V7NP","intent":"update","table":"t2","ver":{"basis":"fallback","current":true,"op":52,"restore_count":0}}', '007561695b6b0473dd0ece3b57f3c7f7d6bd758b05ac5ba404353aeae30e36ab', NULL, NULL, NULL);
INSERT INTO public.content VALUES (55, 'ops/0/valid', '{"from":{"mode":"given","value":"2026-11-10"},"to":{"mode":"next_change"}}', '7c600349a954d222ff1f1271eaa0a9c540445c22d7e96a9a016d8d264664137a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (55, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (55, 'request_key', '{"key":"0b943f2078c5eec96de7c92c3ed79ca9a1709860ecc2d335ba6c7a61ff9e6bcd"}', '331f416b4abd061213e1c27709aa731f018f9d5c56c01ed9b9fc3dcce0904a95', NULL, NULL, NULL);
INSERT INTO public.content VALUES (56, 'request', '{"entity_key":{"kind":"food"},"intent":"update","set":{"amount":4000},"table":"household.budgets","valid_from":"2026-11-10"}', '6de8c7b6772863dbbc50ebe46df7d75ea76e1602bc6d40942a71951ee91c85af', NULL, NULL, NULL);
INSERT INTO public.content VALUES (56, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_GXYCZ2TYKKDVXNRZ"}', 'dee1b53c12db02cba5a3fe3663a91f9a3c18ac9ffe794f1df1646ec25181ee0e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (57, 'fields/f2/0', '{"status":"applied","value":"4000"}', '8e23d82c7ddbe448c60657d8ef710ec0874d39aa72be68e930cab31f55ed2c3c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (57, 'literal/f2/0', '{"segments":[{"result":"na","source":56}]}', 'b903cb2ddcbb0e12413687f6058f52d2b871ebf7330699e026a4a5a316848009', NULL, NULL, NULL);
INSERT INTO public.content VALUES (57, 'sources/f2/0', '[{"kind":"value","source":56}]', '593e1a291dbc0675ec506bfa03f88dc9ca033e93fa172bb081c78882c74de2c0', NULL, NULL, NULL);
INSERT INTO public.content VALUES (57, 'span/f2/0', '{"valid":{"from":"2026-11-10"}}', '3b11f29fa3cdd8a4f4128418a46b42c472731a46787965a030d57bd4bc9016ee', NULL, NULL, NULL);
INSERT INTO public.content VALUES (57, 'target', '{"cause":"request","entity":"e_A0WPAB33GA6A9KGT7CK6B0V7NP","intent":"update","op_index":0,"sv":1,"table":"t2"}', 'e059d5471febbf1874e36866a3880387d5cfc0dbd9001dff20b1603e856696bd', NULL, NULL, NULL);
INSERT INTO public.content VALUES (57, 'valid_sources', '[56]', '0494aeb56d68d0683dcdc2856752cd331cb1a9112b239e9a529519dbe29e3e63', NULL, NULL, NULL);
INSERT INTO public.content VALUES (58, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-26T10:24:00.907Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', 'c58d6e424258801ca94113d5c5d5dc6798f8587993bd7d0da77d81238c6ecc1a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (58, 'ops/0/noop', '["f1"]', '6dbd1ae38d591a1d8818e127651ac0a0c7f78f1d180b0aa1aefb82008c3b0758', NULL, NULL, NULL);
INSERT INTO public.content VALUES (58, 'ops/0/set/f2', '"4500"', 'bf1ac8b2c5a894f0bb4ebd1fb15ab12d2c6a92bd0fe856d165f96705ef3bd2f5', NULL, NULL, NULL);
INSERT INTO public.content VALUES (58, 'ops/0/target', '{"by_entity_key":true,"entity":"e_A0WPAB33GA6A9KGT7CK6B0V7NP","intent":"update","table":"t2","ver":{"basis":"fallback","current":true,"op":55,"restore_count":0}}', '5d731e71547e38c3d334e89a71bd969cf4178f160e1e023894289b26ca277292', NULL, NULL, NULL);
INSERT INTO public.content VALUES (58, 'ops/0/valid', '{"from":{"mode":"given","value":"2026-10-15"},"to":{"mode":"open"}}', '5d334a626a7551e0201ad822cbaca0e27e317959d36d6fdbcbf24f69dc964360', NULL, NULL, NULL);
INSERT INTO public.content VALUES (58, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (58, 'request_key', '{"key":"bed756f6336038932bf6cffd25a32916b287cb5640d3a8d07cd97dd19c6e38e8"}', '3931b9f89cfe8c11872c691bc01828455d384ab32fd059283f30fd9b723695e5', NULL, NULL, NULL);
INSERT INTO public.content VALUES (59, 'request', '{"entity_key":{"kind":"food"},"intent":"update","set":{"amount":4500},"table":"household.budgets","valid_from":"2026-10-15","valid_to":"open"}', 'c5d2dd03b95734ba4f02adf9455032dc2b9ed7da85f1b4e9b380424b0cadfa96', NULL, NULL, NULL);
INSERT INTO public.content VALUES (59, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_TNZRX1H93EYQAVFB"}', 'f05949e64933c4e55729156b832b2c8f808e2dc912bc08c7e3dba8e4ffa83cb2', NULL, NULL, NULL);
INSERT INTO public.content VALUES (60, 'fields/f2/0', '{"status":"awaiting","value":"4500"}', 'f288797fe8e450502df4528235299c293b805ae7d783357cf4b339617a2c52c6', NULL, NULL, NULL);
INSERT INTO public.content VALUES (60, 'literal/f2/0', '{"segments":[{"result":"na","source":59}]}', 'ef6f298ec294bf8b4ed2361ce3505c6bd7a185b4f16a066d5e0b80387b7f5db4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (60, 'sources/f2/0', '[{"kind":"value","source":59}]', 'ee85e2dc2bc2423f1d88a9ca67df8394e495c9665b1425dce963b25eff9c454d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (60, 'span/f2/0', '{"valid":{"from":"2026-10-15"}}', 'e6c0c70a14cb53d847c607a85603c051efee5a3734f0fb019615c85467cf1daf', NULL, NULL, NULL);
INSERT INTO public.content VALUES (60, 'target', '{"cause":"request","entity":"e_A0WPAB33GA6A9KGT7CK6B0V7NP","intent":"update","op_index":0,"sv":1,"table":"t2"}', 'e059d5471febbf1874e36866a3880387d5cfc0dbd9001dff20b1603e856696bd', NULL, NULL, NULL);
INSERT INTO public.content VALUES (60, 'valid_sources', '[59]', '8f332db1356cb4786b468baab31bd75565bd751de9d984c92f9defbcc3ef172d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (67, 'ops/0/set/f3', '"12"', 'f9cacf3cb91a12e03bc4546834f95a50a4c5fe02276ac260148ea9296c442d39', NULL, NULL, NULL);
INSERT INTO public.content VALUES (61, 'current/0', '{"deps":[{"event":54,"field":"f2","k":0},{"event":57,"field":"f2","k":0},{"event":60,"field":"f2","k":0}],"field":"f2","op":52,"valid":{"from":"2026-10-15","to":"2026-11-10"},"value":"5000"}', '8073ae020c7890dea4e8000244d5f09095bed94efc3bbb260e09d99fccc843b9', NULL, NULL, NULL);
INSERT INTO public.content VALUES (61, 'current/1', '{"deps":[{"event":57,"field":"f2","k":0},{"event":60,"field":"f2","k":0}],"field":"f2","op":55,"valid":{"from":"2026-11-10"},"value":"4000"}', '12f8ff850df0f03ec83a43948411596d07d4044c5bc8f5519f8b066d63952ed7', NULL, NULL, NULL);
INSERT INTO public.content VALUES (61, 'impact/0', '{"deps":[{"event":54,"field":"f2","k":0},{"event":57,"field":"f2","k":0}],"field":"f2","kind":"overwritten_segment","op":52,"valid":{"from":"2026-10-15","to":"2026-11-10"},"value":"5000"}', '521fcc9f665137202a0ee51b79c5fe138d455d5d84ea89ce907809f9818960d3', NULL, NULL, NULL);
INSERT INTO public.content VALUES (61, 'impact/1', '{"deps":[{"event":57,"field":"f2","k":0}],"field":"f2","kind":"overwritten_segment","op":55,"valid":{"from":"2026-11-10"},"value":"4000"}', 'e2fe93e6bad541bd07dd7dc8b01c7c127aa53b6706e4e1e6302bdb61f0cf1afd', NULL, NULL, NULL);
INSERT INTO public.content VALUES (61, 'proposed/0', '{"deps":[{"event":60,"field":"f2","k":0}],"field":"f2","valid":{"from":"2026-10-15"},"value":"4500"}', 'f6faa8aff2ad990c5fd52f61ef4b8d9cdf80e7d8aac5f2ffc3f249a0100f640e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (61, 'scope_valid', '{"deps":[{"event":60,"field":"f2","k":0}],"spans":[{"from":"2026-10-15"}]}', 'f698a8f359bb795e6eecf79a199215ba88cfb1957109b0749c970a193722b048', NULL, NULL, NULL);
INSERT INTO public.content VALUES (61, 'target', '{"entity":"e_A0WPAB33GA6A9KGT7CK6B0V7NP","item":"pi_WAWQM74JV1QDKF46","origin_event":60,"policy_version":1,"reason":"overwrites_change_point","ruleset_version":1,"table":"t2","type":"awaiting_confirmation","unit":["f2"]}', 'a3014435cff7e6f97de6f99d133d63ceb25a51148089206004ad97901ae9001e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-26T10:24:00.915Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', '0e810213b8eeb9becfc99a7c68e9a7c44f4b1b1b546a811ca2dc9f2e4224276c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ops/0/set/f1', '"app"', '4e5ef144c51cd25230c144c3e1d8e842b9860b7a3cec2699d4e24e6517fc4b20', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ops/0/set/f2', '"k-1"', 'f613e2ddb1ed1aefc2d87a1bc773c3a3e671f40809ffe8875486d58482e5259a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ops/0/set/f3', '"10"', '536549599ec6c3b859cd3970025779a13d061783c73e663fea7f963e98379aa8', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ops/0/target', '{"by_external_key":true,"created":true,"intent":"update","row":"r_CNBK4Y7984NPCYQ612C00Z4GV3","table":"t3"}', 'f490083c3567e19629822795e77f238aa5e69cbd6a8aebbf230ddc91f78d3b27', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ops/1/set/f1', '"app"', '4e5ef144c51cd25230c144c3e1d8e842b9860b7a3cec2699d4e24e6517fc4b20', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ops/1/set/f2', '"k-2"', '242ae761454b02109f6b54c9077c298d68e7e96cf0087859efa80e54073f77aa', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ops/1/set/f3', '"21"', '6f8f349216adc47cfd723001f3dfbfc11179e1b36c31ce51c85056026f3d85b9', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ops/1/target', '{"by_external_key":true,"created":true,"intent":"update","row":"r_CBA9K83Z66TNQJJ6Z0QM703JFP","table":"t3"}', 'e536fa59e61dc4f08f38be75527c72ae63e9a28f1fc40ca02f344b2ba30cbb2b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'request', '{"op_count":2,"sv":1,"sv_basis":"explicit"}', 'e0cec6f32835f484f2a07b4776a1164f5e0b3d4ad918e86e9d189d29fce17780', NULL, NULL, NULL);
INSERT INTO public.content VALUES (63, 'request', '{"external_key":{"external_id":"k-1","origin":"app"},"intent":"update","set":{"fare":10},"table":"household.rides"}', '602bd852c41aaef9948bac4e79a237bad5b2c4ee7f721a2a8e6d4f5b741c490b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (63, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_A6671J1ESY8H4WG9"}', '9a1eb2d76cc0f593a78d8fda1e44c3bae534e18c03caea8bca43d36940a5e9ea', NULL, NULL, NULL);
INSERT INTO public.content VALUES (64, 'request', '{"external_key":{"external_id":"k-2","origin":"app"},"intent":"update","set":{"fare":21},"table":"household.rides"}', '9070f120653e01cb1fdfa2c01ae8d9c0a844e997d9435b4f4ef900dd4ab4476f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (64, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":1,"source_id":"s_P32E55CZFSCX6FJT"}', '86d5b78a2e5dc5ee12811deca65a14a0964ac70db76ce34a6febd709eca61cfe', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'fields/f1/0', '{"status":"applied","value":"app"}', 'c0f87af78708bddb29d36c257c2d3a389a9a16d6077ecd1f72132e2c36458a46', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'fields/f2/0', '{"status":"applied","value":"k-1"}', 'f1b5335622ffbf0c57f3cb8d1242f129d57eec003bddfd855a7ed1c5a204a1ca', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'fields/f3/0', '{"status":"applied","value":"10"}', 'c5d6a3109242c147dbe9c262ab4ffa606fdb23aeab545dcd9f6edd4229e4746d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'literal/f1/0', '{"segments":[{"result":"na","source":63}]}', 'e0841b0f39d829865177ccca851114fb9e7a5f13ced5e90f3d3327678303633a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'literal/f2/0', '{"segments":[{"result":"na","source":63}]}', 'e0841b0f39d829865177ccca851114fb9e7a5f13ced5e90f3d3327678303633a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'literal/f3/0', '{"segments":[{"result":"na","source":63}]}', 'e0841b0f39d829865177ccca851114fb9e7a5f13ced5e90f3d3327678303633a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'sources/f1/0', '[{"kind":"value","source":63}]', 'b3dcee24b53b92ebf82de486dc7e1f5721207475796e39f5ccf7c765c022c434', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'sources/f2/0', '[{"kind":"value","source":63}]', 'b3dcee24b53b92ebf82de486dc7e1f5721207475796e39f5ccf7c765c022c434', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'sources/f3/0', '[{"kind":"value","source":63}]', 'b3dcee24b53b92ebf82de486dc7e1f5721207475796e39f5ccf7c765c022c434', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'target', '{"cause":"request","created":true,"intent":"update","op_index":0,"row":"r_CNBK4Y7984NPCYQ612C00Z4GV3","sv":1,"table":"t3"}', '135bafe6b7394c5ea85901ba6c28b4fbd0973b58506e06eb87bbd3b4c75e9466', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'fields/f1/0', '{"status":"applied","value":"app"}', 'c0f87af78708bddb29d36c257c2d3a389a9a16d6077ecd1f72132e2c36458a46', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'fields/f2/0', '{"status":"applied","value":"k-2"}', 'a00fb3f1544a5603c809d0f2c45478c13646761f47ee0ae70eceacfc5973e616', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'fields/f3/0', '{"status":"applied","value":"21"}', 'db2af3002b6b171e6a8ddf6ac2b6b0d0afbeaa88d898be80c8493e77e97a47fd', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'literal/f1/0', '{"segments":[{"result":"na","source":64}]}', '33c84a6f0c71d09e6d7804f71b7e8a38bbd3ff78740063cb982ad2858f322260', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'literal/f2/0', '{"segments":[{"result":"na","source":64}]}', '33c84a6f0c71d09e6d7804f71b7e8a38bbd3ff78740063cb982ad2858f322260', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'literal/f3/0', '{"segments":[{"result":"na","source":64}]}', '33c84a6f0c71d09e6d7804f71b7e8a38bbd3ff78740063cb982ad2858f322260', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'sources/f1/0', '[{"kind":"value","source":64}]', '58b096f741dec54695b0d08a032222f771639c9bcb2dd1fa941aa16fd6baade4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'sources/f2/0', '[{"kind":"value","source":64}]', '58b096f741dec54695b0d08a032222f771639c9bcb2dd1fa941aa16fd6baade4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'sources/f3/0', '[{"kind":"value","source":64}]', '58b096f741dec54695b0d08a032222f771639c9bcb2dd1fa941aa16fd6baade4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'target', '{"cause":"request","created":true,"intent":"update","op_index":1,"row":"r_CBA9K83Z66TNQJJ6Z0QM703JFP","sv":1,"table":"t3"}', 'cee73409061a30ef41ab19741be88dc3ffc6b277bcb27d3aed105b48dc5b8464', NULL, NULL, NULL);
INSERT INTO public.content VALUES (67, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-26T10:24:00.923Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', 'cf7c5bbbb019c3ffae8c49f4088bbc14791cefb93069986a46a2bfae94acb260', NULL, NULL, NULL);
INSERT INTO public.content VALUES (67, 'ops/0/baseline', '{"f3":62}', '850f6f2f9e33426a9e5b1b478f780ef8e999f86ad52151a509a7c4f9f7864a44', NULL, NULL, NULL);
INSERT INTO public.content VALUES (67, 'ops/0/noop', '["f1","f2"]', '8fd6f2004d3e89f6c04b595c49979ed48da7f355575a31f9ae6a2456b6c9bca4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (67, 'ops/0/target', '{"by_external_key":true,"intent":"update","row":"r_CNBK4Y7984NPCYQ612C00Z4GV3","table":"t3","ver":{"basis":"external_key","op":62,"restore_count":0}}', 'd3de6aff62a694dcccb334e3b38a35fcae24072ba1cff3c8d5e85fc2e9a4f89f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (67, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (68, 'request', '{"external_key":{"external_id":"k-1","origin":"app"},"intent":"update","set":{"fare":12},"table":"household.rides"}', '78ff3623de3e1aca1b75daff2eecf8abd849fec8d2acd8cfd01d39fd79dd241c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (68, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_N2B2NZQQTE6J6N21"}', 'bdb687a9c33aa8c6f3c6557b228c2005bf2d9cc6a879c19cdf7e68876c9b1d18', NULL, NULL, NULL);
INSERT INTO public.content VALUES (69, 'fields/f3/0', '{"status":"applied","value":"12"}', 'ea590704ad6cb667a1c44e5aee91b061a120ea192f3fb3d6c64f11c2ca83fcf8', NULL, NULL, NULL);
INSERT INTO public.content VALUES (69, 'literal/f3/0', '{"segments":[{"result":"na","source":68}]}', 'a85b1c503221104998ddbd9e272a8efe5e7fe98227785680540222545cd02ac0', NULL, NULL, NULL);
INSERT INTO public.content VALUES (69, 'sources/f3/0', '[{"kind":"value","source":68}]', '29d246f835e24bc3a7360376a47f538836990cd62f470717347de67553d26ef6', NULL, NULL, NULL);
INSERT INTO public.content VALUES (69, 'target', '{"cause":"request","intent":"update","op_index":0,"row":"r_CNBK4Y7984NPCYQ612C00Z4GV3","sv":1,"table":"t3"}', 'a5b4342a82d82550a1f38ab789512e94df2cb6f8832db0468b66e568310b8f32', NULL, NULL, NULL);
INSERT INTO public.content VALUES (70, 'ctx', '{"now":"2026-11-26T10:24:00.945Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', 'b662a771a0840089343fb3368b3d96c96a756e08f8897a106f6c512fdac0b964', NULL, NULL, NULL);
INSERT INTO public.content VALUES (70, 'draft', '{"base_version":1,"drop_tables":["rides"],"slot":"household","tables":[{"description":"one row per expense","duplicate_keys":[["date","note"]],"fields":[{"description":"the day","id":"f1","name":"date","required":true,"type":"date"},{"description":"how much, in yuan","id":"f2","name":"amount","type":"integer"},{"description":"what for","id":"f3","name":"note","type":"text"}],"id":"t1","kind":"base","name":"expenses","time":{"field":"date","type":"event"}}],"timezone":"Asia/Shanghai"}', '404066f1af66ec959a80f487f737bc56457ba04af40f9916346fbf691ea553cc', NULL, NULL, NULL);
INSERT INTO public.content VALUES (70, 'request_key', '{"key":"971c059600d1b3717e7800172af7ecb504ea3bc12870cd904d45e0cb970f7b70"}', '1d29e3ae4f27e2c3985dde9022bd788e9ae2c50152842f075c55546ec7b50a37', NULL, NULL, NULL);
INSERT INTO public.content VALUES (70, 'target', '{"base_version":1,"creates_slot":false,"draft_id":"d_F167Z43KSDA199TQ"}', 'd791a923e3bc3e3101eb1f7247baf0e12d2c9d3cbf1d9a97ca7d211fe3cbc116', NULL, NULL, NULL);
INSERT INTO public.content VALUES (71, 'changes', '[{"auto":true,"change":"change_duplicate_keys","class":"metadata","compatible_with_old_writes":true,"destructive":false,"target":{"table":"t1"}},{"auto":false,"change":"drop_table","class":"metadata","compatible_with_old_writes":false,"destructive":true,"target":{"table":"t3"}}]', '39d231cfbce20ede4cf84a446c16daff6957092c68fec8a68511996bd78094ac', NULL, NULL, NULL);
INSERT INTO public.content VALUES (71, 'compiled', '{"compiler":1,"name":"household","rsql":"rsql@1","slot":"sl_BYREFGP1VJ4RR4G4","sv":2,"tables":[{"description":"one row per expense","duplicate_keys":[["f1","f3"]],"fields":[{"description":"the day","id":"f1","name":"date","required":true,"type":"date"},{"description":"how much, in yuan","id":"f2","name":"amount","type":"integer"},{"description":"what for","id":"f3","name":"note","type":"text"}],"id":"t1","kind":"base","name":"expenses","physical":{"since":1,"table":"t_t1_v1"},"time":{"field":"f1","type":"event"}},{"description":"a monthly budget by kind","entity_key":["f1"],"fields":[{"description":"what the budget is for","id":"f1","name":"kind","required":true,"type":"text"},{"description":"the budget, in yuan","id":"f2","name":"amount","required":true,"type":"integer"}],"id":"t2","kind":"base","name":"budgets","physical":{"since":1,"table":"t_t2_v1"},"time":{"granularity":"date","type":"state"}},{"description":"one row per refund of an expense","fields":[{"description":"why","id":"f1","name":"note","required":true,"type":"text"},{"description":"the expense refunded","id":"f2","name":"expense","ref":{"table":"t1","target":"row"},"type":"ref"}],"id":"t4","kind":"base","name":"refunds","physical":{"since":1,"table":"t_t4_v1"},"time":{"type":"none"}},{"description":"what was spent each day","fields":[{"description":"the day","id":"f1","name":"day","type":"date"},{"description":"the sum","id":"f2","name":"total","type":"integer"},{"description":"how many","id":"f3","name":"n","type":"integer"}],"id":"t5","kind":"derived","name":"spent_by_day","physical":{"since":1,"table":"d_t5_v1"},"rule":{"depends_on":[{"field":"f1","table":"t1"},{"field":"f2","table":"t1"}],"id":"r1","rsql":"rsql@1","scope":{"key":["f1"],"key_from_free_text":false,"kind":"group"},"sql":"SELECT \"t1\".\"f1\" AS \"f1\", CAST(sum(\"t1\".\"f2\") AS bigint) AS \"f2\", count(*) AS \"f3\" FROM \"t1\" GROUP BY 1","time_dependency":"bucketed","version":1}}],"timezone":"Asia/Shanghai"}', 'c8a52f918523349709a50a52ec2f98280940c5262ba3d27c90821cf8a4107087', NULL, NULL, NULL);
INSERT INTO public.content VALUES (71, 'target', '{"draft_id":"d_F167Z43KSDA199TQ","outcome":"pending","target_version":2}', '1554f67298044dacf49830f53ee72ce0a67cad83db832de9efefaa3e41080126', NULL, NULL, NULL);
INSERT INTO public.content VALUES (72, 'target', '{"draft":"d_F167Z43KSDA199TQ","item":"pi_TJWA8ZFQNDZAQGNZ","policy_version":1,"reason":"schema_change","ruleset_version":1,"type":"schema_change"}', 'e79928c323bb684079bbe089fc5af37ae22f078ecbc960cca44ddf197c1d3c59', NULL, NULL, NULL);
INSERT INTO public.content VALUES (73, 'confirmation', '{"hash":"03d5fb808f0b2d37ae8b1a1a10be9e4a364489da78514fb42384efd293dfa1fa"}', 'de49e54befa4ee880963634afc16fa8b0990cb46eed68f52db7318abcd8376ab', NULL, NULL, NULL);
INSERT INTO public.content VALUES (73, 'ctx', '{"now":"2026-11-26T10:24:00.950Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', '4983dd2d3532121b909c99a43dd4e4c36e8accad67fae939c7916dd770e25cdd', NULL, NULL, NULL);
INSERT INTO public.content VALUES (73, 'request_key', '{"key":"c1c02e26cbd0af911cc2e43aa71a64f2f390fd0d1db1c44775b203d47470945a"}', '8e064d2ce86740ef9ff69d3316467d3a2b62fe6dc9024763f8b8e014b8ba90ef', NULL, NULL, NULL);
INSERT INTO public.content VALUES (73, 'target', '{"decision":"confirm","item":"pi_TJWA8ZFQNDZAQGNZ","item_op":70,"restore_count":0,"via":"call"}', '4d8c034e2a34d6f3fc2e98fd6f201ada4289ba4cfc4ed15f0f7a7f1d1837b2f8', NULL, NULL, NULL);
INSERT INTO public.content VALUES (74, 'target', '{"by":"resolve","draft_id":"d_F167Z43KSDA199TQ","target_version":2}', '9f229d8bce4b7771dab15d991e77354fcea681d70b61a9a6b52fb83733c365c9', NULL, NULL, NULL);
INSERT INTO public.content VALUES (75, 'target', '{"draft_id":"d_F167Z43KSDA199TQ","from_version":1,"rebuilt_tables":[],"to_version":2}', '959b53baadb0a67298457a4453944315fb98b953ee7826ebddd1c0aa9de8dc4f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (76, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-26T10:24:00.958Z","policy_version":1,"ruleset_version":1,"today":"2026-11-26"}', '2e2a2d5063903211909ef3135a2e3d57486859f68adffbd97f7ede365b51e9ff', NULL, NULL, NULL);
INSERT INTO public.content VALUES (76, 'ops/0/set/f1', '"2026-11-02"', 'bb1de3879fc3904da5b8b20834d8d58eac44c618f8305a7357557ae506daf77f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (76, 'ops/0/set/f2', '"54"', '6ce1ced1ac1f56f8cd7ee5c55d117fe99c805b89a603e36c41852fea49853068', NULL, NULL, NULL);
INSERT INTO public.content VALUES (76, 'ops/0/set/f3', '"lunch"', '861315d6dc2fae3332121172cefb27dbbc4f45d0422d6c7a700e861baadf4f8d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (76, 'ops/0/target', '{"created":true,"intent":"insert","row":"r_047CXK0KKCHDC8T7TT1ZNG3F7R","table":"t1"}', '74ee2b858a7fcd2f8da0dd8ab985f4fd102778374c4198643275b3d6d0bb9d56', NULL, NULL, NULL);
INSERT INTO public.content VALUES (76, 'request', '{"op_count":1,"sv":2,"sv_basis":"explicit"}', 'a74c20685730197cad3bdf00d44171528e34875666d0088bb413439168684720', NULL, NULL, NULL);
INSERT INTO public.content VALUES (76, 'request_key', '{"key":"7f34af4852bdec0d3b8223e260544ef945a7ff8c5a84b43d92bafe56bb5a0a7b"}', '509d1039d2e0f0f5cfb16169687d8a077b043bc670cc04902b542b32d0e2a9f8', NULL, NULL, NULL);
INSERT INTO public.content VALUES (77, 'request', '{"intent":"insert","set":{"amount":54,"date":"2026-11-02","note":"lunch"},"table":"household.expenses"}', '64abd79da09e7c9d152c42454e0bd41e06d67e29df69c6799ab66549d01ac863', NULL, NULL, NULL);
INSERT INTO public.content VALUES (77, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_F7TZKBYQ5KHW25RE"}', 'd1f7072208a9f7f82595e0d789c2f5b21b774e35d2ea22989935c8ca83808af6', NULL, NULL, NULL);
INSERT INTO public.content VALUES (78, 'duplicate', '{"deps":[{"event":11,"field":"f1","k":0},{"event":11,"field":"f3","k":0}],"keys":["f1","f3"],"matched":["r_C4WC0TZ9MW9KV39M6FM7M2BGEW"]}', '09f0665829e46eecdd070fa87dfcbe215f91cbbbc335a60385ff89a6351912bb', NULL, NULL, NULL);
INSERT INTO public.content VALUES (78, 'fields/f1/0', '{"status":"applied","value":"2026-11-02"}', '96a119bb0a7bc53bfaa2b66ba49a944c8959ef63f8218c5af954c7f093c803a2', NULL, NULL, NULL);
INSERT INTO public.content VALUES (78, 'fields/f2/0', '{"status":"applied","value":"54"}', '3066d5922eca1709cab4c55d047596dc085c9289eb0e69902f10bdafc414ee89', NULL, NULL, NULL);
INSERT INTO public.content VALUES (78, 'fields/f3/0', '{"status":"applied","value":"lunch"}', 'a8db5f8cb5beb8cfabf3f12f93582fbff4f01c4d1eb78418794404af42f5b882', NULL, NULL, NULL);
INSERT INTO public.content VALUES (78, 'literal/f1/0', '{"segments":[{"result":"na","source":77}]}', '81e888daa6120c79b25f27fc5d8c481793d02789d0971c34a13d47155c5ff199', NULL, NULL, NULL);
INSERT INTO public.content VALUES (78, 'literal/f2/0', '{"segments":[{"result":"na","source":77}]}', '81e888daa6120c79b25f27fc5d8c481793d02789d0971c34a13d47155c5ff199', NULL, NULL, NULL);
INSERT INTO public.content VALUES (78, 'literal/f3/0', '{"segments":[{"result":"na","source":77}]}', '81e888daa6120c79b25f27fc5d8c481793d02789d0971c34a13d47155c5ff199', NULL, NULL, NULL);
INSERT INTO public.content VALUES (78, 'sources/f1/0', '[{"kind":"value","source":77}]', '22850f5523ca85c02320c00c5c5fe4e8fad64a89e93440d63dc8c883897241cf', NULL, NULL, NULL);
INSERT INTO public.content VALUES (78, 'sources/f2/0', '[{"kind":"value","source":77}]', '22850f5523ca85c02320c00c5c5fe4e8fad64a89e93440d63dc8c883897241cf', NULL, NULL, NULL);
INSERT INTO public.content VALUES (78, 'sources/f3/0', '[{"kind":"value","source":77}]', '22850f5523ca85c02320c00c5c5fe4e8fad64a89e93440d63dc8c883897241cf', NULL, NULL, NULL);
INSERT INTO public.content VALUES (78, 'target', '{"cause":"request","created":true,"intent":"insert","op_index":0,"row":"r_047CXK0KKCHDC8T7TT1ZNG3F7R","sv":2,"table":"t1"}', '5f2a2ee81f7d8b977b5604cefc3911c51f7bd7c5faa76e649613bbf638592d42', NULL, NULL, NULL);
INSERT INTO public.content VALUES (79, 'matched/0', '{"deps":[{"event":11,"field":"f1","k":0},{"event":11,"field":"f3","k":0}],"row":"r_C4WC0TZ9MW9KV39M6FM7M2BGEW"}', '804364b8763f7dd180defa4ff9439baa42c3428ebebc98c3268a259d0974cf44', NULL, NULL, NULL);
INSERT INTO public.content VALUES (79, 'target', '{"item":"pi_CDQ05X3CBRNY8C9G","origin_event":78,"policy_version":1,"reason":"duplicate_keys","row":"r_047CXK0KKCHDC8T7TT1ZNG3F7R","ruleset_version":1,"table":"t1","type":"flagged"}', '59c8d2df1817da2b562c573b20b1f43a0e66f130380fa6ef78d20c54e01030b1', NULL, NULL, NULL);
INSERT INTO public.content VALUES (80, 'checksum', '{"checksum":"de432ee0c24bcd914a70fefa7457ec86c06af752003ca5879b13c44543fbe0b6"}', '5adbe56a288cf0004001e455cd5ccc221f0eb732919443c0cb8a513d71836a66', NULL, NULL, NULL);
INSERT INTO public.content VALUES (80, 'target', '{"emptied":false,"partition":"p_1A6GGZGCVMBPEGH2","read_pos":79,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', '94efb971bd78b4203d0d6e0a9e079079b7aadf77e975d6d1646fc17b4c2aa748', NULL, NULL, NULL);


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

INSERT INTO public.d_t5_v1 VALUES ('p_TKDQNSS61VC5BNW4', '2026-11-04', 9, 1, 37);
INSERT INTO public.d_t5_v1 VALUES ('p_1A6GGZGCVMBPEGH2', '2026-11-02', 140, 3, 76);


--
-- Data for Name: deletions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: derived_reads; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.derived_reads VALUES (12, 't1', 'p_1A6GGZGCVMBPEGH2', 1, 11);
INSERT INTO public.derived_reads VALUES (16, 't1', 'p_1A6GGZGCVMBPEGH2', 1, 15);
INSERT INTO public.derived_reads VALUES (20, 't1', 'p_RCBX19D6XW61VY3W', 1, 19);
INSERT INTO public.derived_reads VALUES (24, 't1', 'p_1A6GGZGCVMBPEGH2', 1, 23);
INSERT INTO public.derived_reads VALUES (28, 't1', 'p_RCBX19D6XW61VY3W', 1, 27);
INSERT INTO public.derived_reads VALUES (32, 't1', 'p_TKDQNSS61VC5BNW4', 1, 31);
INSERT INTO public.derived_reads VALUES (36, 't1', 'p_TKDQNSS61VC5BNW4', 1, 35);
INSERT INTO public.derived_reads VALUES (40, 't1', 'p_TKDQNSS61VC5BNW4', 1, 39);
INSERT INTO public.derived_reads VALUES (44, 't1', 'p_1A6GGZGCVMBPEGH2', 1, 43);
INSERT INTO public.derived_reads VALUES (80, 't1', 'p_1A6GGZGCVMBPEGH2', 1, 79);


--
-- Data for Name: events; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.events VALUES (1, '{"actor":"u_56KR08SH4FN38WQ94ZVTTS80BE","at":"2026-11-26T10:24:00.612Z","node_id":"n_34DQABVYVB2G4HH4HYYXP5HMTY","prev_hash":"0000000000000000000000000000000000000000000000000000000000000000","seq":1,"type":"tenant.genesis","v":1}', 'fe52b5aa54c928d5a5f12a44c7954724a310fad15f10edb195eda8f0dc1f03a6', 'tenant.genesis', 'u_56KR08SH4FN38WQ94ZVTTS80BE', '2026-11-26T10:24:00.612Z', 1, NULL, NULL, NULL, NULL);
INSERT INTO public.events VALUES (2, '{"actor":"u_56KR08SH4FN38WQ94ZVTTS80BE","at":"2026-11-26T10:24:00.803Z","prev_hash":"fe52b5aa54c928d5a5f12a44c7954724a310fad15f10edb195eda8f0dc1f03a6","seq":2,"slot":"sl_BYREFGP1VJ4RR4G4","type":"schema.draft_submitted","v":1}', '0afd890ba8693fa0bbf868a1e3c68828104ac21814b07ff2da92bf72b320e0f2', 'schema.draft_submitted', 'u_56KR08SH4FN38WQ94ZVTTS80BE', '2026-11-26T10:24:00.803Z', 2, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (3, '{"actor":"u_56KR08SH4FN38WQ94ZVTTS80BE","at":"2026-11-26T10:24:00.803Z","op":2,"prev_hash":"0afd890ba8693fa0bbf868a1e3c68828104ac21814b07ff2da92bf72b320e0f2","seq":3,"slot":"sl_BYREFGP1VJ4RR4G4","type":"schema.compiled","v":1}', '299d5eb2dd72500f44d7aa00e8707995a045330029163b096bc4b69a2e099a7f', 'schema.compiled', 'u_56KR08SH4FN38WQ94ZVTTS80BE', '2026-11-26T10:24:00.803Z', 2, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (4, '{"actor":"u_56KR08SH4FN38WQ94ZVTTS80BE","at":"2026-11-26T10:24:00.803Z","op":2,"prev_hash":"299d5eb2dd72500f44d7aa00e8707995a045330029163b096bc4b69a2e099a7f","seq":4,"slot":"sl_BYREFGP1VJ4RR4G4","type":"schema.confirmed","v":1}', 'f548b6f2ef82ce0b05b5cb4d409fa4a89a1c151cef262725c55680f88be2f7f0', 'schema.confirmed', 'u_56KR08SH4FN38WQ94ZVTTS80BE', '2026-11-26T10:24:00.803Z', 2, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (5, '{"actor":"u_56KR08SH4FN38WQ94ZVTTS80BE","at":"2026-11-26T10:24:00.803Z","op":2,"prev_hash":"f548b6f2ef82ce0b05b5cb4d409fa4a89a1c151cef262725c55680f88be2f7f0","seq":5,"slot":"sl_BYREFGP1VJ4RR4G4","type":"slot.policy_set","v":1}', '488c982e00d3adb754b1e2c9cbe08e17dd07ed3f34ae07c64d48827e1ed7b70a', 'slot.policy_set', 'u_56KR08SH4FN38WQ94ZVTTS80BE', '2026-11-26T10:24:00.803Z', 2, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (6, '{"actor":"u_56KR08SH4FN38WQ94ZVTTS80BE","at":"2026-11-26T10:24:00.803Z","op":2,"prev_hash":"488c982e00d3adb754b1e2c9cbe08e17dd07ed3f34ae07c64d48827e1ed7b70a","seq":6,"slot":"sl_BYREFGP1VJ4RR4G4","type":"schema.switched","v":1}', 'ba2a456e5cac98336cb1fe0417e0d67ee9fd38298735adf8413fd761c5961146', 'schema.switched', 'u_56KR08SH4FN38WQ94ZVTTS80BE', '2026-11-26T10:24:00.803Z', 2, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (7, '{"actor":"u_56KR08SH4FN38WQ94ZVTTS80BE","at":"2026-11-26T10:24:00.817Z","prev_hash":"ba2a456e5cac98336cb1fe0417e0d67ee9fd38298735adf8413fd761c5961146","seq":7,"type":"principal.registered","v":1}', '3730709afaee122205988acc9234511108f0c40b0d431bd71d70eb143e8a727f', 'principal.registered', 'u_56KR08SH4FN38WQ94ZVTTS80BE', '2026-11-26T10:24:00.817Z', 7, NULL, NULL, NULL, NULL);
INSERT INTO public.events VALUES (8, '{"actor":"u_56KR08SH4FN38WQ94ZVTTS80BE","at":"2026-11-26T10:24:00.818Z","prev_hash":"3730709afaee122205988acc9234511108f0c40b0d431bd71d70eb143e8a727f","seq":8,"type":"principal.registered","v":1}', '983d81a25a0fb24a9d1453c30b06941065a94d2d084576174cbb6643929d3502', 'principal.registered', 'u_56KR08SH4FN38WQ94ZVTTS80BE', '2026-11-26T10:24:00.818Z', 8, NULL, NULL, NULL, NULL);
INSERT INTO public.events VALUES (9, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.820Z","prev_hash":"983d81a25a0fb24a9d1453c30b06941065a94d2d084576174cbb6643929d3502","seq":9,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.head","v":1}', 'bb7c3143eb926dde859fa79b030accbdad1ec97fedadf426cd57f3c2327af25b', 'write.head', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.820Z', 9, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (10, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.820Z","op":9,"prev_hash":"bb7c3143eb926dde859fa79b030accbdad1ec97fedadf426cd57f3c2327af25b","seq":10,"slot":"sl_BYREFGP1VJ4RR4G4","type":"source.recorded","v":1}', 'd91639c15c3502029f478775b6149c6677c103a769f8a7daeec37bd0278fe477', 'source.recorded', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.820Z', 9, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (11, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.820Z","op":9,"prev_hash":"d91639c15c3502029f478775b6149c6677c103a769f8a7daeec37bd0278fe477","seq":11,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.base","v":1}', 'aeffc26fdcd592b4be7e968dcd3172e487c60999f85aa8b61a247ac5f1c96519', 'write.base', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.820Z', 9, 'sl_BYREFGP1VJ4RR4G4', 't1', 'r_C4WC0TZ9MW9KV39M6FM7M2BGEW', NULL);
INSERT INTO public.events VALUES (12, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.820Z","op":9,"prev_hash":"aeffc26fdcd592b4be7e968dcd3172e487c60999f85aa8b61a247ac5f1c96519","seq":12,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.derived","v":1}', '72da72647fa6cd66c4052320f3b642c06da398c0d4421ea9bce32a868c81fbe7', 'write.derived', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.820Z', 9, 'sl_BYREFGP1VJ4RR4G4', 't5', NULL, NULL);
INSERT INTO public.events VALUES (13, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.830Z","prev_hash":"72da72647fa6cd66c4052320f3b642c06da398c0d4421ea9bce32a868c81fbe7","seq":13,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.head","v":1}', '44229a4955c609c67422eae860f521dbd23d582ba15fe6f35051ae3513a2fe00', 'write.head', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.830Z', 13, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (14, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.830Z","op":13,"prev_hash":"44229a4955c609c67422eae860f521dbd23d582ba15fe6f35051ae3513a2fe00","seq":14,"slot":"sl_BYREFGP1VJ4RR4G4","type":"source.recorded","v":1}', '16ed00eba374e5347e89304c439a8d09c0ce1fc84a9847c14714bb8bb71a7869', 'source.recorded', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.830Z', 13, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (15, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.830Z","op":13,"prev_hash":"16ed00eba374e5347e89304c439a8d09c0ce1fc84a9847c14714bb8bb71a7869","seq":15,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.base","v":1}', 'e324e537cac925b36f196369e647ce322865595eb70a73189ec1b817f1fd8e72', 'write.base', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.830Z', 13, 'sl_BYREFGP1VJ4RR4G4', 't1', 'r_50D60TYRBBBBC4YYA5JR7XPFQC', NULL);
INSERT INTO public.events VALUES (16, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.830Z","op":13,"prev_hash":"e324e537cac925b36f196369e647ce322865595eb70a73189ec1b817f1fd8e72","seq":16,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.derived","v":1}', '157c8bcceaca862429e996e4e9014478aa3258c2ff9ad4cdf4c9182c8c842883', 'write.derived', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.830Z', 13, 'sl_BYREFGP1VJ4RR4G4', 't5', NULL, NULL);
INSERT INTO public.events VALUES (17, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.837Z","prev_hash":"157c8bcceaca862429e996e4e9014478aa3258c2ff9ad4cdf4c9182c8c842883","seq":17,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.head","v":1}', '83d4ce3910dd0cb64102b3473a7a69f78dfa717ce72dd6a2cdedc8b5d809b756', 'write.head', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.837Z', 17, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (18, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.837Z","op":17,"prev_hash":"83d4ce3910dd0cb64102b3473a7a69f78dfa717ce72dd6a2cdedc8b5d809b756","seq":18,"slot":"sl_BYREFGP1VJ4RR4G4","type":"source.recorded","v":1}', 'b707708c22b879137a88a858878293ac91200babf426156a2f864a2dc9d41547', 'source.recorded', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.837Z', 17, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (19, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.837Z","op":17,"prev_hash":"b707708c22b879137a88a858878293ac91200babf426156a2f864a2dc9d41547","seq":19,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.base","v":1}', 'c923af76297834d2c1dbfe0a81201f2338d62b8e13a3b07006cdd77809198cf8', 'write.base', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.837Z', 17, 'sl_BYREFGP1VJ4RR4G4', 't1', 'r_XKM34Y62T0YDHRY8NEE15FJ0QK', NULL);
INSERT INTO public.events VALUES (20, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.837Z","op":17,"prev_hash":"c923af76297834d2c1dbfe0a81201f2338d62b8e13a3b07006cdd77809198cf8","seq":20,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.derived","v":1}', '61cd23397cb931e87bb475145a7c7cfce00bcc9c24b351e4863116f3d6a665f9', 'write.derived', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.837Z', 17, 'sl_BYREFGP1VJ4RR4G4', 't5', NULL, NULL);
INSERT INTO public.events VALUES (21, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.844Z","prev_hash":"61cd23397cb931e87bb475145a7c7cfce00bcc9c24b351e4863116f3d6a665f9","seq":21,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.head","v":1}', '312fcd0f5b039772ec875f857a635d870a679f4dabfc90c24e5ee440f4905ea3', 'write.head', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.844Z', 21, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (22, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.844Z","op":21,"prev_hash":"312fcd0f5b039772ec875f857a635d870a679f4dabfc90c24e5ee440f4905ea3","seq":22,"slot":"sl_BYREFGP1VJ4RR4G4","type":"source.recorded","v":1}', '2c59f429c0e406ea0dc5af4d27ebc15fb55f722a23bb7b660b60d229e1781735', 'source.recorded', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.844Z', 21, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (23, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.844Z","op":21,"prev_hash":"2c59f429c0e406ea0dc5af4d27ebc15fb55f722a23bb7b660b60d229e1781735","seq":23,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.base","v":1}', '48fb6771d27b4f94fc40213406c311f95558bbbeb74e58b7f0d3a9abc1c3edd5', 'write.base', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.844Z', 21, 'sl_BYREFGP1VJ4RR4G4', 't1', 'r_C4WC0TZ9MW9KV39M6FM7M2BGEW', NULL);
INSERT INTO public.events VALUES (24, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.844Z","op":21,"prev_hash":"48fb6771d27b4f94fc40213406c311f95558bbbeb74e58b7f0d3a9abc1c3edd5","seq":24,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.derived","v":1}', '36ca4b232fed62726a8891bc7fa7b7f74effeb5bb15969d7e5c1e410fc66eedc', 'write.derived', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.844Z', 21, 'sl_BYREFGP1VJ4RR4G4', 't5', NULL, NULL);
INSERT INTO public.events VALUES (25, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.851Z","prev_hash":"36ca4b232fed62726a8891bc7fa7b7f74effeb5bb15969d7e5c1e410fc66eedc","seq":25,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.head","v":1}', 'ebfe5fb5fd054c9e9dfe425ead1b889a764a48096669e46fe94b1d152b9e277b', 'write.head', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.851Z', 25, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (26, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.851Z","op":25,"prev_hash":"ebfe5fb5fd054c9e9dfe425ead1b889a764a48096669e46fe94b1d152b9e277b","seq":26,"slot":"sl_BYREFGP1VJ4RR4G4","type":"source.recorded","v":1}', 'a4549b7a935732aff4d8bdbcea07128c2e835b7955613399f35e24fcb1668242', 'source.recorded', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.851Z', 25, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (27, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.851Z","op":25,"prev_hash":"a4549b7a935732aff4d8bdbcea07128c2e835b7955613399f35e24fcb1668242","seq":27,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.base","v":1}', 'b4134b07c715e3dbb5e89de57e4ee50f02932a9e910c38cf04a896ab8ae329c4', 'write.base', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.851Z', 25, 'sl_BYREFGP1VJ4RR4G4', 't1', 'r_XKM34Y62T0YDHRY8NEE15FJ0QK', NULL);
INSERT INTO public.events VALUES (28, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.851Z","op":25,"prev_hash":"b4134b07c715e3dbb5e89de57e4ee50f02932a9e910c38cf04a896ab8ae329c4","seq":28,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.derived","v":1}', '489a6e9b64d6b5802b65975bfb01ac75bc97a9d3714091e7648a25eba97f1def', 'write.derived', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.851Z', 25, 'sl_BYREFGP1VJ4RR4G4', 't5', NULL, NULL);
INSERT INTO public.events VALUES (29, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.858Z","prev_hash":"489a6e9b64d6b5802b65975bfb01ac75bc97a9d3714091e7648a25eba97f1def","seq":29,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.head","v":1}', '13615dede5f0ec9f7cda8b25ce6235f765021428a4e622a1108d3ce5e3f1cb94', 'write.head', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.858Z', 29, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (30, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.858Z","op":29,"prev_hash":"13615dede5f0ec9f7cda8b25ce6235f765021428a4e622a1108d3ce5e3f1cb94","seq":30,"slot":"sl_BYREFGP1VJ4RR4G4","type":"source.recorded","v":1}', '753fca93b73d9226959d5c93d3fe5a9eccd38db5cc90bf68425898db218d53e9', 'source.recorded', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.858Z', 29, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (31, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.858Z","op":29,"prev_hash":"753fca93b73d9226959d5c93d3fe5a9eccd38db5cc90bf68425898db218d53e9","seq":31,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.base","v":1}', '3e4499702907344440b32d9110323d8c051b0564db708d6c95f08810458f6d60', 'write.base', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.858Z', 29, 'sl_BYREFGP1VJ4RR4G4', 't1', 'r_T85ET4XD7CJG6DYYPF7TXJ32S4', NULL);
INSERT INTO public.events VALUES (32, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.858Z","op":29,"prev_hash":"3e4499702907344440b32d9110323d8c051b0564db708d6c95f08810458f6d60","seq":32,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.derived","v":1}', '20a30f3b5448bba22fd341c3576dbbe49a763907d20408fc214e6fab07bc325a', 'write.derived', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.858Z', 29, 'sl_BYREFGP1VJ4RR4G4', 't5', NULL, NULL);
INSERT INTO public.events VALUES (33, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.865Z","prev_hash":"20a30f3b5448bba22fd341c3576dbbe49a763907d20408fc214e6fab07bc325a","seq":33,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.head","v":1}', '528f26945e15f87ae52d37fdbd614512bd68a03837186389b8b788fbe1658058', 'write.head', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.865Z', 33, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (34, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.865Z","op":33,"prev_hash":"528f26945e15f87ae52d37fdbd614512bd68a03837186389b8b788fbe1658058","seq":34,"slot":"sl_BYREFGP1VJ4RR4G4","type":"source.recorded","v":1}', 'ab4d4b9232f88ba97eb34133bf20092c2ef9b0d875e03dec9c238360cee957d0', 'source.recorded', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.865Z', 33, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (35, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.865Z","op":33,"prev_hash":"ab4d4b9232f88ba97eb34133bf20092c2ef9b0d875e03dec9c238360cee957d0","seq":35,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.base","v":1}', '6edc90736370dd51357d64d1ccf3cc63e770d66dc8fdd8ad47447641965b375c', 'write.base', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.865Z', 33, 'sl_BYREFGP1VJ4RR4G4', 't1', 'r_T85ET4XD7CJG6DYYPF7TXJ32S4', NULL);
INSERT INTO public.events VALUES (36, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.865Z","op":33,"prev_hash":"6edc90736370dd51357d64d1ccf3cc63e770d66dc8fdd8ad47447641965b375c","seq":36,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.derived","v":1}', '74f95fab5cc484dc1ac66ad5c16c8814472bbcf85da89f688753aec7f7d9a45e', 'write.derived', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.865Z', 33, 'sl_BYREFGP1VJ4RR4G4', 't5', NULL, NULL);
INSERT INTO public.events VALUES (37, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.870Z","prev_hash":"74f95fab5cc484dc1ac66ad5c16c8814472bbcf85da89f688753aec7f7d9a45e","seq":37,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.head","v":1}', '4e4c9e38ffee7d9897e43cd10bca9e6920aad4104e6b10f78e9c51ed5e267779', 'write.head', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.870Z', 37, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (38, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.870Z","op":37,"prev_hash":"4e4c9e38ffee7d9897e43cd10bca9e6920aad4104e6b10f78e9c51ed5e267779","seq":38,"slot":"sl_BYREFGP1VJ4RR4G4","type":"source.recorded","v":1}', 'bbc36e992841241f952944a9cbffc401d4927634e456998d471a2da68190c0ee', 'source.recorded', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.870Z', 37, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (39, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.870Z","op":37,"prev_hash":"bbc36e992841241f952944a9cbffc401d4927634e456998d471a2da68190c0ee","seq":39,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.base","v":1}', 'ebdf3450457ea0617e71f40942ce1705685e64c6ff7ea0a5bf600e5e5d0a7fcd', 'write.base', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.870Z', 37, 'sl_BYREFGP1VJ4RR4G4', 't1', 'r_T85ET4XD7CJG6DYYPF7TXJ32S4', NULL);
INSERT INTO public.events VALUES (40, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.870Z","op":37,"prev_hash":"ebdf3450457ea0617e71f40942ce1705685e64c6ff7ea0a5bf600e5e5d0a7fcd","seq":40,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.derived","v":1}', '74f78c104ccb580565cf0be3ef4be2b2bf66254a91fca60d6cfc2e094a3532a9', 'write.derived', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.870Z', 37, 'sl_BYREFGP1VJ4RR4G4', 't5', NULL, NULL);
INSERT INTO public.events VALUES (41, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.876Z","prev_hash":"74f78c104ccb580565cf0be3ef4be2b2bf66254a91fca60d6cfc2e094a3532a9","seq":41,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.head","v":1}', 'd735f381e2ae76793f9addf50a34b8a48f96fa827d890827393562540d2c81f6', 'write.head', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.876Z', 41, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (42, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.876Z","op":41,"prev_hash":"d735f381e2ae76793f9addf50a34b8a48f96fa827d890827393562540d2c81f6","seq":42,"slot":"sl_BYREFGP1VJ4RR4G4","type":"source.recorded","v":1}', '1f6e51e44ce3fade08bea16b1aceddd106fa1028f26df825675dbf6f7936b0e9', 'source.recorded', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.876Z', 41, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (43, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.876Z","op":41,"prev_hash":"1f6e51e44ce3fade08bea16b1aceddd106fa1028f26df825675dbf6f7936b0e9","seq":43,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.base","v":1}', 'e7c50cf46b5b3ea03eee823873c7356509666e355023fc5ac0a083c064fcaf83', 'write.base', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.876Z', 41, 'sl_BYREFGP1VJ4RR4G4', 't1', 'r_50D60TYRBBBBC4YYA5JR7XPFQC', NULL);
INSERT INTO public.events VALUES (44, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.876Z","op":41,"prev_hash":"e7c50cf46b5b3ea03eee823873c7356509666e355023fc5ac0a083c064fcaf83","seq":44,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.derived","v":1}', '679f6ff50dbaaa74ea0624ed93c4123c613dea57fe78d979385cfc2ee7cdde01', 'write.derived', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.876Z', 41, 'sl_BYREFGP1VJ4RR4G4', 't5', NULL, NULL);
INSERT INTO public.events VALUES (45, '{"actor":"ci_MQ1E9ZQKDSK2NPCKTM2CSHEVSB","at":"2026-11-26T10:24:00.882Z","prev_hash":"679f6ff50dbaaa74ea0624ed93c4123c613dea57fe78d979385cfc2ee7cdde01","seq":45,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.head","v":1}', '0f90e3161f6b6bc202e1a9aa76a1e835c76cb50f9ea1bbf7dd1fecaf88fde5c1', 'write.head', 'ci_MQ1E9ZQKDSK2NPCKTM2CSHEVSB', '2026-11-26T10:24:00.882Z', 45, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (46, '{"actor":"ci_MQ1E9ZQKDSK2NPCKTM2CSHEVSB","at":"2026-11-26T10:24:00.882Z","op":45,"prev_hash":"0f90e3161f6b6bc202e1a9aa76a1e835c76cb50f9ea1bbf7dd1fecaf88fde5c1","seq":46,"slot":"sl_BYREFGP1VJ4RR4G4","type":"source.recorded","v":1}', '18aeb18471ec6a3f4940fbdce59a446e3fdab223fcf2a35b6e2835db1c9f6ab1', 'source.recorded', 'ci_MQ1E9ZQKDSK2NPCKTM2CSHEVSB', '2026-11-26T10:24:00.882Z', 45, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (47, '{"actor":"ci_MQ1E9ZQKDSK2NPCKTM2CSHEVSB","at":"2026-11-26T10:24:00.882Z","op":45,"prev_hash":"18aeb18471ec6a3f4940fbdce59a446e3fdab223fcf2a35b6e2835db1c9f6ab1","seq":47,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.base","v":1}', 'b6d08d544bca5120ddfc9add4940ab4a05665d89eb7a06b2ae803463b3010d8a', 'write.base', 'ci_MQ1E9ZQKDSK2NPCKTM2CSHEVSB', '2026-11-26T10:24:00.882Z', 45, 'sl_BYREFGP1VJ4RR4G4', 't1', 'r_50D60TYRBBBBC4YYA5JR7XPFQC', NULL);
INSERT INTO public.events VALUES (48, '{"actor":"ci_MQ1E9ZQKDSK2NPCKTM2CSHEVSB","at":"2026-11-26T10:24:00.882Z","op":45,"prev_hash":"b6d08d544bca5120ddfc9add4940ab4a05665d89eb7a06b2ae803463b3010d8a","seq":48,"slot":"sl_BYREFGP1VJ4RR4G4","type":"item.created","v":1}', '03f322249122dff10509fa36dac5a7c3f2b9304c513d76d933203fbc90376167', 'item.created', 'ci_MQ1E9ZQKDSK2NPCKTM2CSHEVSB', '2026-11-26T10:24:00.882Z', 45, 'sl_BYREFGP1VJ4RR4G4', 't1', 'r_50D60TYRBBBBC4YYA5JR7XPFQC', 47);
INSERT INTO public.events VALUES (49, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.889Z","prev_hash":"03f322249122dff10509fa36dac5a7c3f2b9304c513d76d933203fbc90376167","seq":49,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.head","v":1}', 'd50116a07eb67e8f9ee597afa45653a80cf1749785763171dd89935f28653ec0', 'write.head', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.889Z', 49, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (50, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.889Z","op":49,"prev_hash":"d50116a07eb67e8f9ee597afa45653a80cf1749785763171dd89935f28653ec0","seq":50,"slot":"sl_BYREFGP1VJ4RR4G4","type":"source.recorded","v":1}', 'fe818dab7dc9f25c44a9f54258614b0f33565fa6fdaf0d52febc6cc81e00d327', 'source.recorded', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.889Z', 49, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (51, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.889Z","op":49,"prev_hash":"fe818dab7dc9f25c44a9f54258614b0f33565fa6fdaf0d52febc6cc81e00d327","seq":51,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.base","v":1}', 'accf06dbf1173d680f04a0cb4d806287a2b3518867473af4bace160dedbeef2b', 'write.base', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.889Z', 49, 'sl_BYREFGP1VJ4RR4G4', 't4', 'r_Q4GGB4SGJ8C2HAYPACA4F35J5P', NULL);
INSERT INTO public.events VALUES (52, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.895Z","prev_hash":"accf06dbf1173d680f04a0cb4d806287a2b3518867473af4bace160dedbeef2b","seq":52,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.head","v":1}', '6074ec372cae0087db95af03b54433d6049a4e2ce419d8557289b3d6dc18a248', 'write.head', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.895Z', 52, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (53, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.895Z","op":52,"prev_hash":"6074ec372cae0087db95af03b54433d6049a4e2ce419d8557289b3d6dc18a248","seq":53,"slot":"sl_BYREFGP1VJ4RR4G4","type":"source.recorded","v":1}', '27d89295d0b242402a3ea6bb23cc01fad03969aee3da7817550e20adcd4d5c07', 'source.recorded', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.895Z', 52, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (54, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.895Z","op":52,"prev_hash":"27d89295d0b242402a3ea6bb23cc01fad03969aee3da7817550e20adcd4d5c07","seq":54,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.base","v":1}', 'b94bfa56801aa48ffb3cbe8725283cc4473cdab4dd16153485c024dc0ef6ec1f', 'write.base', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.895Z', 52, 'sl_BYREFGP1VJ4RR4G4', 't2', 'e_A0WPAB33GA6A9KGT7CK6B0V7NP', NULL);
INSERT INTO public.events VALUES (55, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.901Z","prev_hash":"b94bfa56801aa48ffb3cbe8725283cc4473cdab4dd16153485c024dc0ef6ec1f","seq":55,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.head","v":1}', 'a983c7e36898774d8a8faf013adcabf939368555c3b6ea19a63c1dad06a9ce2f', 'write.head', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.901Z', 55, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (56, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.901Z","op":55,"prev_hash":"a983c7e36898774d8a8faf013adcabf939368555c3b6ea19a63c1dad06a9ce2f","seq":56,"slot":"sl_BYREFGP1VJ4RR4G4","type":"source.recorded","v":1}', '686d9e9ef72b21a65d907c8d43cf7ceb767761008ca9300aab069ab43edefe83', 'source.recorded', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.901Z', 55, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (57, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.901Z","op":55,"prev_hash":"686d9e9ef72b21a65d907c8d43cf7ceb767761008ca9300aab069ab43edefe83","seq":57,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.base","v":1}', 'd7b2a4db03025a738de7b6b844780293b44cdc365000cecbaa4f5a3a63b62776', 'write.base', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.901Z', 55, 'sl_BYREFGP1VJ4RR4G4', 't2', 'e_A0WPAB33GA6A9KGT7CK6B0V7NP', NULL);
INSERT INTO public.events VALUES (58, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.907Z","prev_hash":"d7b2a4db03025a738de7b6b844780293b44cdc365000cecbaa4f5a3a63b62776","seq":58,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.head","v":1}', '5b984c91582003a26e3734c05b82b60cf9aa9b1b21863983712a843c757f9e09', 'write.head', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.907Z', 58, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (59, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.907Z","op":58,"prev_hash":"5b984c91582003a26e3734c05b82b60cf9aa9b1b21863983712a843c757f9e09","seq":59,"slot":"sl_BYREFGP1VJ4RR4G4","type":"source.recorded","v":1}', '0b701cac7dd3fb0d3a5bd719b7c3382a0299b2df15a4d955048e3b9eba4d1b57', 'source.recorded', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.907Z', 58, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (60, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.907Z","op":58,"prev_hash":"0b701cac7dd3fb0d3a5bd719b7c3382a0299b2df15a4d955048e3b9eba4d1b57","seq":60,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.base","v":1}', '4f61bdd0db5697a64ee1fc294a50a284f5bcb789211f23f82edc64beda884558', 'write.base', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.907Z', 58, 'sl_BYREFGP1VJ4RR4G4', 't2', 'e_A0WPAB33GA6A9KGT7CK6B0V7NP', NULL);
INSERT INTO public.events VALUES (61, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.907Z","op":58,"prev_hash":"4f61bdd0db5697a64ee1fc294a50a284f5bcb789211f23f82edc64beda884558","seq":61,"slot":"sl_BYREFGP1VJ4RR4G4","type":"item.created","v":1}', '4fa3c0dd39c1e35b4ce9401b06f6b53e0e19f3dfaab49370578f990de8429eb3', 'item.created', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.907Z', 58, 'sl_BYREFGP1VJ4RR4G4', 't2', 'e_A0WPAB33GA6A9KGT7CK6B0V7NP', 60);
INSERT INTO public.events VALUES (62, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.915Z","prev_hash":"4fa3c0dd39c1e35b4ce9401b06f6b53e0e19f3dfaab49370578f990de8429eb3","seq":62,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.head","v":1}', '8b8e79a9d87a38bf1d845ffd9e86312d287da8f3b8c7d344984a8fb153827a51', 'write.head', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.915Z', 62, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (63, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.915Z","op":62,"prev_hash":"8b8e79a9d87a38bf1d845ffd9e86312d287da8f3b8c7d344984a8fb153827a51","seq":63,"slot":"sl_BYREFGP1VJ4RR4G4","type":"source.recorded","v":1}', 'b582da54521efa62d59571de298cc18f29c0e3716a5f26cbead3d1e317d69155', 'source.recorded', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.915Z', 62, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (64, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.915Z","op":62,"prev_hash":"b582da54521efa62d59571de298cc18f29c0e3716a5f26cbead3d1e317d69155","seq":64,"slot":"sl_BYREFGP1VJ4RR4G4","type":"source.recorded","v":1}', '5bd054bdf4f8c388fb43b0b0cb7e237162b283964f3ce5d8fb802656ae595f16', 'source.recorded', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.915Z', 62, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (65, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.915Z","op":62,"prev_hash":"5bd054bdf4f8c388fb43b0b0cb7e237162b283964f3ce5d8fb802656ae595f16","seq":65,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.base","v":1}', 'fc459b9c7de1f9e2fcac2f42603591fa807b467439d803bd7fcdb5de1fd9c765', 'write.base', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.915Z', 62, 'sl_BYREFGP1VJ4RR4G4', 't3', 'r_CNBK4Y7984NPCYQ612C00Z4GV3', NULL);
INSERT INTO public.events VALUES (66, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.915Z","op":62,"prev_hash":"fc459b9c7de1f9e2fcac2f42603591fa807b467439d803bd7fcdb5de1fd9c765","seq":66,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.base","v":1}', '087d6ba6581fe6fb9496a50c0eb1bfbd46238fe7396bf7fc2853a508e46bc829', 'write.base', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.915Z', 62, 'sl_BYREFGP1VJ4RR4G4', 't3', 'r_CBA9K83Z66TNQJJ6Z0QM703JFP', NULL);
INSERT INTO public.events VALUES (67, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.923Z","prev_hash":"087d6ba6581fe6fb9496a50c0eb1bfbd46238fe7396bf7fc2853a508e46bc829","seq":67,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.head","v":1}', '78b994fa4262a48b1c48a9fd9eaa09cd1596df50651bebe69891d658d2625786', 'write.head', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.923Z', 67, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (68, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.923Z","op":67,"prev_hash":"78b994fa4262a48b1c48a9fd9eaa09cd1596df50651bebe69891d658d2625786","seq":68,"slot":"sl_BYREFGP1VJ4RR4G4","type":"source.recorded","v":1}', 'b7012798ac59a33ed3f9a518d9f38235f2edd4672ac02404a292fd0aaeb572a8', 'source.recorded', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.923Z', 67, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (69, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.923Z","op":67,"prev_hash":"b7012798ac59a33ed3f9a518d9f38235f2edd4672ac02404a292fd0aaeb572a8","seq":69,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.base","v":1}', 'fd73a7cd8d4143298fac4be3d6549a27c5e6844a2c43c9ec751ae637c6e3a302', 'write.base', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.923Z', 67, 'sl_BYREFGP1VJ4RR4G4', 't3', 'r_CNBK4Y7984NPCYQ612C00Z4GV3', NULL);
INSERT INTO public.events VALUES (70, '{"actor":"u_56KR08SH4FN38WQ94ZVTTS80BE","at":"2026-11-26T10:24:00.945Z","prev_hash":"fd73a7cd8d4143298fac4be3d6549a27c5e6844a2c43c9ec751ae637c6e3a302","seq":70,"slot":"sl_BYREFGP1VJ4RR4G4","type":"schema.draft_submitted","v":1}', 'f481ca3027d60d3dfc8c1bf07a8f90596e6e647e97d60c6dd7397e28037c8fd9', 'schema.draft_submitted', 'u_56KR08SH4FN38WQ94ZVTTS80BE', '2026-11-26T10:24:00.945Z', 70, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (71, '{"actor":"u_56KR08SH4FN38WQ94ZVTTS80BE","at":"2026-11-26T10:24:00.945Z","op":70,"prev_hash":"f481ca3027d60d3dfc8c1bf07a8f90596e6e647e97d60c6dd7397e28037c8fd9","seq":71,"slot":"sl_BYREFGP1VJ4RR4G4","type":"schema.compiled","v":1}', 'a4912d2d6f3e690414c1aa651f2dade4cdced68b9d9f7bd5d066a45b752873e8', 'schema.compiled', 'u_56KR08SH4FN38WQ94ZVTTS80BE', '2026-11-26T10:24:00.945Z', 70, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (72, '{"actor":"u_56KR08SH4FN38WQ94ZVTTS80BE","at":"2026-11-26T10:24:00.945Z","op":70,"prev_hash":"a4912d2d6f3e690414c1aa651f2dade4cdced68b9d9f7bd5d066a45b752873e8","seq":72,"slot":"sl_BYREFGP1VJ4RR4G4","type":"item.created","v":1}', '99eae4e13ceb3fcd4a004821f537407048e34dcfaa7adc5826fd4a0868a0739d', 'item.created', 'u_56KR08SH4FN38WQ94ZVTTS80BE', '2026-11-26T10:24:00.945Z', 70, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (73, '{"actor":"u_56KR08SH4FN38WQ94ZVTTS80BE","at":"2026-11-26T10:24:00.950Z","prev_hash":"99eae4e13ceb3fcd4a004821f537407048e34dcfaa7adc5826fd4a0868a0739d","seq":73,"slot":"sl_BYREFGP1VJ4RR4G4","type":"item.resolved","v":1}', '2995d80872a0408604cc8bd1b25192e1320dd8b5156cc24d43756815b85a64cc', 'item.resolved', 'u_56KR08SH4FN38WQ94ZVTTS80BE', '2026-11-26T10:24:00.950Z', 73, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (74, '{"actor":"u_56KR08SH4FN38WQ94ZVTTS80BE","at":"2026-11-26T10:24:00.950Z","op":73,"prev_hash":"2995d80872a0408604cc8bd1b25192e1320dd8b5156cc24d43756815b85a64cc","seq":74,"slot":"sl_BYREFGP1VJ4RR4G4","type":"schema.confirmed","v":1}', '1d3592ce240d905d4210ca80d5da9e97ef1d311dadca96367e0e50bdc8a461c3', 'schema.confirmed', 'u_56KR08SH4FN38WQ94ZVTTS80BE', '2026-11-26T10:24:00.950Z', 73, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (75, '{"actor":"u_56KR08SH4FN38WQ94ZVTTS80BE","at":"2026-11-26T10:24:00.950Z","op":73,"prev_hash":"1d3592ce240d905d4210ca80d5da9e97ef1d311dadca96367e0e50bdc8a461c3","seq":75,"slot":"sl_BYREFGP1VJ4RR4G4","type":"schema.switched","v":1}', '02c0e94424a50b4227ce354f2d5eeb82a56fe6a33e46d695217a6370a84657ad', 'schema.switched', 'u_56KR08SH4FN38WQ94ZVTTS80BE', '2026-11-26T10:24:00.950Z', 73, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (76, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.958Z","prev_hash":"02c0e94424a50b4227ce354f2d5eeb82a56fe6a33e46d695217a6370a84657ad","seq":76,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.head","v":1}', 'b1a28362d9d3b18f84831db665132f296cd14093693076a5503facac9b3304e6', 'write.head', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.958Z', 76, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (77, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.958Z","op":76,"prev_hash":"b1a28362d9d3b18f84831db665132f296cd14093693076a5503facac9b3304e6","seq":77,"slot":"sl_BYREFGP1VJ4RR4G4","type":"source.recorded","v":1}', 'fc980eff3d00f927250288f383590f4494c12b5eec357c96510efe025e72c15a', 'source.recorded', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.958Z', 76, 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, NULL);
INSERT INTO public.events VALUES (78, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.958Z","op":76,"prev_hash":"fc980eff3d00f927250288f383590f4494c12b5eec357c96510efe025e72c15a","seq":78,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.base","v":1}', '7ae35b542dd9c1f6ca4fec40902dc8b4247b602fec02c5b3f4ea73b125835682', 'write.base', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.958Z', 76, 'sl_BYREFGP1VJ4RR4G4', 't1', 'r_047CXK0KKCHDC8T7TT1ZNG3F7R', NULL);
INSERT INTO public.events VALUES (79, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.958Z","op":76,"prev_hash":"7ae35b542dd9c1f6ca4fec40902dc8b4247b602fec02c5b3f4ea73b125835682","seq":79,"slot":"sl_BYREFGP1VJ4RR4G4","type":"item.created","v":1}', 'cda872bfcbe5c7f556890d673d47c341efd0c5023341a47d3f73a1c08c8d6bd4', 'item.created', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.958Z', 76, 'sl_BYREFGP1VJ4RR4G4', 't1', 'r_047CXK0KKCHDC8T7TT1ZNG3F7R', 78);
INSERT INTO public.events VALUES (80, '{"actor":"ci_P0AW3DRZ1WEPA6ZFAC0955DK7W","at":"2026-11-26T10:24:00.958Z","op":76,"prev_hash":"cda872bfcbe5c7f556890d673d47c341efd0c5023341a47d3f73a1c08c8d6bd4","seq":80,"slot":"sl_BYREFGP1VJ4RR4G4","type":"write.derived","v":1}', 'a8a274fb309e5ae8dfef759118f04b7097fb895768d5656e08bb50fd03c2eb20', 'write.derived', 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '2026-11-26T10:24:00.958Z', 76, 'sl_BYREFGP1VJ4RR4G4', 't5', NULL, NULL);


--
-- Data for Name: external_keys; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: field_name_usage; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: flags; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.flags VALUES ('t1', 'r_50D60TYRBBBBC4YYA5JR7XPFQC', 'disputed', 'pi_JNX4SDNEBQJXPVKJ', '["f2"]', NULL);
INSERT INTO public.flags VALUES ('t2', 'e_A0WPAB33GA6A9KGT7CK6B0V7NP', 'awaiting', 'pi_WAWQM74JV1QDKF46', '["f2"]', '[{"from":"2026-10-15"}]');
INSERT INTO public.flags VALUES ('t1', 'r_047CXK0KKCHDC8T7TT1ZNG3F7R', 'flagged', 'pi_CDQ05X3CBRNY8C9G', NULL, NULL);


--
-- Data for Name: last_read; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.last_read VALUES ('ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '', 'e_A0WPAB33GA6A9KGT7CK6B0V7NP', 'ver', 55, 0, 'rd_3SV39F5J9NN0TXP6');
INSERT INTO public.last_read VALUES ('ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '', 'r_CNBK4Y7984NPCYQ612C00Z4GV3', 'ver', 67, 0, 'rd_Z1HZRNHWF27AYVT7');
INSERT INTO public.last_read VALUES ('ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '', 'r_CBA9K83Z66TNQJJ6Z0QM703JFP', 'ver', 62, 0, 'rd_Z1HZRNHWF27AYVT7');
INSERT INTO public.last_read VALUES ('ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '', 'r_Q4GGB4SGJ8C2HAYPACA4F35J5P', 'ver', 49, 0, 'rd_90PJBQ7N0Z8BK4SM');
INSERT INTO public.last_read VALUES ('ci_MQ1E9ZQKDSK2NPCKTM2CSHEVSB', '', 'r_C4WC0TZ9MW9KV39M6FM7M2BGEW', 'ver', 21, 0, 'rd_KAT08ARE6PYQGKVT');
INSERT INTO public.last_read VALUES ('ci_MQ1E9ZQKDSK2NPCKTM2CSHEVSB', '', 'sl_BYREFGP1VJ4RR4G4', 'sv', 1, 0, 'rd_KAT08ARE6PYQGKVT');
INSERT INTO public.last_read VALUES ('ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '', 'r_T85ET4XD7CJG6DYYPF7TXJ32S4', 'ver', 37, 0, 'rd_X36QQF8GZ7DQTA5C');
INSERT INTO public.last_read VALUES ('ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '', 'r_047CXK0KKCHDC8T7TT1ZNG3F7R', 'ver', 76, 0, 'rd_X36QQF8GZ7DQTA5C');
INSERT INTO public.last_read VALUES ('ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '', 'r_50D60TYRBBBBC4YYA5JR7XPFQC', 'ver', 41, 0, 'rd_X36QQF8GZ7DQTA5C');
INSERT INTO public.last_read VALUES ('ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '', 'r_C4WC0TZ9MW9KV39M6FM7M2BGEW', 'ver', 21, 0, 'rd_X36QQF8GZ7DQTA5C');
INSERT INTO public.last_read VALUES ('ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', '', 'sl_BYREFGP1VJ4RR4G4', 'sv', 2, 0, 'rd_X36QQF8GZ7DQTA5C');
INSERT INTO public.last_read VALUES ('u_56KR08SH4FN38WQ94ZVTTS80BE', '', 'r_T85ET4XD7CJG6DYYPF7TXJ32S4', 'ver', 37, 0, 'rd_F699D9MVCSFGHT1N');
INSERT INTO public.last_read VALUES ('u_56KR08SH4FN38WQ94ZVTTS80BE', '', 'r_047CXK0KKCHDC8T7TT1ZNG3F7R', 'ver', 76, 0, 'rd_F699D9MVCSFGHT1N');
INSERT INTO public.last_read VALUES ('u_56KR08SH4FN38WQ94ZVTTS80BE', '', 'r_50D60TYRBBBBC4YYA5JR7XPFQC', 'ver', 41, 0, 'rd_F699D9MVCSFGHT1N');
INSERT INTO public.last_read VALUES ('u_56KR08SH4FN38WQ94ZVTTS80BE', '', 'r_C4WC0TZ9MW9KV39M6FM7M2BGEW', 'ver', 21, 0, 'rd_F699D9MVCSFGHT1N');
INSERT INTO public.last_read VALUES ('u_56KR08SH4FN38WQ94ZVTTS80BE', '', 'e_A0WPAB33GA6A9KGT7CK6B0V7NP', 'ver', 55, 0, 'rd_6DXT5JHWQDYWHAZT');
INSERT INTO public.last_read VALUES ('u_56KR08SH4FN38WQ94ZVTTS80BE', '', 'sl_BYREFGP1VJ4RR4G4', 'sv', 2, 0, 'rd_6DXT5JHWQDYWHAZT');


--
-- Data for Name: meta; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.meta VALUES ('storage_format', '5');
INSERT INTO public.meta VALUES ('session_settings', '["SET client_encoding = ''UTF8''","SET TIME ZONE ''UTC''","SET datestyle = ''ISO, YMD''","SET intervalstyle = ''iso_8601''","SET extra_float_digits = 3","SET standard_conforming_strings = on"]');
INSERT INTO public.meta VALUES ('tenant_id', 'tn_DY578XFPQSAAXY4ZRY57TMF1DB');
INSERT INTO public.meta VALUES ('ownership_epoch', '2');


--
-- Data for Name: migrations; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: partitions; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.partitions VALUES ('t5', 'p_1A6GGZGCVMBPEGH2', '["2026-11-02"]');
INSERT INTO public.partitions VALUES ('t5', 'p_RCBX19D6XW61VY3W', '["2026-11-03"]');
INSERT INTO public.partitions VALUES ('t5', 'p_TKDQNSS61VC5BNW4', '["2026-11-04"]');


--
-- Data for Name: pending_blocks; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: pending_entries; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.pending_entries VALUES ('pi_JNX4SDNEBQJXPVKJ', 0, 48, 'candidates/0');
INSERT INTO public.pending_entries VALUES ('pi_JNX4SDNEBQJXPVKJ', 1, 48, 'current/0');
INSERT INTO public.pending_entries VALUES ('pi_JNX4SDNEBQJXPVKJ', 2, 48, 'impact/0');
INSERT INTO public.pending_entries VALUES ('pi_JNX4SDNEBQJXPVKJ', 3, 48, 'previous/0');
INSERT INTO public.pending_entries VALUES ('pi_WAWQM74JV1QDKF46', 0, 61, 'current/0');
INSERT INTO public.pending_entries VALUES ('pi_WAWQM74JV1QDKF46', 1, 61, 'current/1');
INSERT INTO public.pending_entries VALUES ('pi_WAWQM74JV1QDKF46', 2, 61, 'impact/0');
INSERT INTO public.pending_entries VALUES ('pi_WAWQM74JV1QDKF46', 3, 61, 'impact/1');
INSERT INTO public.pending_entries VALUES ('pi_WAWQM74JV1QDKF46', 4, 61, 'proposed/0');
INSERT INTO public.pending_entries VALUES ('pi_WAWQM74JV1QDKF46', 5, 61, 'scope_valid');
INSERT INTO public.pending_entries VALUES ('pi_CDQ05X3CBRNY8C9G', 0, 79, 'matched/0');


--
-- Data for Name: pending_items; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.pending_items VALUES ('pi_JNX4SDNEBQJXPVKJ', 'conflict', 'sl_BYREFGP1VJ4RR4G4', 't1', 'r_50D60TYRBBBBC4YYA5JR7XPFQC', 'open', NULL, 45);
INSERT INTO public.pending_items VALUES ('pi_WAWQM74JV1QDKF46', 'awaiting_confirmation', 'sl_BYREFGP1VJ4RR4G4', 't2', 'e_A0WPAB33GA6A9KGT7CK6B0V7NP', 'open', NULL, 58);
INSERT INTO public.pending_items VALUES ('pi_TJWA8ZFQNDZAQGNZ', 'schema_change', 'sl_BYREFGP1VJ4RR4G4', NULL, NULL, 'resolved', 'confirm', 70);
INSERT INTO public.pending_items VALUES ('pi_CDQ05X3CBRNY8C9G', 'flagged', 'sl_BYREFGP1VJ4RR4G4', 't1', 'r_047CXK0KKCHDC8T7TT1ZNG3F7R', 'open', NULL, 76);


--
-- Data for Name: possibly_affected; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: premise_decls; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.premise_decls VALUES (49, 0, 0, 't4', 'r_Q4GGB4SGJ8C2HAYPACA4F35J5P', 't1', 'r_C4WC0TZ9MW9KV39M6FM7M2BGEW', '["f2"]', 'whole', NULL, 21, 0, 'current', NULL, NULL, 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W');


--
-- Data for Name: premise_edges; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.premise_edges VALUES (51, 'f1', 0, 'r_C4WC0TZ9MW9KV39M6FM7M2BGEW', 49, 0, 0);
INSERT INTO public.premise_edges VALUES (51, 'f2', 0, 'r_C4WC0TZ9MW9KV39M6FM7M2BGEW', 49, 0, 0);


--
-- Data for Name: principals; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.principals VALUES ('u_56KR08SH4FN38WQ94ZVTTS80BE', 'user', NULL, NULL, NULL, NULL, NULL, 'active', 1);
INSERT INTO public.principals VALUES ('system', 'system', NULL, NULL, NULL, NULL, NULL, 'active', 1);
INSERT INTO public.principals VALUES ('ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', 'connection', 'sample agent', '["saveslot.read","saveslot.write","saveslot.schema"]', NULL, 'token', NULL, 'active', 7);
INSERT INTO public.principals VALUES ('ci_MQ1E9ZQKDSK2NPCKTM2CSHEVSB', 'connection', 'another agent', '["saveslot.read","saveslot.write","saveslot.schema"]', NULL, 'token', NULL, 'active', 8);


--
-- Data for Name: read_log; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_1ZR7M0HDNC772JW0', 1, 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', NULL, '2026-11-26T10:24:00.928Z', 67, 'query', false, false, 'sl_BYREFGP1VJ4RR4G4', 1, 't1', '{"fields":["f1","f2","f3"],"order":[],"page":false,"table":"t1","time":"none","where":[]}', NULL, NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_3SV39F5J9NN0TXP6', 2, 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', NULL, '2026-11-26T10:24:00.931Z', 67, 'query', false, false, 'sl_BYREFGP1VJ4RR4G4', 1, 't2', '{"fields":["f1","f2"],"order":[],"page":false,"table":"t2","time":"none","where":[]}', '{"at":"2026-11-26"}', NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_Z1HZRNHWF27AYVT7', 3, 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', NULL, '2026-11-26T10:24:00.934Z', 67, 'query', false, false, 'sl_BYREFGP1VJ4RR4G4', 1, 't3', '{"fields":["f1","f2","f3"],"order":[],"page":false,"table":"t3","time":"none","where":[]}', NULL, NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_90PJBQ7N0Z8BK4SM', 4, 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', NULL, '2026-11-26T10:24:00.936Z', 67, 'query', false, false, 'sl_BYREFGP1VJ4RR4G4', 1, 't4', '{"fields":["f1","f2"],"order":[],"page":false,"table":"t4","time":"none","where":[]}', NULL, NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_JCMR71EHRB8JMCMW', 5, 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', NULL, '2026-11-26T10:24:00.939Z', 67, 'query', false, false, 'sl_BYREFGP1VJ4RR4G4', 1, 't5', '{"fields":["f1","f2","f3"],"order":[],"page":false,"table":"t5","time":"none","where":[]}', NULL, NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_KAT08ARE6PYQGKVT', 6, 'ci_MQ1E9ZQKDSK2NPCKTM2CSHEVSB', NULL, '2026-11-26T10:24:00.941Z', 67, 'history', false, false, 'sl_BYREFGP1VJ4RR4G4', 1, 't1', '{"mode":"timeline","table":"t1","target":"r_C4WC0TZ9MW9KV39M6FM7M2BGEW"}', NULL, NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_X36QQF8GZ7DQTA5C', 7, 'ci_P0AW3DRZ1WEPA6ZFAC0955DK7W', NULL, '2026-11-26T10:24:00.965Z', 76, 'query', false, false, 'sl_BYREFGP1VJ4RR4G4', 2, 't1', '{"fields":["f1","f2","f3"],"order":[],"page":false,"table":"t1","time":"none","where":[]}', NULL, NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_F699D9MVCSFGHT1N', 8, 'u_56KR08SH4FN38WQ94ZVTTS80BE', NULL, '2026-11-26T10:24:00.968Z', 76, 'query', false, false, 'sl_BYREFGP1VJ4RR4G4', 2, 't1', '{"fields":["f1","f2","f3"],"order":[],"page":false,"table":"t1","time":"none","where":[]}', NULL, NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_H1BZKNQPXZTJAA7N', 9, 'u_56KR08SH4FN38WQ94ZVTTS80BE', NULL, '2026-11-26T10:24:00.969Z', 76, 'query', false, false, 'sl_BYREFGP1VJ4RR4G4', 2, 't2', '{"fields":["f1","f2"],"order":[],"page":false,"table":"t2","time":"at","where":[]}', '{"at":"2026-10-05"}', NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_6DXT5JHWQDYWHAZT', 10, 'u_56KR08SH4FN38WQ94ZVTTS80BE', NULL, '2026-11-26T10:24:00.972Z', 76, 'query', false, false, 'sl_BYREFGP1VJ4RR4G4', 2, 't2', '{"fields":["f1","f2"],"order":[],"page":false,"table":"t2","time":"at","where":[]}', '{"at":"2026-11-15"}', NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_8HE5K08SP01V4FVJ', 11, 'u_56KR08SH4FN38WQ94ZVTTS80BE', NULL, '2026-11-26T10:24:00.974Z', 76, 'pending', false, false, NULL, NULL, NULL, '{"list":true,"slot":null,"status":"open","type":null}', NULL, NULL, NULL, NULL);


--
-- Data for Name: read_log_rows; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.read_log_rows VALUES ('rd_1ZR7M0HDNC772JW0', 0, 't1', 'r_T85ET4XD7CJG6DYYPF7TXJ32S4', 37, 0);
INSERT INTO public.read_log_rows VALUES ('rd_1ZR7M0HDNC772JW0', 1, 't1', 'r_50D60TYRBBBBC4YYA5JR7XPFQC', 41, 0);
INSERT INTO public.read_log_rows VALUES ('rd_1ZR7M0HDNC772JW0', 2, 't1', 'r_C4WC0TZ9MW9KV39M6FM7M2BGEW', 21, 0);
INSERT INTO public.read_log_rows VALUES ('rd_3SV39F5J9NN0TXP6', 0, 't2', 'e_A0WPAB33GA6A9KGT7CK6B0V7NP', 55, 0);
INSERT INTO public.read_log_rows VALUES ('rd_Z1HZRNHWF27AYVT7', 0, 't3', 'r_CNBK4Y7984NPCYQ612C00Z4GV3', 67, 0);
INSERT INTO public.read_log_rows VALUES ('rd_Z1HZRNHWF27AYVT7', 1, 't3', 'r_CBA9K83Z66TNQJJ6Z0QM703JFP', 62, 0);
INSERT INTO public.read_log_rows VALUES ('rd_90PJBQ7N0Z8BK4SM', 0, 't4', 'r_Q4GGB4SGJ8C2HAYPACA4F35J5P', 49, 0);
INSERT INTO public.read_log_rows VALUES ('rd_JCMR71EHRB8JMCMW', 0, 't5', 'p_1A6GGZGCVMBPEGH2', 41, 0);
INSERT INTO public.read_log_rows VALUES ('rd_JCMR71EHRB8JMCMW', 1, 't5', 'p_TKDQNSS61VC5BNW4', 37, 0);
INSERT INTO public.read_log_rows VALUES ('rd_KAT08ARE6PYQGKVT', 0, 't1', 'r_C4WC0TZ9MW9KV39M6FM7M2BGEW', 21, 0);
INSERT INTO public.read_log_rows VALUES ('rd_X36QQF8GZ7DQTA5C', 0, 't1', 'r_T85ET4XD7CJG6DYYPF7TXJ32S4', 37, 0);
INSERT INTO public.read_log_rows VALUES ('rd_X36QQF8GZ7DQTA5C', 1, 't1', 'r_047CXK0KKCHDC8T7TT1ZNG3F7R', 76, 0);
INSERT INTO public.read_log_rows VALUES ('rd_X36QQF8GZ7DQTA5C', 2, 't1', 'r_50D60TYRBBBBC4YYA5JR7XPFQC', 41, 0);
INSERT INTO public.read_log_rows VALUES ('rd_X36QQF8GZ7DQTA5C', 3, 't1', 'r_C4WC0TZ9MW9KV39M6FM7M2BGEW', 21, 0);
INSERT INTO public.read_log_rows VALUES ('rd_F699D9MVCSFGHT1N', 0, 't1', 'r_T85ET4XD7CJG6DYYPF7TXJ32S4', 37, 0);
INSERT INTO public.read_log_rows VALUES ('rd_F699D9MVCSFGHT1N', 1, 't1', 'r_047CXK0KKCHDC8T7TT1ZNG3F7R', 76, 0);
INSERT INTO public.read_log_rows VALUES ('rd_F699D9MVCSFGHT1N', 2, 't1', 'r_50D60TYRBBBBC4YYA5JR7XPFQC', 41, 0);
INSERT INTO public.read_log_rows VALUES ('rd_F699D9MVCSFGHT1N', 3, 't1', 'r_C4WC0TZ9MW9KV39M6FM7M2BGEW', 21, 0);
INSERT INTO public.read_log_rows VALUES ('rd_H1BZKNQPXZTJAA7N', 0, 't2', 'e_A0WPAB33GA6A9KGT7CK6B0V7NP', 55, 0);
INSERT INTO public.read_log_rows VALUES ('rd_6DXT5JHWQDYWHAZT', 0, 't2', 'e_A0WPAB33GA6A9KGT7CK6B0V7NP', 55, 0);


--
-- Data for Name: request_keys; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.request_keys VALUES ('80d4b84b03821b8faa3a3605a5c826e8a8d2ac0603f295314f944d8d1f548cdd', 2, '2026-11-26T10:24:00.803Z', NULL);
INSERT INTO public.request_keys VALUES ('395dd48c9a5877ff423ab7c2ab0474645a31c4c1248afcf07d40ba7040b4354a', 9, '2026-11-26T10:24:00.820Z', NULL);
INSERT INTO public.request_keys VALUES ('a89a10deec681c134fcdc303ff30e822fc4e6d7d9ff33fdec5103cfb62626f92', 13, '2026-11-26T10:24:00.830Z', NULL);
INSERT INTO public.request_keys VALUES ('c6ce38606c6dd025d60da5d6fb71675d4b1b42b851990862c1e8da0673eb763e', 17, '2026-11-26T10:24:00.837Z', NULL);
INSERT INTO public.request_keys VALUES ('ed30af8ca1525cf9c855d2f260c45796932b237d262fbb7a6f8724755201f439', 21, '2026-11-26T10:24:00.844Z', NULL);
INSERT INTO public.request_keys VALUES ('5f54188eff6a1ba8a4c08afc74c3f0104e5034f322c4ff71bb6ffd83c19e878a', 25, '2026-11-26T10:24:00.851Z', NULL);
INSERT INTO public.request_keys VALUES ('9b7f97927b2d5525845e332c0143d0133d3f0f2c4d9267548399a0a202f305e0', 29, '2026-11-26T10:24:00.858Z', NULL);
INSERT INTO public.request_keys VALUES ('f977fc61cf77bebe1a8a046e1770ebfb7e26751e79d2c312e9e724dc1f70b23f', 33, '2026-11-26T10:24:00.865Z', NULL);
INSERT INTO public.request_keys VALUES ('cc90e9b0c78411e2e099b36b59428d82071c71dc675c701ce4a529396d97b0aa', 37, '2026-11-26T10:24:00.870Z', NULL);
INSERT INTO public.request_keys VALUES ('90702a1317ecc19db7969adacb42372c2fd03138bf23b4a6b299eb71f5447842', 41, '2026-11-26T10:24:00.876Z', NULL);
INSERT INTO public.request_keys VALUES ('831bbb57c1d2ef7eca3c3113a667fe1ca135fb86f3189db8c65ba1e6ee3a8d22', 45, '2026-11-26T10:24:00.882Z', NULL);
INSERT INTO public.request_keys VALUES ('a767311fc35a168777fcab70d3f5338c6e698ebfc1a70bd7ad33d9e35a29e9dd', 49, '2026-11-26T10:24:00.889Z', NULL);
INSERT INTO public.request_keys VALUES ('f6d061eff79d48b008f8a62ac2b6b4fcd2ba544518803322b6741cab24243b84', 52, '2026-11-26T10:24:00.895Z', NULL);
INSERT INTO public.request_keys VALUES ('0b943f2078c5eec96de7c92c3ed79ca9a1709860ecc2d335ba6c7a61ff9e6bcd', 55, '2026-11-26T10:24:00.901Z', NULL);
INSERT INTO public.request_keys VALUES ('bed756f6336038932bf6cffd25a32916b287cb5640d3a8d07cd97dd19c6e38e8', 58, '2026-11-26T10:24:00.907Z', NULL);
INSERT INTO public.request_keys VALUES ('971c059600d1b3717e7800172af7ecb504ea3bc12870cd904d45e0cb970f7b70', 70, '2026-11-26T10:24:00.945Z', NULL);
INSERT INTO public.request_keys VALUES ('c1c02e26cbd0af911cc2e43aa71a64f2f390fd0d1db1c44775b203d47470945a', 73, '2026-11-26T10:24:00.950Z', NULL);
INSERT INTO public.request_keys VALUES ('7f34af4852bdec0d3b8223e260544ef945a7ff8c5a84b43d92bafe56bb5a0a7b', 76, '2026-11-26T10:24:00.958Z', NULL);


--
-- Data for Name: residue_progress; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: row_origins; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.row_origins VALUES ('r_C4WC0TZ9MW9KV39M6FM7M2BGEW', 't1', 11);
INSERT INTO public.row_origins VALUES ('r_50D60TYRBBBBC4YYA5JR7XPFQC', 't1', 15);
INSERT INTO public.row_origins VALUES ('r_XKM34Y62T0YDHRY8NEE15FJ0QK', 't1', 19);
INSERT INTO public.row_origins VALUES ('r_T85ET4XD7CJG6DYYPF7TXJ32S4', 't1', 31);
INSERT INTO public.row_origins VALUES ('r_Q4GGB4SGJ8C2HAYPACA4F35J5P', 't4', 51);
INSERT INTO public.row_origins VALUES ('e_A0WPAB33GA6A9KGT7CK6B0V7NP', 't2', 54);
INSERT INTO public.row_origins VALUES ('r_CNBK4Y7984NPCYQ612C00Z4GV3', 't3', 65);
INSERT INTO public.row_origins VALUES ('r_CBA9K83Z66TNQJJ6Z0QM703JFP', 't3', 66);
INSERT INTO public.row_origins VALUES ('r_047CXK0KKCHDC8T7TT1ZNG3F7R', 't1', 78);


--
-- Data for Name: schema_versions; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.schema_versions VALUES ('sl_BYREFGP1VJ4RR4G4', 1, 3, 'd_53A1MTZ4XX93YYEM', 6, 'retired');
INSERT INTO public.schema_versions VALUES ('sl_BYREFGP1VJ4RR4G4', 2, 71, 'd_F167Z43KSDA199TQ', 75, 'current');


--
-- Data for Name: slots; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.slots VALUES ('sl_BYREFGP1VJ4RR4G4', 'household', 'Asia/Shanghai', 2, 5, 1);


--
-- Data for Name: sources; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.sources VALUES (10, 's_0GTPPFQZV4Y8YBA0', 'user_message', 'user_stated', 'sl_BYREFGP1VJ4RR4G4', 'present');
INSERT INTO public.sources VALUES (14, 's_1KKJ8ZF4WKZARZ6M', 'api_call', 'agent_inferred', 'sl_BYREFGP1VJ4RR4G4', 'present');
INSERT INTO public.sources VALUES (18, 's_W51J7R3BJP0BZ0DQ', 'api_call', 'agent_inferred', 'sl_BYREFGP1VJ4RR4G4', 'present');
INSERT INTO public.sources VALUES (22, 's_GH58NAEE6B0YZ0CT', 'user_message', 'user_stated', 'sl_BYREFGP1VJ4RR4G4', 'present');
INSERT INTO public.sources VALUES (26, 's_FK43AV340CXV8SY4', 'api_call', 'agent_inferred', 'sl_BYREFGP1VJ4RR4G4', 'present');
INSERT INTO public.sources VALUES (30, 's_GZD5R8J5RB4N04P6', 'api_call', 'agent_inferred', 'sl_BYREFGP1VJ4RR4G4', 'present');
INSERT INTO public.sources VALUES (34, 's_DK7P053MNKA0AXTC', 'api_call', 'agent_inferred', 'sl_BYREFGP1VJ4RR4G4', 'present');
INSERT INTO public.sources VALUES (38, 's_EH4A6XDYG5NVW8FH', 'api_call', 'agent_inferred', 'sl_BYREFGP1VJ4RR4G4', 'present');
INSERT INTO public.sources VALUES (42, 's_H19JTSQ0T8CRDX98', 'api_call', 'agent_inferred', 'sl_BYREFGP1VJ4RR4G4', 'present');
INSERT INTO public.sources VALUES (46, 's_5FQBNVZQ3KZETG48', 'api_call', 'agent_inferred', 'sl_BYREFGP1VJ4RR4G4', 'present');
INSERT INTO public.sources VALUES (50, 's_GXXA1A2W0BJJYN9D', 'api_call', 'agent_inferred', 'sl_BYREFGP1VJ4RR4G4', 'present');
INSERT INTO public.sources VALUES (53, 's_J2JJMEC1XCRGAT3W', 'api_call', 'agent_inferred', 'sl_BYREFGP1VJ4RR4G4', 'present');
INSERT INTO public.sources VALUES (56, 's_GXYCZ2TYKKDVXNRZ', 'api_call', 'agent_inferred', 'sl_BYREFGP1VJ4RR4G4', 'present');
INSERT INTO public.sources VALUES (59, 's_TNZRX1H93EYQAVFB', 'api_call', 'agent_inferred', 'sl_BYREFGP1VJ4RR4G4', 'present');
INSERT INTO public.sources VALUES (63, 's_A6671J1ESY8H4WG9', 'api_call', 'agent_inferred', 'sl_BYREFGP1VJ4RR4G4', 'present');
INSERT INTO public.sources VALUES (64, 's_P32E55CZFSCX6FJT', 'api_call', 'agent_inferred', 'sl_BYREFGP1VJ4RR4G4', 'present');
INSERT INTO public.sources VALUES (68, 's_N2B2NZQQTE6J6N21', 'api_call', 'agent_inferred', 'sl_BYREFGP1VJ4RR4G4', 'present');
INSERT INTO public.sources VALUES (77, 's_F7TZKBYQ5KHW25RE', 'api_call', 'agent_inferred', 'sl_BYREFGP1VJ4RR4G4', 'present');


--
-- Data for Name: t_t1_v1; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.t_t1_v1 VALUES ('r_C4WC0TZ9MW9KV39M6FM7M2BGEW', false, '2026-11-02', 54, 'lunch');
INSERT INTO public.t_t1_v1 VALUES ('r_XKM34Y62T0YDHRY8NEE15FJ0QK', true, '2026-11-03', 18, 'coffee');
INSERT INTO public.t_t1_v1 VALUES ('r_T85ET4XD7CJG6DYYPF7TXJ32S4', false, '2026-11-04', 9, 'snack');
INSERT INTO public.t_t1_v1 VALUES ('r_50D60TYRBBBBC4YYA5JR7XPFQC', false, '2026-11-02', 32, 'taxi');
INSERT INTO public.t_t1_v1 VALUES ('r_047CXK0KKCHDC8T7TT1ZNG3F7R', false, '2026-11-02', 54, 'lunch');


--
-- Data for Name: t_t1_v1__ver; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.t_t1_v1__ver VALUES ('r_C4WC0TZ9MW9KV39M6FM7M2BGEW', 'f1', 9, NULL, 'insert', 11, 'f1', 0, NULL, NULL, '2026-11-02', NULL, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_C4WC0TZ9MW9KV39M6FM7M2BGEW', 'f3', 9, NULL, 'insert', 11, 'f3', 0, NULL, NULL, NULL, NULL, 'lunch');
INSERT INTO public.t_t1_v1__ver VALUES ('r_50D60TYRBBBBC4YYA5JR7XPFQC', 'f1', 13, NULL, 'insert', 15, 'f1', 0, NULL, NULL, '2026-11-02', NULL, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_50D60TYRBBBBC4YYA5JR7XPFQC', 'f3', 13, NULL, 'insert', 15, 'f3', 0, NULL, NULL, NULL, NULL, 'taxi');
INSERT INTO public.t_t1_v1__ver VALUES ('r_XKM34Y62T0YDHRY8NEE15FJ0QK', 'f1', 17, NULL, 'insert', 19, 'f1', 0, NULL, NULL, '2026-11-03', NULL, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_XKM34Y62T0YDHRY8NEE15FJ0QK', 'f2', 17, NULL, 'insert', 19, 'f2', 0, NULL, NULL, NULL, 18, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_XKM34Y62T0YDHRY8NEE15FJ0QK', 'f3', 17, NULL, 'insert', 19, 'f3', 0, NULL, NULL, NULL, NULL, 'coffee');
INSERT INTO public.t_t1_v1__ver VALUES ('r_C4WC0TZ9MW9KV39M6FM7M2BGEW', 'f2', 9, 21, 'insert', 11, 'f2', 0, NULL, NULL, NULL, 45, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_C4WC0TZ9MW9KV39M6FM7M2BGEW', 'f2', 21, NULL, 'correct', 23, 'f2', 0, NULL, NULL, NULL, 54, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_XKM34Y62T0YDHRY8NEE15FJ0QK', 'existence', 25, NULL, 'revoke', 27, 'existence', 0, true, NULL, NULL, NULL, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_T85ET4XD7CJG6DYYPF7TXJ32S4', 'f1', 29, NULL, 'insert', 31, 'f1', 0, NULL, NULL, '2026-11-04', NULL, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_T85ET4XD7CJG6DYYPF7TXJ32S4', 'f2', 29, NULL, 'insert', 31, 'f2', 0, NULL, NULL, NULL, 9, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_T85ET4XD7CJG6DYYPF7TXJ32S4', 'f3', 29, NULL, 'insert', 31, 'f3', 0, NULL, NULL, NULL, NULL, 'snack');
INSERT INTO public.t_t1_v1__ver VALUES ('r_T85ET4XD7CJG6DYYPF7TXJ32S4', 'existence', 33, 37, 'revoke', 35, 'existence', 0, true, NULL, NULL, NULL, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_T85ET4XD7CJG6DYYPF7TXJ32S4', 'existence', 37, NULL, 'revoke', 39, 'existence', 0, NULL, NULL, NULL, NULL, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_50D60TYRBBBBC4YYA5JR7XPFQC', 'f2', 13, 41, 'insert', 15, 'f2', 0, NULL, NULL, NULL, 30, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_50D60TYRBBBBC4YYA5JR7XPFQC', 'f2', 41, NULL, 'update', 43, 'f2', 0, NULL, NULL, NULL, 32, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_047CXK0KKCHDC8T7TT1ZNG3F7R', 'f1', 76, NULL, 'insert', 78, 'f1', 0, NULL, NULL, '2026-11-02', NULL, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_047CXK0KKCHDC8T7TT1ZNG3F7R', 'f2', 76, NULL, 'insert', 78, 'f2', 0, NULL, NULL, NULL, 54, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_047CXK0KKCHDC8T7TT1ZNG3F7R', 'f3', 76, NULL, 'insert', 78, 'f3', 0, NULL, NULL, NULL, NULL, 'lunch');


--
-- Data for Name: t_t2_v1; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.t_t2_v1 VALUES ('e_A0WPAB33GA6A9KGT7CK6B0V7NP', '2026-10-01', '2026-11-10', 'food', 5000);
INSERT INTO public.t_t2_v1 VALUES ('e_A0WPAB33GA6A9KGT7CK6B0V7NP', '2026-11-10', NULL, 'food', 4000);


--
-- Data for Name: t_t2_v1__ver; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.t_t2_v1__ver VALUES ('e_A0WPAB33GA6A9KGT7CK6B0V7NP', 'f1', '2026-10-01', NULL, 52, NULL, 'update', 54, 'f1', 0, NULL, NULL, 'food', NULL);
INSERT INTO public.t_t2_v1__ver VALUES ('e_A0WPAB33GA6A9KGT7CK6B0V7NP', 'f2', '2026-10-01', NULL, 52, 55, 'update', 54, 'f2', 0, NULL, NULL, NULL, 5000);
INSERT INTO public.t_t2_v1__ver VALUES ('e_A0WPAB33GA6A9KGT7CK6B0V7NP', 'f2', '2026-10-01', '2026-11-10', 55, NULL, 'update', 54, 'f2', 0, NULL, NULL, NULL, 5000);
INSERT INTO public.t_t2_v1__ver VALUES ('e_A0WPAB33GA6A9KGT7CK6B0V7NP', 'f2', '2026-11-10', NULL, 55, NULL, 'update', 57, 'f2', 0, NULL, NULL, NULL, 4000);


--
-- Data for Name: t_t3_v1; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.t_t3_v1 VALUES ('r_CBA9K83Z66TNQJJ6Z0QM703JFP', false, 'app', 'k-2', 21);
INSERT INTO public.t_t3_v1 VALUES ('r_CNBK4Y7984NPCYQ612C00Z4GV3', false, 'app', 'k-1', 12);


--
-- Data for Name: t_t3_v1__ver; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.t_t3_v1__ver VALUES ('r_CNBK4Y7984NPCYQ612C00Z4GV3', 'f1', 62, NULL, 'update', 65, 'f1', 0, NULL, NULL, 'app', NULL, NULL);
INSERT INTO public.t_t3_v1__ver VALUES ('r_CNBK4Y7984NPCYQ612C00Z4GV3', 'f2', 62, NULL, 'update', 65, 'f2', 0, NULL, NULL, NULL, 'k-1', NULL);
INSERT INTO public.t_t3_v1__ver VALUES ('r_CBA9K83Z66TNQJJ6Z0QM703JFP', 'f1', 62, NULL, 'update', 66, 'f1', 0, NULL, NULL, 'app', NULL, NULL);
INSERT INTO public.t_t3_v1__ver VALUES ('r_CBA9K83Z66TNQJJ6Z0QM703JFP', 'f2', 62, NULL, 'update', 66, 'f2', 0, NULL, NULL, NULL, 'k-2', NULL);
INSERT INTO public.t_t3_v1__ver VALUES ('r_CBA9K83Z66TNQJJ6Z0QM703JFP', 'f3', 62, NULL, 'update', 66, 'f3', 0, NULL, NULL, NULL, NULL, 21);
INSERT INTO public.t_t3_v1__ver VALUES ('r_CNBK4Y7984NPCYQ612C00Z4GV3', 'f3', 62, 67, 'update', 65, 'f3', 0, NULL, NULL, NULL, NULL, 10);
INSERT INTO public.t_t3_v1__ver VALUES ('r_CNBK4Y7984NPCYQ612C00Z4GV3', 'f3', 67, NULL, 'update', 69, 'f3', 0, NULL, NULL, NULL, NULL, 12);


--
-- Data for Name: t_t4_v1; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.t_t4_v1 VALUES ('r_Q4GGB4SGJ8C2HAYPACA4F35J5P', false, 'half of lunch', 'r_C4WC0TZ9MW9KV39M6FM7M2BGEW');


--
-- Data for Name: t_t4_v1__ver; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.t_t4_v1__ver VALUES ('r_Q4GGB4SGJ8C2HAYPACA4F35J5P', 'f1', 49, NULL, 'insert', 51, 'f1', 0, NULL, NULL, 'half of lunch', NULL);
INSERT INTO public.t_t4_v1__ver VALUES ('r_Q4GGB4SGJ8C2HAYPACA4F35J5P', 'f2', 49, NULL, 'insert', 51, 'f2', 0, NULL, NULL, NULL, 'r_C4WC0TZ9MW9KV39M6FM7M2BGEW');


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

\unrestrict tnYPUEQJM3QRdQVGNReYmlzsWc81UZlobFmx21EjYDg5KoaW6iQE6tPbcnmRd9q

