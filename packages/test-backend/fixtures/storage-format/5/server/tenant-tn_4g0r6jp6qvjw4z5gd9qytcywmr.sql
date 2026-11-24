--
-- PostgreSQL database dump
--

\restrict VWu4qdclqFUZevUAwaoO1q3tfR3kbGMzznV7ZmpJ4XZ3yhAlHxWa5sMBXNiO6qM

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

INSERT INTO public.base_sources VALUES (11, 'r_XDTMQRPMBQXRDFX4YKSEW79FBN', 'f1', 0, 0, 'value', 10, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (11, 'r_XDTMQRPMBQXRDFX4YKSEW79FBN', 'f2', 0, 0, 'value', 10, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (11, 'r_XDTMQRPMBQXRDFX4YKSEW79FBN', 'f3', 0, 0, 'value', 10, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (15, 'r_3WNNNT1AYPQD12JA5XES73SDTZ', 'f1', 0, 0, 'value', 14, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (15, 'r_3WNNNT1AYPQD12JA5XES73SDTZ', 'f2', 0, 0, 'value', 14, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (15, 'r_3WNNNT1AYPQD12JA5XES73SDTZ', 'f3', 0, 0, 'value', 14, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (19, 'r_7VVDMS5EX7H3XTBGA7N45G8HKN', 'f1', 0, 0, 'value', 18, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (19, 'r_7VVDMS5EX7H3XTBGA7N45G8HKN', 'f2', 0, 0, 'value', 18, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (19, 'r_7VVDMS5EX7H3XTBGA7N45G8HKN', 'f3', 0, 0, 'value', 18, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (23, 'r_XDTMQRPMBQXRDFX4YKSEW79FBN', 'f2', 0, 0, 'value', 22, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (27, 'r_7VVDMS5EX7H3XTBGA7N45G8HKN', 'existence', 0, 0, 'operation', 26, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (31, 'r_VGKXJ8AASB0XE4BMMRW2BVT63C', 'f1', 0, 0, 'value', 30, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (31, 'r_VGKXJ8AASB0XE4BMMRW2BVT63C', 'f2', 0, 0, 'value', 30, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (31, 'r_VGKXJ8AASB0XE4BMMRW2BVT63C', 'f3', 0, 0, 'value', 30, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (35, 'r_VGKXJ8AASB0XE4BMMRW2BVT63C', 'existence', 0, 0, 'operation', 34, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[{"op":37,"valid":[{"from":null,"to":null}]}]', NULL, NULL);
INSERT INTO public.base_sources VALUES (39, 'r_VGKXJ8AASB0XE4BMMRW2BVT63C', 'existence', 0, 0, 'operation', 38, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (43, 'r_3WNNNT1AYPQD12JA5XES73SDTZ', 'f2', 0, 0, 'value', 42, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (51, 'r_30WY0P19Q5ZAZXJQS8QEA7Q2FV', 'f1', 0, 0, 'value', 50, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (51, 'r_30WY0P19Q5ZAZXJQS8QEA7Q2FV', 'f2', 0, 0, 'value', 50, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (54, 'e_K9FD9A5G72KJ0YN4110M2X6TZS', 'f1', 0, 0, 'value', 53, NULL, NULL, NULL, NULL, 'applied', '2026-10-01', NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (54, 'e_K9FD9A5G72KJ0YN4110M2X6TZS', 'f1', 0, 1, 'interval', 53, NULL, NULL, NULL, NULL, 'applied', '2026-10-01', NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (54, 'e_K9FD9A5G72KJ0YN4110M2X6TZS', 'f2', 0, 0, 'value', 53, NULL, NULL, NULL, NULL, 'applied', '2026-10-01', NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (54, 'e_K9FD9A5G72KJ0YN4110M2X6TZS', 'f2', 0, 1, 'interval', 53, NULL, NULL, NULL, NULL, 'applied', '2026-10-01', NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (57, 'e_K9FD9A5G72KJ0YN4110M2X6TZS', 'f2', 0, 0, 'value', 56, NULL, NULL, NULL, NULL, 'applied', '2026-11-10', NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (57, 'e_K9FD9A5G72KJ0YN4110M2X6TZS', 'f2', 0, 1, 'interval', 56, NULL, NULL, NULL, NULL, 'applied', '2026-11-10', NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (65, 'r_2XDJE12PK0TSR0ZAVBMKW1B8WB', 'f1', 0, 0, 'value', 63, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (65, 'r_2XDJE12PK0TSR0ZAVBMKW1B8WB', 'f2', 0, 0, 'value', 63, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (65, 'r_2XDJE12PK0TSR0ZAVBMKW1B8WB', 'f3', 0, 0, 'value', 63, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (66, 'r_7T9F8XC601XXQBZ8R6JK0QATGN', 'f1', 0, 0, 'value', 64, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (66, 'r_7T9F8XC601XXQBZ8R6JK0QATGN', 'f2', 0, 0, 'value', 64, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (66, 'r_7T9F8XC601XXQBZ8R6JK0QATGN', 'f3', 0, 0, 'value', 64, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);
INSERT INTO public.base_sources VALUES (69, 'r_2XDJE12PK0TSR0ZAVBMKW1B8WB', 'f3', 0, 0, 'value', 68, NULL, NULL, NULL, NULL, 'applied', NULL, NULL, false, NULL, '[]', NULL, NULL);


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

INSERT INTO public.catalog VALUES ('t5', 1, 'sl_ZSNW59W1GYV3Z145', '{"description":"what was spent each day","fields":[{"description":"the day","id":"f1","name":"day","type":"date"},{"description":"the sum","id":"f2","name":"total","type":"integer"},{"description":"how many","id":"f3","name":"n","type":"integer"}],"id":"t5","kind":"derived","name":"spent_by_day","rule":{"depends_on":[{"field":"f1","table":"t1"},{"field":"f2","table":"t1"}],"id":"r1","rsql":"rsql@1","scope":{"key":["f1"],"key_from_free_text":false,"kind":"group"},"sql":"SELECT \"t1\".\"f1\" AS \"f1\", CAST(sum(\"t1\".\"f2\") AS bigint) AS \"f2\", count(*) AS \"f3\" FROM \"t1\" GROUP BY 1","time_dependency":"bucketed","version":1}}', NULL, NULL);
INSERT INTO public.catalog VALUES ('t1', 1, 'sl_ZSNW59W1GYV3Z145', '{"description":"one row per expense","fields":[{"description":"the day","id":"f1","name":"date","required":true,"type":"date"},{"description":"how much, in yuan","id":"f2","name":"amount","type":"integer"},{"description":"what for","id":"f3","name":"note","type":"text"}],"id":"t1","kind":"base","name":"expenses","time":{"field":"f1","type":"event"}}', NULL, NULL);
INSERT INTO public.catalog VALUES ('t2', 1, 'sl_ZSNW59W1GYV3Z145', '{"description":"a monthly budget by kind","entity_key":["f1"],"fields":[{"description":"what the budget is for","id":"f1","name":"kind","required":true,"type":"text"},{"description":"the budget, in yuan","id":"f2","name":"amount","required":true,"type":"integer"}],"id":"t2","kind":"base","name":"budgets","time":{"granularity":"date","type":"state"}}', NULL, NULL);
INSERT INTO public.catalog VALUES ('t3', 1, 'sl_ZSNW59W1GYV3Z145', '{"description":"rides from an app","external_key":["f1","f2"],"fields":[{"description":"the app","id":"f1","name":"origin","type":"text"},{"description":"its ID there","id":"f2","name":"external_id","type":"text"},{"description":"how much","id":"f3","name":"fare","type":"integer"}],"id":"t3","kind":"base","name":"rides","time":{"type":"none"}}', NULL, NULL);
INSERT INTO public.catalog VALUES ('t4', 1, 'sl_ZSNW59W1GYV3Z145', '{"description":"one row per refund of an expense","fields":[{"description":"why","id":"f1","name":"note","required":true,"type":"text"},{"description":"the expense refunded","id":"f2","name":"expense","ref":{"table":"t1","target":"row"},"type":"ref"}],"id":"t4","kind":"base","name":"refunds","time":{"type":"none"}}', NULL, NULL);


--
-- Data for Name: content; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.content VALUES (1, 'system', '{"kind":"system","principal":"system"}', 'a2a35fe2925b9b16c34e619069b782461a1ed680a95a60d70eeb5ce5f88ce770', NULL, NULL, NULL);
INSERT INTO public.content VALUES (1, 'tenant', '{"event_format":1,"storage_format":5,"tenant_id":"tn_4G0R6JP6QVJW4Z5GD9QYTCYWMR"}', '9888af66887098a2c37115b2f394204b564e6e8b684e6fe72c9436135b7c1c5e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (1, 'user', '{"kind":"user","principal":"u_DZEESWD7AKV5KWM10SWNFK03W4"}', 'fd2009d930ba9c32c9401e582c1e5050387dc16812ab452321d2daceb9a721f0', NULL, NULL, NULL);
INSERT INTO public.content VALUES (2, 'ctx', '{"now":"2026-11-24T13:37:53.346Z","policy_version":1,"ruleset_version":1,"today":"2026-11-24"}', '71829ae8dff7385fed745f175a98efdcfe8dcfabd6134e164b173fba829877ff', NULL, NULL, NULL);
INSERT INTO public.content VALUES (2, 'draft', '{"base_version":null,"slot":"household","tables":[{"description":"one row per expense","fields":[{"description":"the day","name":"date","required":true,"type":"date"},{"description":"how much, in yuan","name":"amount","type":"integer"},{"description":"what for","name":"note","type":"text"}],"kind":"base","name":"expenses","time":{"field":"date","type":"event"}},{"description":"a monthly budget by kind","entity_key":["kind"],"fields":[{"description":"what the budget is for","name":"kind","required":true,"type":"text"},{"description":"the budget, in yuan","name":"amount","required":true,"type":"integer"}],"kind":"base","name":"budgets","time":{"granularity":"date","type":"state"}},{"description":"rides from an app","external_key":["origin","external_id"],"fields":[{"description":"the app","name":"origin","type":"text"},{"description":"its ID there","name":"external_id","type":"text"},{"description":"how much","name":"fare","type":"integer"}],"kind":"base","name":"rides","time":{"type":"none"}},{"description":"one row per refund of an expense","fields":[{"description":"why","name":"note","required":true,"type":"text"},{"description":"the expense refunded","name":"expense","ref":{"table":"expenses","target":"row"},"type":"ref"}],"kind":"base","name":"refunds","time":{"type":"none"}},{"description":"what was spent each day","fields":[{"description":"the day","name":"day"},{"description":"the sum","name":"total"},{"description":"how many","name":"n"}],"kind":"derived","name":"spent_by_day","rule":{"sql":"SELECT date AS day, sum(amount) AS total, count(*) AS n FROM expenses GROUP BY 1","time_dependency":"bucketed"}}],"timezone":"Asia/Shanghai"}', '6445068c0f251c0434a5deb3094dc975f2eabd6b2db0798f06876a7f4497f1b6', NULL, NULL, NULL);
INSERT INTO public.content VALUES (2, 'request_key', '{"key":"d4f8012e1a2baed073b8fa93608bb803865079cd713e0aaff2b44423c4e5abf4"}', 'ee5288b4762ccd865314b5af9381b7db5ea849c2b24ed9ad8b40ed72c74e6b8b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (2, 'target', '{"creates_slot":true,"draft_id":"d_4ZM3CMFAPP78YBCA"}', '89324271e576b4a0826bb7a7adfc73d75e6610d21ec58ba1b8568e44b79fe957', NULL, NULL, NULL);
INSERT INTO public.content VALUES (3, 'changes', '[{"auto":true,"change":"create_slot","class":"create","compatible_with_old_writes":true,"destructive":false,"target":{"slot":true}},{"auto":true,"change":"add_table","class":"create","compatible_with_old_writes":true,"destructive":false,"target":{"table":"t1"}},{"auto":true,"change":"add_table","class":"create","compatible_with_old_writes":true,"destructive":false,"target":{"table":"t2"}},{"auto":true,"change":"add_table","class":"create","compatible_with_old_writes":true,"destructive":false,"target":{"table":"t3"}},{"auto":true,"change":"add_table","class":"create","compatible_with_old_writes":true,"destructive":false,"target":{"table":"t4"}},{"auto":true,"change":"add_derived_table","class":"create","compatible_with_old_writes":true,"destructive":false,"target":{"table":"t5"}}]', '7693e6615a0b0b02e421cfc07d012ee09421e5b1c3597b0698dcf4214e131875', NULL, NULL, NULL);
INSERT INTO public.content VALUES (3, 'compiled', '{"compiler":1,"name":"household","rsql":"rsql@1","slot":"sl_ZSNW59W1GYV3Z145","sv":1,"tables":[{"description":"one row per expense","fields":[{"description":"the day","id":"f1","name":"date","required":true,"type":"date"},{"description":"how much, in yuan","id":"f2","name":"amount","type":"integer"},{"description":"what for","id":"f3","name":"note","type":"text"}],"id":"t1","kind":"base","name":"expenses","physical":{"table":"t_t1_v1"},"time":{"field":"f1","type":"event"}},{"description":"a monthly budget by kind","entity_key":["f1"],"fields":[{"description":"what the budget is for","id":"f1","name":"kind","required":true,"type":"text"},{"description":"the budget, in yuan","id":"f2","name":"amount","required":true,"type":"integer"}],"id":"t2","kind":"base","name":"budgets","physical":{"table":"t_t2_v1"},"time":{"granularity":"date","type":"state"}},{"description":"rides from an app","external_key":["f1","f2"],"fields":[{"description":"the app","id":"f1","name":"origin","type":"text"},{"description":"its ID there","id":"f2","name":"external_id","type":"text"},{"description":"how much","id":"f3","name":"fare","type":"integer"}],"id":"t3","kind":"base","name":"rides","physical":{"table":"t_t3_v1"},"time":{"type":"none"}},{"description":"one row per refund of an expense","fields":[{"description":"why","id":"f1","name":"note","required":true,"type":"text"},{"description":"the expense refunded","id":"f2","name":"expense","ref":{"table":"t1","target":"row"},"type":"ref"}],"id":"t4","kind":"base","name":"refunds","physical":{"table":"t_t4_v1"},"time":{"type":"none"}},{"description":"what was spent each day","fields":[{"description":"the day","id":"f1","name":"day","type":"date"},{"description":"the sum","id":"f2","name":"total","type":"integer"},{"description":"how many","id":"f3","name":"n","type":"integer"}],"id":"t5","kind":"derived","name":"spent_by_day","physical":{"table":"d_t5_v1"},"rule":{"depends_on":[{"field":"f1","table":"t1"},{"field":"f2","table":"t1"}],"id":"r1","rsql":"rsql@1","scope":{"key":["f1"],"key_from_free_text":false,"kind":"group"},"sql":"SELECT \"t1\".\"f1\" AS \"f1\", CAST(sum(\"t1\".\"f2\") AS bigint) AS \"f2\", count(*) AS \"f3\" FROM \"t1\" GROUP BY 1","time_dependency":"bucketed","version":1}}],"timezone":"Asia/Shanghai"}', '327e6ad07f681d086ee6fbab303672aed7c373488ac5a4a816641c745d544afb', NULL, NULL, NULL);
INSERT INTO public.content VALUES (3, 'target', '{"draft_id":"d_4ZM3CMFAPP78YBCA","outcome":"applied","target_version":1}', 'de656880b7e72404e99ce34cee3f04b0cd0a6711a65276d95f7469acc8a0142e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (4, 'target', '{"by":"auto","draft_id":"d_4ZM3CMFAPP78YBCA","target_version":1}', '7506fe20202b39291b9014402231e1f281d3b15f0f409941b1cf9abbcc34e822', NULL, NULL, NULL);
INSERT INTO public.content VALUES (5, 'policy', '{"auto_apply":["add_table","add_derived_table","add_optional_field","description","rename_unused","loosen_constraint","duplicate_keys","restructure_unused"],"effective_value_rule":"keep_current","high_impact":[],"policy_version":1,"rank":{"agent_inferred":1,"miss":0,"user_stated":2},"user_session_only":[]}', '41f24c1878d2f9158397f7d9f675bdff962fb35398d8e890b3c0189f76a21363', NULL, NULL, NULL);
INSERT INTO public.content VALUES (6, 'target', '{"draft_id":"d_4ZM3CMFAPP78YBCA","rebuilt_tables":[],"to_version":1}', '05765be9ae2eceedb6eba025d5fd06fee19b77b3a9d6171cd1bf3f37164e6553', NULL, NULL, NULL);
INSERT INTO public.content VALUES (7, 'ctx', '{"now":"2026-11-24T13:37:53.394Z","ruleset_version":1}', '179c88f7e1a9f65c4fdeb21a777655be6db5ea45a850301f2113dea8c7b9d34a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (7, 'name', '{"name":"sample agent"}', '0957e5e5000dc767fb05ce8147d97d2657ac9a78f515adbc977be857b71de0d1', NULL, NULL, NULL);
INSERT INTO public.content VALUES (7, 'principal', '{"kind":"connection","principal":"ci_N02SN6P86V8WERP82PW08Y7K2B","scopes":["saveslot.read","saveslot.write","saveslot.schema"],"via":"token"}', '9d783dd90c03d97240dc2f81a092e3a636a26e1b21cb840438a0cc1d212b1bd0', NULL, NULL, NULL);
INSERT INTO public.content VALUES (8, 'ctx', '{"now":"2026-11-24T13:37:53.397Z","ruleset_version":1}', '2f42c1aaaab71f20caac8e0cc1ff76d32040f6b817687352b5f0a35d2a2e3b5b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (8, 'name', '{"name":"another agent"}', '95f97e5914d91f1ab0571d876aed20feb5977513c223d29b3d6c4ecf9f84847e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (8, 'principal', '{"kind":"connection","principal":"ci_F63CYN49FCWQBYAZ4TNM60RM86","scopes":["saveslot.read","saveslot.write","saveslot.schema"],"via":"token"}', 'ccbb2d15cb2b1d1f12cb850bf0b15f4b8f9149b0155b56771ae02e41747625e3', NULL, NULL, NULL);
INSERT INTO public.content VALUES (9, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-24T13:37:53.400Z","policy_version":1,"ruleset_version":1,"today":"2026-11-24"}', '2c8aa2d7a2700655cd4264a170e63994dc10a5084d8357f96854b20ebc1cc171', NULL, NULL, NULL);
INSERT INTO public.content VALUES (9, 'ops/0/set/f1', '"2026-11-02"', 'bb1de3879fc3904da5b8b20834d8d58eac44c618f8305a7357557ae506daf77f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (9, 'ops/0/set/f2', '"45"', '2eecac45827ede372449b7bd78a82139db639d810ebce98caef91e5d1a2fe422', NULL, NULL, NULL);
INSERT INTO public.content VALUES (9, 'ops/0/set/f3', '"lunch"', '861315d6dc2fae3332121172cefb27dbbc4f45d0422d6c7a700e861baadf4f8d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (9, 'ops/0/target', '{"created":true,"intent":"insert","row":"r_XDTMQRPMBQXRDFX4YKSEW79FBN","table":"t1"}', '26780ba62107dc48b991b71224fcfab0a20cf8423e844733726caad62496b545', NULL, NULL, NULL);
INSERT INTO public.content VALUES (9, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (9, 'request_key', '{"key":"533c72928b69421e7167740f0aa37681ede29759254366279d2d7b9b31dd2fa1"}', '33a08009609097a89f54af69c76055ab92728b58c49087732d2e8ccc306b7326', NULL, NULL, NULL);
INSERT INTO public.content VALUES (10, 'target', '{"kind":"user_message","level":"user_stated","source_id":"s_M4TAQ0HM03N4YS29"}', '1ae47988fa86925e99018e2c9d5865e1deef7c09fa1a66622ae40668ea4b239a', NULL, NULL, NULL);
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
INSERT INTO public.content VALUES (11, 'target', '{"cause":"request","created":true,"intent":"insert","op_index":0,"row":"r_XDTMQRPMBQXRDFX4YKSEW79FBN","sv":1,"table":"t1"}', '93144c5e9d62cccca703b290e86fc156c536f481521985c376c0a6e70f6570a5', NULL, NULL, NULL);
INSERT INTO public.content VALUES (12, 'checksum', '{"checksum":"47747ef5d44f61b2b8d2bca0722b3bccbd836a4860e44353c624370fb2e57386"}', '527f6e06439803548234e5f825f437597b39c7ff2a494893e5c624bef97bfb98', NULL, NULL, NULL);
INSERT INTO public.content VALUES (12, 'key', '{"values":["2026-11-02"]}', 'cc51a7db3e7d0a58c48bf5231237b844def245dd03281bd3f72ded939cff012c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (12, 'target', '{"emptied":false,"partition":"p_A5SQ54P3C5RE0X27","read_pos":11,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', '6e2150c2785bacfc3a3ab3ed1c43db32e161d75b8986daeca4e07de326d5d0bb', NULL, NULL, NULL);
INSERT INTO public.content VALUES (13, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-24T13:37:53.426Z","policy_version":1,"ruleset_version":1,"today":"2026-11-24"}', '1ead72923bf86e673d906a2dcb0a4719b6455f179e832e8077407c5d1f96c922', NULL, NULL, NULL);
INSERT INTO public.content VALUES (13, 'ops/0/set/f1', '"2026-11-02"', 'bb1de3879fc3904da5b8b20834d8d58eac44c618f8305a7357557ae506daf77f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (13, 'ops/0/set/f2', '"30"', 'f20e4586c63ba3b2c06a97c4e585acea4a2977c3d8d81dc2d1f2275439ad90a7', NULL, NULL, NULL);
INSERT INTO public.content VALUES (13, 'ops/0/set/f3', '"taxi"', '7a064c2491cc802c8ed3d43507560ab951779574b21991954294405e57be3745', NULL, NULL, NULL);
INSERT INTO public.content VALUES (13, 'ops/0/target', '{"created":true,"intent":"insert","row":"r_3WNNNT1AYPQD12JA5XES73SDTZ","table":"t1"}', 'cae52bbd632ef22df3bdcb375e61e0c4d76caacedc732aaf3ed5fee0e483aac1', NULL, NULL, NULL);
INSERT INTO public.content VALUES (13, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (13, 'request_key', '{"key":"3718e9dc61f358acf92c0c5cf8892fee046dd1d8557e6cdc856634228d174357"}', '13a24a7348628ba17b560531de7848d8b3f118921ab1467df92735582e6f61b4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (14, 'request', '{"intent":"insert","set":{"amount":30,"date":"2026-11-02","note":"taxi"},"table":"household.expenses"}', 'd9e9ed8dd8d23adf88d6185adafe2254e272a0ecd451d4e2f45bce543f3bfada', NULL, NULL, NULL);
INSERT INTO public.content VALUES (14, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_GN7H33E479H4S7TD"}', 'd507e240846b8b514a870f7c527a306e5231436d6cffd3e8ab90295bb2d3f5d2', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'fields/f1/0', '{"status":"applied","value":"2026-11-02"}', '96a119bb0a7bc53bfaa2b66ba49a944c8959ef63f8218c5af954c7f093c803a2', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'fields/f2/0', '{"status":"applied","value":"30"}', '1712bdc8cfafa74ec9f72dc98448d3d1c62b78b6a7e3151d98154cd62872d59e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'fields/f3/0', '{"status":"applied","value":"taxi"}', 'ca8af995f357da958ad27752fa8f8064ea0cccc9ebbc49097f1b971e69a186d4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'literal/f1/0', '{"segments":[{"result":"na","source":14}]}', 'e05b307243777b6813b055f65fdf8e07b3fc003f3f4cfe5c8d252c266a522d97', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'literal/f2/0', '{"segments":[{"result":"na","source":14}]}', 'e05b307243777b6813b055f65fdf8e07b3fc003f3f4cfe5c8d252c266a522d97', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'literal/f3/0', '{"segments":[{"result":"na","source":14}]}', 'e05b307243777b6813b055f65fdf8e07b3fc003f3f4cfe5c8d252c266a522d97', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'sources/f1/0', '[{"kind":"value","source":14}]', '0c2e432acf8d5e0ebb8b3ccff0fa23f57b1788d2c11a8b7dd55c5a4df69c37b0', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'sources/f2/0', '[{"kind":"value","source":14}]', '0c2e432acf8d5e0ebb8b3ccff0fa23f57b1788d2c11a8b7dd55c5a4df69c37b0', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'sources/f3/0', '[{"kind":"value","source":14}]', '0c2e432acf8d5e0ebb8b3ccff0fa23f57b1788d2c11a8b7dd55c5a4df69c37b0', NULL, NULL, NULL);
INSERT INTO public.content VALUES (15, 'target', '{"cause":"request","created":true,"intent":"insert","op_index":0,"row":"r_3WNNNT1AYPQD12JA5XES73SDTZ","sv":1,"table":"t1"}', '9d1c7a7a7853d697e7a0d8a362806bf3c5640e13fc228442e8bb834ad322ddf1', NULL, NULL, NULL);
INSERT INTO public.content VALUES (16, 'checksum', '{"checksum":"02cfce4fdae133910f70340dd233e8f0bba42d37f0c5d998442390dfdbb426f0"}', '8466d6b60445e9f1e7b0d5a4efd5d66ec181a0111ebfbce9da69eff2891cc0b3', NULL, NULL, NULL);
INSERT INTO public.content VALUES (16, 'target', '{"emptied":false,"partition":"p_A5SQ54P3C5RE0X27","read_pos":15,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', '96f5d82f271628520b52023c9a6b0866d4c0ebc5696e9a67894447af5fcb1d25', NULL, NULL, NULL);
INSERT INTO public.content VALUES (17, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-24T13:37:53.438Z","policy_version":1,"ruleset_version":1,"today":"2026-11-24"}', 'ca792b066f68ce32d6f12641c7cab19e5237ee3b27f196943772a472fe3d3376', NULL, NULL, NULL);
INSERT INTO public.content VALUES (17, 'ops/0/set/f1', '"2026-11-03"', 'd658e2a3b5597fab6e1c619fb80cdf08d37763c2d403667798cddcf65eeccb97', NULL, NULL, NULL);
INSERT INTO public.content VALUES (17, 'ops/0/set/f2', '"18"', '0234a350f4d56ae45c5ece57b08c54496f372bc570bd83a465fb6d2d85531479', NULL, NULL, NULL);
INSERT INTO public.content VALUES (17, 'ops/0/set/f3', '"coffee"', '0f52baaa23b045e196e5c8bffd06442c98eca166ca9d77582ce939d5f1b67a7d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (17, 'ops/0/target', '{"created":true,"intent":"insert","row":"r_7VVDMS5EX7H3XTBGA7N45G8HKN","table":"t1"}', '964727fb78a5373401e0f82e678392987d40a14041a0eec9211019d5be1f55db', NULL, NULL, NULL);
INSERT INTO public.content VALUES (17, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (17, 'request_key', '{"key":"283daf2df3d24e352997699891067dc933fb75dd19b7653888932863ea2b4b6b"}', '3d7ef37744623fe6ddba0df466320de415729c8ff4c8578ab32a71759129cf44', NULL, NULL, NULL);
INSERT INTO public.content VALUES (18, 'request', '{"intent":"insert","set":{"amount":18,"date":"2026-11-03","note":"coffee"},"table":"household.expenses"}', '6da0ef3e89920647fdb115c80b2a013c88124bcb6196612e78670c5eae4d9692', NULL, NULL, NULL);
INSERT INTO public.content VALUES (18, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_G1X808GWSQYW2D6A"}', 'c68138b457f539ced985cb0a8958d25f3888c2d2dc07c5248cea331c8f6a71fc', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'fields/f1/0', '{"status":"applied","value":"2026-11-03"}', '54dff293fa73477624b85fd869155a45261fa9df38233ae3c67233b985538f91', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'fields/f2/0', '{"status":"applied","value":"18"}', '751b79871b4d159bc5c227b5a148469189fbce2f626be069f2569073af35daaa', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'fields/f3/0', '{"status":"applied","value":"coffee"}', '24ee69f41a25745b6cdb4e2910f9a6041cd302067b02f167fdc0e0e95f137c02', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'literal/f1/0', '{"segments":[{"result":"na","source":18}]}', '4a58ed960a93a8baf068beb9c9dc53968928ddc2e4c32292bb87467a49116653', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'literal/f2/0', '{"segments":[{"result":"na","source":18}]}', '4a58ed960a93a8baf068beb9c9dc53968928ddc2e4c32292bb87467a49116653', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'literal/f3/0', '{"segments":[{"result":"na","source":18}]}', '4a58ed960a93a8baf068beb9c9dc53968928ddc2e4c32292bb87467a49116653', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'sources/f1/0', '[{"kind":"value","source":18}]', '319b9de0cbecc6b80f3925d4ca8167b0a3934443f98d4627237125576b1ae684', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'sources/f2/0', '[{"kind":"value","source":18}]', '319b9de0cbecc6b80f3925d4ca8167b0a3934443f98d4627237125576b1ae684', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'sources/f3/0', '[{"kind":"value","source":18}]', '319b9de0cbecc6b80f3925d4ca8167b0a3934443f98d4627237125576b1ae684', NULL, NULL, NULL);
INSERT INTO public.content VALUES (19, 'target', '{"cause":"request","created":true,"intent":"insert","op_index":0,"row":"r_7VVDMS5EX7H3XTBGA7N45G8HKN","sv":1,"table":"t1"}', '6bb16b84b59d11d385c673ed373c35a9ec0c55d0ef4be697e9d0ad9b2e1f66ed', NULL, NULL, NULL);
INSERT INTO public.content VALUES (20, 'checksum', '{"checksum":"2fdb99b9e376a0eeb9374c90106ded3f433d35bc1a11400eea77fa992ffc1b74"}', '2b6486c5a4c6121ac9f7a151dd594635971ef3202c83a53472eee255f03746ef', NULL, NULL, NULL);
INSERT INTO public.content VALUES (20, 'key', '{"values":["2026-11-03"]}', '197cbb7c11daaeba4de02e882703c19e248a409995fb839b5ad392c09d93f8dd', NULL, NULL, NULL);
INSERT INTO public.content VALUES (20, 'target', '{"emptied":false,"partition":"p_K55ESCGAGVWWQ6JR","read_pos":19,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', 'cbf18f174b75c068cfa0ba17bc5f85742d70a857b494a03ee82ddc12cc11f10a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (21, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-24T13:37:53.448Z","policy_version":1,"ruleset_version":1,"today":"2026-11-24"}', 'f79188bd1a412a37f83e36ad34b340910003b54638d117256ec15d64bace179b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (21, 'ops/0/set/f2', '"54"', '6ce1ced1ac1f56f8cd7ee5c55d117fe99c805b89a603e36c41852fea49853068', NULL, NULL, NULL);
INSERT INTO public.content VALUES (21, 'ops/0/target', '{"intent":"correct","row":"r_XDTMQRPMBQXRDFX4YKSEW79FBN","table":"t1","ver":{"basis":"explicit","current":true,"op":9,"restore_count":0}}', 'e67c36cd66240c7ce7ce1e46d8bdcc7aa39c59cf69108a5372d7da73b984cfb3', NULL, NULL, NULL);
INSERT INTO public.content VALUES (21, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (21, 'request_key', '{"key":"12a9369030808c7fe7a6f53e6167f7bb396e0a5d454ceb74c7a0fe5ac8ab1efb"}', 'd175ad15ed1adfe4386d241e98e7b459b33d69f38846d6a044f4cb824ad3e9ca', NULL, NULL, NULL);
INSERT INTO public.content VALUES (22, 'target', '{"kind":"user_message","level":"user_stated","source_id":"s_PBGBE7ENT7YWRB2F"}', '3dcc6828d3698667de12375d2cbf8f5a2ff6fc66d566334849a4d1c365c4a2d9', NULL, NULL, NULL);
INSERT INTO public.content VALUES (22, 'text', '{"text":"sorry, lunch was 54"}', '09db22c6ce9b888483906e0876b820f9021653c803cd9a16790a11f4e740081b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (23, 'fields/f2/0', '{"status":"applied","value":"54"}', '3066d5922eca1709cab4c55d047596dc085c9289eb0e69902f10bdafc414ee89', NULL, NULL, NULL);
INSERT INTO public.content VALUES (23, 'literal/f2/0', '{"segments":[{"result":"hit","source":22}]}', '4f71b5712c5b41e18380034068b347aebb77c5689a10fd56ecdb06563ff837e8', NULL, NULL, NULL);
INSERT INTO public.content VALUES (23, 'sources/f2/0', '[{"kind":"value","source":22}]', '6dbed4dff6a4840169d6cfbd4eb235fde4756a6ffdd1b298f89c0adababc0022', NULL, NULL, NULL);
INSERT INTO public.content VALUES (23, 'target', '{"cause":"request","intent":"correct","op_index":0,"row":"r_XDTMQRPMBQXRDFX4YKSEW79FBN","sv":1,"table":"t1"}', '265f4aaa8232d635a03fe19ff397a93e0449353bfefc61acdf2016613590b23f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (24, 'checksum', '{"checksum":"3eaa57f629c2a16acdfd512fb6ff4bec8d27f9ae97841034db8e35931425ff82"}', '39adea92dc1a7ba45beaca0e29d34ad976f8b8c60620a2631154d90778de98cb', NULL, NULL, NULL);
INSERT INTO public.content VALUES (24, 'target', '{"emptied":false,"partition":"p_A5SQ54P3C5RE0X27","read_pos":23,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', '06df4f3e4d9ba6a4eb051cd941d8d5ebd9d0f7e69f83a59c93221a03bf664ea5', NULL, NULL, NULL);
INSERT INTO public.content VALUES (25, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-24T13:37:53.458Z","policy_version":1,"ruleset_version":1,"today":"2026-11-24"}', '463b1d3f1cea169ded61b74fef73a68e90ec06b51902cd68daf744d7f5607dc1', NULL, NULL, NULL);
INSERT INTO public.content VALUES (25, 'ops/0/target', '{"intent":"revoke","row":"r_7VVDMS5EX7H3XTBGA7N45G8HKN","table":"t1","ver":{"basis":"explicit","current":true,"op":17,"restore_count":0}}', 'a728ab237c7f13ace5ac8800f8bf03674231010f449e2c0e853c16c4e1cd4c3e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (25, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (25, 'request_key', '{"key":"ef71d897a56c3e385824bb13d28eab0e102d68b241b6029c56b13f5a90f87982"}', '15f0eee03652ed218b664690d90a7fabf24c38a554409a947c3699c0a64dd41d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (26, 'request', '{"intent":"revoke","row":"r_7VVDMS5EX7H3XTBGA7N45G8HKN","table":"household.expenses","ver":"v17.0"}', 'e24c46477f8b8a01f3e23b65414a8ca6da851558df5078f1faf523c8213b82d6', NULL, NULL, NULL);
INSERT INTO public.content VALUES (26, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_Q5WN7NW596318BZ8"}', '9cb623f6095abe5070aba4a554a8adde63dcb0039e88f43ff06241f5f6c36d85', NULL, NULL, NULL);
INSERT INTO public.content VALUES (27, 'existence/0', '{"scope":"whole","status":"applied"}', '2f44b7beb399a814e1e20abc7d4ccfb73d0038177fbe9f78c3a9f6d7c497e5a2', NULL, NULL, NULL);
INSERT INTO public.content VALUES (27, 'op_sources', '[26]', '9cab0519f56f13acec86572516e8ebe7b99aa40011ec3171c9c8af90c08cae7a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (27, 'target', '{"cause":"request","intent":"revoke","op_index":0,"row":"r_7VVDMS5EX7H3XTBGA7N45G8HKN","sv":1,"table":"t1"}', '90ac6ab1c795e00cd19383b7e6339a8affd62632917d996da72942e5a61acbb2', NULL, NULL, NULL);
INSERT INTO public.content VALUES (28, 'target', '{"emptied":true,"partition":"p_K55ESCGAGVWWQ6JR","read_pos":27,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', '7e0affd32a848066e239a07cc9ec1ec776e8049b17b83ad2199fd3773537ccaa', NULL, NULL, NULL);
INSERT INTO public.content VALUES (29, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-24T13:37:53.468Z","policy_version":1,"ruleset_version":1,"today":"2026-11-24"}', '02d7c07f3721044921a430e610a9a2d6a88630105c05bebe2cb30fa20a6864bf', NULL, NULL, NULL);
INSERT INTO public.content VALUES (29, 'ops/0/set/f1', '"2026-11-04"', 'ba9fc93c7ed70a8b525f0a62023d41e1344542f7d58b17385ccc81443bf5421c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (29, 'ops/0/set/f2', '"9"', '986b79d4b69dffb1d19836f47b27073d95bf55201b3385aceb7e0687a21d8667', NULL, NULL, NULL);
INSERT INTO public.content VALUES (29, 'ops/0/set/f3', '"snack"', '176fabc59f5999b35a637537307adcad5b993e0c555bf86e403953b5bdd86a7e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (29, 'ops/0/target', '{"created":true,"intent":"insert","row":"r_VGKXJ8AASB0XE4BMMRW2BVT63C","table":"t1"}', '59c61b5dbb183a5440a4162d2eeeb6a27e5a8fec350f2ecaf16968483b70265d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (29, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (29, 'request_key', '{"key":"de65f290dffe64ba64a0a2582a69f8690edc8e4fb827127677ab18a0f7311e7c"}', '5df7762a072ca55916110d161a190d8611278e4243526aa79a5a36b171be53e4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (30, 'request', '{"intent":"insert","set":{"amount":9,"date":"2026-11-04","note":"snack"},"table":"household.expenses"}', '1e6e090a868923bafd27c360a50ab1d8bf00f4cedd7b02ccf64f898deee5a144', NULL, NULL, NULL);
INSERT INTO public.content VALUES (30, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_KCZ4F3K56FN7MQ40"}', 'abac1c12d5c24141b197cfe6b716c7ba1b129cd90d893fd3f15bbc911b54e496', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'fields/f1/0', '{"status":"applied","value":"2026-11-04"}', '44b6698d9440c789295afb873b3ac44d7074d41b719e4df1a846a31176d561ca', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'fields/f2/0', '{"status":"applied","value":"9"}', '61a0d6511cffcfb500d40f4e295289bdaef54675ed7241046e86da526085d56b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'fields/f3/0', '{"status":"applied","value":"snack"}', '79e9d32653ca14f4fdcec42e8e4b56080f01c897eeec3b97c1e7f22fc968a812', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'literal/f1/0', '{"segments":[{"result":"na","source":30}]}', '7af69cfa023aa24d18ec68e07573f47a474e1d13da839998df0e1c363cf6f334', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'literal/f2/0', '{"segments":[{"result":"na","source":30}]}', '7af69cfa023aa24d18ec68e07573f47a474e1d13da839998df0e1c363cf6f334', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'literal/f3/0', '{"segments":[{"result":"na","source":30}]}', '7af69cfa023aa24d18ec68e07573f47a474e1d13da839998df0e1c363cf6f334', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'sources/f1/0', '[{"kind":"value","source":30}]', '75e656324aefbcea4bd4431d6f5bedfcd073b73471966079df82048672fc3d66', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'sources/f2/0', '[{"kind":"value","source":30}]', '75e656324aefbcea4bd4431d6f5bedfcd073b73471966079df82048672fc3d66', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'sources/f3/0', '[{"kind":"value","source":30}]', '75e656324aefbcea4bd4431d6f5bedfcd073b73471966079df82048672fc3d66', NULL, NULL, NULL);
INSERT INTO public.content VALUES (31, 'target', '{"cause":"request","created":true,"intent":"insert","op_index":0,"row":"r_VGKXJ8AASB0XE4BMMRW2BVT63C","sv":1,"table":"t1"}', '9056303fe9bb9c2478094e907e5b97ee94bd3398ca59834b4927a8e34ab1950f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (32, 'checksum', '{"checksum":"352a37dda5548e17e41bc41d1faa41d33dfcf315b1b402cb40e86eb72eb109d9"}', 'f90a6949e3b50c947cbebb1eae26b3cd72eaadbef3fc613c8acfa2681db8358b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (32, 'key', '{"values":["2026-11-04"]}', '604bbd9e49c4a6737a3e5339db270d2778e5ed0ba7e814c136b4310d52da0b40', NULL, NULL, NULL);
INSERT INTO public.content VALUES (32, 'target', '{"emptied":false,"partition":"p_TTSA5Z91JXSVFYZ6","read_pos":31,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', '954eea01f0c96561f3b3da2376bd0161d2d896debda61590b4d181e7a6f76841', NULL, NULL, NULL);
INSERT INTO public.content VALUES (33, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-24T13:37:53.476Z","policy_version":1,"ruleset_version":1,"today":"2026-11-24"}', '83c505ac56566d6cccfc99d720bf25aeeb4a4c1a1216786b23e66a11503677ef', NULL, NULL, NULL);
INSERT INTO public.content VALUES (33, 'ops/0/target', '{"intent":"revoke","row":"r_VGKXJ8AASB0XE4BMMRW2BVT63C","table":"t1","ver":{"basis":"explicit","current":true,"op":29,"restore_count":0}}', '632a5e2a65b3f02318435be2167d0005c05c010f5478e0b0f1243c9278854f7a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (33, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (33, 'request_key', '{"key":"e694aa92a0ab08efc9333e17e3c8541effcc692750781565e1e700adeb9e55de"}', '5c9861a6c9c345e5a197628f0381e2d5b1460da16ad78c4c577f98e9d51dc3db', NULL, NULL, NULL);
INSERT INTO public.content VALUES (34, 'request', '{"intent":"revoke","row":"r_VGKXJ8AASB0XE4BMMRW2BVT63C","table":"household.expenses","ver":"v29.0"}', 'fc0486557360d8ba37a2edcf25d28df1a4242ce9516fd108342cbfef9dea4bbd', NULL, NULL, NULL);
INSERT INTO public.content VALUES (34, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_BK52B25AWY239VBC"}', '9e4cbe267d36aa920fdffe5d7bf3ab90b06abfdf9ffde8db8bffa6e3e6b2bca0', NULL, NULL, NULL);
INSERT INTO public.content VALUES (35, 'existence/0', '{"scope":"whole","status":"applied"}', '2f44b7beb399a814e1e20abc7d4ccfb73d0038177fbe9f78c3a9f6d7c497e5a2', NULL, NULL, NULL);
INSERT INTO public.content VALUES (35, 'op_sources', '[34]', 'cf898e079ee71e303468636c3d556a4b0748b4d896c226e31cbdc1f1c20932e5', NULL, NULL, NULL);
INSERT INTO public.content VALUES (35, 'target', '{"cause":"request","intent":"revoke","op_index":0,"row":"r_VGKXJ8AASB0XE4BMMRW2BVT63C","sv":1,"table":"t1"}', '27239276e728041139a2bb7e748a5d2c69589f215b6cc291587c375fb420f86a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (36, 'target', '{"emptied":true,"partition":"p_TTSA5Z91JXSVFYZ6","read_pos":35,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', '58c6af2d9948f5c48819619cb9b4957118bc2b70b63daec469199e42a978029b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (37, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-24T13:37:53.483Z","policy_version":1,"ruleset_version":1,"today":"2026-11-24"}', 'fae9281bc9406cfc906810504ee9944a7179602a33a31e0ececfec21cc3a8567', NULL, NULL, NULL);
INSERT INTO public.content VALUES (37, 'ops/0/revert', '{"include_later":false,"undo_op":33}', '79752873190e2f65f33153cf3fb49caa616976cd990b5b33a7504ff220add01b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (37, 'ops/0/target', '{"intent":"revoke","row":"r_VGKXJ8AASB0XE4BMMRW2BVT63C","table":"t1"}', '64e63d333a2757599933b3fdae0124b8db6ffdfd364f2d3d5d3c9b873e76835b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (37, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (37, 'request_key', '{"key":"9cda96a77fedcecee1b9d8e8eac0fcd29f228e47f4b175846db87befe9b1430b"}', '4d179bb9c8bfa4ed9e774db7ee9c19ea3efbcddb9412a923b643713455c086c6', NULL, NULL, NULL);
INSERT INTO public.content VALUES (38, 'request', '{"revert":{"undo":33},"row":"r_VGKXJ8AASB0XE4BMMRW2BVT63C","table":"household.expenses"}', '371319fd625868d331a69b787ad4fb9fec19f9848cf1233f5d0f735a6dc7c413', NULL, NULL, NULL);
INSERT INTO public.content VALUES (38, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_A8VM83M6CN8SDK4Y"}', 'f99c5b23cccad8990b1197998be6bc953de0d8da24e4ac453ea456e30b192efb', NULL, NULL, NULL);
INSERT INTO public.content VALUES (39, 'existence/0', '{"restored":true,"scope":"whole","status":"applied"}', '989e2e5071049ed6593c6ff63c96b6521f8c23fc8e1bfa4eb479dfb610f5a74f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (39, 'op_sources', '[38]', '3c2487b1e732eb168accd2f394b776519932cd77d5b74840e575428a0e87b71d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (39, 'revert', '{"before_op":33,"items":[{"event":35,"existence":true}]}', 'dcab9f5b1aecea8241e226a5962f39fff3421dc142c03c109ddf69dd08a2f9cd', NULL, NULL, NULL);
INSERT INTO public.content VALUES (39, 'target', '{"cause":"request","intent":"revoke","op_index":0,"row":"r_VGKXJ8AASB0XE4BMMRW2BVT63C","sv":1,"table":"t1"}', '27239276e728041139a2bb7e748a5d2c69589f215b6cc291587c375fb420f86a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (40, 'checksum', '{"checksum":"352a37dda5548e17e41bc41d1faa41d33dfcf315b1b402cb40e86eb72eb109d9"}', 'f90a6949e3b50c947cbebb1eae26b3cd72eaadbef3fc613c8acfa2681db8358b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (40, 'target', '{"emptied":false,"partition":"p_TTSA5Z91JXSVFYZ6","read_pos":39,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', '9acea5d8125527c01474f86eedf5bdd869267ad345d7e738371348fb4e0723a6', NULL, NULL, NULL);
INSERT INTO public.content VALUES (41, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-24T13:37:53.491Z","policy_version":1,"ruleset_version":1,"today":"2026-11-24"}', '4ac57789ca1f8214ec4359ffa39f57ad156fac47777696c3e5c763b35b0c6e31', NULL, NULL, NULL);
INSERT INTO public.content VALUES (41, 'ops/0/set/f2', '"32"', 'ca30de1c42bd3e0fdbeb7fb612cbf42e8e757b6948b7a51a67827df28b65107b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (41, 'ops/0/target', '{"intent":"update","row":"r_3WNNNT1AYPQD12JA5XES73SDTZ","table":"t1","ver":{"basis":"explicit","current":true,"op":13,"restore_count":0}}', 'f7472bfce558c75fdca7a6b11338ea1d1f68ee9634ad106bdfffc96aeefc3570', NULL, NULL, NULL);
INSERT INTO public.content VALUES (41, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (41, 'request_key', '{"key":"91d85e1a49a33e5d5aa4be268047dfb26860a71abed87e6005955d4c4c8a7355"}', '8298c8997361c82617d1b03436f900b038c48a2678079156a73478994566f271', NULL, NULL, NULL);
INSERT INTO public.content VALUES (42, 'request', '{"intent":"update","row":"r_3WNNNT1AYPQD12JA5XES73SDTZ","set":{"amount":32},"table":"household.expenses","ver":"v13.0"}', 'dc209e1dd24187a7bfe5ba9d11120704e7b106ce778d81f1f4cb0987d1b5010e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (42, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_ANXW111R106W7AWT"}', '730c845f26d900b1dcdcd89d544a25fb60f804bd895a74e03a3111ef81ca8169', NULL, NULL, NULL);
INSERT INTO public.content VALUES (43, 'fields/f2/0', '{"status":"applied","value":"32"}', 'd01ac326febf20813c49818b031035331a6f1e7ded0b73a8b97106cec8d47823', NULL, NULL, NULL);
INSERT INTO public.content VALUES (43, 'literal/f2/0', '{"segments":[{"result":"na","source":42}]}', '1a687bdc91fa9ef800597fc2cd0f41c7108d749595bed18fb74240e3f9ea68ad', NULL, NULL, NULL);
INSERT INTO public.content VALUES (43, 'sources/f2/0', '[{"kind":"value","source":42}]', '3e7a7b48647625cc8a330c1532e3369fce25d168ab0f7550f5277aa9ece719ea', NULL, NULL, NULL);
INSERT INTO public.content VALUES (43, 'target', '{"cause":"request","intent":"update","op_index":0,"row":"r_3WNNNT1AYPQD12JA5XES73SDTZ","sv":1,"table":"t1"}', '3474b21082ca7e0ae8caa5beefe21fccf9a6e478df17c5dfe0c019145c75e95d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (44, 'checksum', '{"checksum":"5aa3eee0bb3c73e7b833ae4779c454cd1706ac1c695777f62fbac858f284a139"}', 'a21a42a61794912949d594a6d2bf584300603cc131bfa770b320ee28bf982b08', NULL, NULL, NULL);
INSERT INTO public.content VALUES (44, 'target', '{"emptied":false,"partition":"p_A5SQ54P3C5RE0X27","read_pos":43,"reads":[{"table":"t1"}],"rule":"r1","rule_version":1,"table":"t5"}', 'bfc3c7e215ad7dd2968a421b5957fc543a1ea2150daa7858d43a79f3af93678b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (45, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-24T13:37:53.500Z","policy_version":1,"ruleset_version":1,"today":"2026-11-24"}', '1c909fb7e09e257c2893de2e315592b2eb3429c0f7e1e60d7060f41b5acd7b2a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (45, 'ops/0/set/f2', '"35"', '4bf17f4cd842cc1812f81a696010ee962c1c6f4db784a26b47cfde3144db8ae4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (45, 'ops/0/target', '{"intent":"update","row":"r_3WNNNT1AYPQD12JA5XES73SDTZ","table":"t1","ver":{"basis":"explicit","op":13,"restore_count":0}}', '93ccaf7e18a863de581b80556578bf91c61c0a6b46aae44e8298dc7e716c35fd', NULL, NULL, NULL);
INSERT INTO public.content VALUES (45, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (45, 'request_key', '{"key":"0404c5aeed91b6b70a4972c8c1b30cb7e50c75e7a1ba7ab19c7de8ca230c2c5b"}', 'f8653e556bd899b09d1d5180d6b3428f495a699099cf7666fe548ebfe679690e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (46, 'request', '{"intent":"update","row":"r_3WNNNT1AYPQD12JA5XES73SDTZ","set":{"amount":35},"table":"household.expenses","ver":"v13.0"}', 'fc5808be3b0f19847d9064581ea28aa1e996af2f8af2bb9b9507b6319f2f3198', NULL, NULL, NULL);
INSERT INTO public.content VALUES (46, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_D9DPG81HXZ154H83"}', '33275bb67be530129b1783f03f599b224bb6e8a3aad60d290ae027429510bad7', NULL, NULL, NULL);
INSERT INTO public.content VALUES (47, 'fields/f2/0', '{"status":"candidate","value":"35"}', '0a46b36e4a8dcb521e89b693b64fb7ed71b710c7c253e001ab2d859ae7e6c13c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (47, 'literal/f2/0', '{"segments":[{"result":"na","source":46}]}', 'ec9a7df5f7d36e2816c86bda732347207da16137a062374518ad63eab7918133', NULL, NULL, NULL);
INSERT INTO public.content VALUES (47, 'sources/f2/0', '[{"kind":"value","source":46}]', 'b073fca649b906c9bf85d19138aa9815cd7bdf17d1dc4c51b535ded225066ef9', NULL, NULL, NULL);
INSERT INTO public.content VALUES (47, 'target', '{"cause":"request","intent":"update","op_index":0,"row":"r_3WNNNT1AYPQD12JA5XES73SDTZ","sv":1,"table":"t1"}', '3474b21082ca7e0ae8caa5beefe21fccf9a6e478df17c5dfe0c019145c75e95d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (48, 'candidates/0', '{"cause":"stale_write","deps":[{"event":47,"field":"f2","k":0}],"event":47,"intent":"update","items":[{"field":"f2","k":0,"value":"35"}],"seen":{"op":13,"restore_count":0}}', '065fc524c2f0fbb871cfbd39e9ee0066e0b87479a0bff27648841667910e752f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (48, 'current/0', '{"deps":[{"event":43,"field":"f2","k":0}],"field":"f2","op":41,"value":"32"}', '0c88032ef80c150050b77d11b9327972c67ab4ea3a6fbb5b5b8949dc6ef4dbb2', NULL, NULL, NULL);
INSERT INTO public.content VALUES (48, 'impact/0', '{"deps":[{"event":43,"field":"f2","k":0}],"kind":"reverted_write","op":41}', '781a112cf029985289bd07f26a2dea668fd6e9323c41b08e9dd99a5e79592e45', NULL, NULL, NULL);
INSERT INTO public.content VALUES (48, 'previous/0', '{"deps":[{"event":15,"field":"f2","k":0}],"field":"f2","value":"30"}', 'fae62666626a12c8b83c7a340e9588ee0da9a0d3a64b6136433e8578e60f82cc', NULL, NULL, NULL);
INSERT INTO public.content VALUES (48, 'target', '{"item":"pi_NST6T1JK0C0T4R94","merge_base_op":13,"origin_event":47,"policy_version":1,"reason":"stale_write","row":"r_3WNNNT1AYPQD12JA5XES73SDTZ","ruleset_version":1,"table":"t1","type":"conflict","unit":["f2"]}', '2810bb9bc59f0fd8a643dd34d2481caa4c64428eea6f3c0ba61c150ce4503076', NULL, NULL, NULL);
INSERT INTO public.content VALUES (49, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-24T13:37:53.510Z","policy_version":1,"ruleset_version":1,"today":"2026-11-24"}', '71203daa7ee6e74b8884eef4bb529a71e1679335acca89822294ff8462cf5904', NULL, NULL, NULL);
INSERT INTO public.content VALUES (49, 'ops/0/premises/0', '{"fields":["f2"],"range":"whole","row":"r_XDTMQRPMBQXRDFX4YKSEW79FBN","state":"current","table":"t1","ver":{"basis":"explicit","op":21,"restore_count":0}}', '6779971fa4ee2db7e168ef818f1c2a1ad71b430a274ef8e8e47889416a2f33ba', NULL, NULL, NULL);
INSERT INTO public.content VALUES (49, 'ops/0/set/f1', '"half of lunch"', 'c41224c57a8fe82b0d2e8c579ce6599dedf399a406007932a8013d383f495748', NULL, NULL, NULL);
INSERT INTO public.content VALUES (49, 'ops/0/set/f2', '"r_XDTMQRPMBQXRDFX4YKSEW79FBN"', 'f256c5716ea1520bfcf2a4856ddd69a85af0b1a5a4ecff51b2443f72677240cc', NULL, NULL, NULL);
INSERT INTO public.content VALUES (49, 'ops/0/target', '{"created":true,"intent":"insert","row":"r_30WY0P19Q5ZAZXJQS8QEA7Q2FV","table":"t4"}', '524afcef7e884b298b644ca3fdf9fd7b7ce39866623cb41c5e9779fa606e5b3b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (49, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (49, 'request_key', '{"key":"552f12803ad72c535f6cd96e92974d5e69c6ac494da113696778e1c29a994b47"}', 'd740aa6edf49949b378591c54702b8267d727c89475f95c354a717cb43ea00cb', NULL, NULL, NULL);
INSERT INTO public.content VALUES (50, 'request', '{"intent":"insert","premises":[{"fields":["amount"],"row":"r_XDTMQRPMBQXRDFX4YKSEW79FBN","table":"household.expenses","ver":"v21.0"}],"set":{"expense":"r_XDTMQRPMBQXRDFX4YKSEW79FBN","note":"half of lunch"},"table":"household.refunds"}', '8e5d79ec527bf45e2e1b52d44eb62e4856b1d4a8d8b94ad8de6e25903f944189', NULL, NULL, NULL);
INSERT INTO public.content VALUES (50, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_GJX302ZRSJP5YDV2"}', '4034a226e63447226c7b93f82fafaa1509acb3bd91003693f6b41f8ce6baf361', NULL, NULL, NULL);
INSERT INTO public.content VALUES (51, 'fields/f1/0', '{"status":"applied","value":"half of lunch"}', '6731b651c19eec0bf119411356eedb0d936803628773af9b41f5c8023511d907', NULL, NULL, NULL);
INSERT INTO public.content VALUES (51, 'fields/f2/0', '{"status":"applied","value":"r_XDTMQRPMBQXRDFX4YKSEW79FBN"}', '676d3a8c45f1dab98330ce36f0b5b658579fc1b116229c68387c575728b77f5b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (51, 'literal/f1/0', '{"segments":[{"result":"na","source":50}]}', '47b1956d41eaa447fffc4d8db1ff7cdb9186a0bf686582c5531d51a398c87729', NULL, NULL, NULL);
INSERT INTO public.content VALUES (51, 'literal/f2/0', '{"segments":[{"result":"na","source":50}]}', '47b1956d41eaa447fffc4d8db1ff7cdb9186a0bf686582c5531d51a398c87729', NULL, NULL, NULL);
INSERT INTO public.content VALUES (51, 'sources/f1/0', '[{"kind":"value","source":50}]', 'cd8ffd1b682a43ec63e90b2f0816a49abf4870fae625151a8e201616ea0c273d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (51, 'sources/f2/0', '[{"kind":"value","source":50}]', 'cd8ffd1b682a43ec63e90b2f0816a49abf4870fae625151a8e201616ea0c273d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (51, 'target', '{"cause":"request","created":true,"intent":"insert","op_index":0,"row":"r_30WY0P19Q5ZAZXJQS8QEA7Q2FV","sv":1,"table":"t4"}', '8fcbdbe0190aa4dd705c145b35b0a1eb4c57daa6aaabff7542f126df99ef374c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (52, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-24T13:37:53.518Z","policy_version":1,"ruleset_version":1,"today":"2026-11-24"}', 'd19b13d9916edc99953b61de022553010da13d3b8618073ada78ab89adeccf9f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (52, 'ops/0/set/f1', '"food"', '90960c7a6145a97cbb09d6478535c2b31f76050310286dabe9ae2463ee003850', NULL, NULL, NULL);
INSERT INTO public.content VALUES (52, 'ops/0/set/f2', '"5000"', '804856326d54d734f3b3212c16f6eef4ed73817278ad5262df1c40fc895feaca', NULL, NULL, NULL);
INSERT INTO public.content VALUES (52, 'ops/0/target', '{"by_entity_key":true,"created":true,"entity":"e_K9FD9A5G72KJ0YN4110M2X6TZS","intent":"update","table":"t2"}', 'ff98d72608e7679c9b2c31e86b55dd678e39b5b3f731d0f1fe44021b0456c3e3', NULL, NULL, NULL);
INSERT INTO public.content VALUES (52, 'ops/0/valid', '{"from":{"mode":"given","value":"2026-10-01"},"to":{"mode":"next_change"}}', '7273cec08b6fc076559e36a924c20ca07cbb746cfbe55c1528defa8ee63e7692', NULL, NULL, NULL);
INSERT INTO public.content VALUES (52, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (52, 'request_key', '{"key":"440a6795e4528cb6448e2cd5c752cca30b9717779aee8681e10089d7631a595b"}', '7c1bff1ebc9fcf249f83a4a71b123f45f8fbefb18337f56446ea146c5a1aad9c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (53, 'request', '{"entity_key":{"kind":"food"},"intent":"update","set":{"amount":5000},"table":"household.budgets","valid_from":"2026-10-01"}', 'e8c41a2624b6b6a263306b0402ba6c0950daa36a0e9f1dc65ef3082e621faa1e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (53, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_XE72K34K5P4EZGJ2"}', 'dacf96ae0f40a5999571b0f3866f1382dc2fb4b28ea60c90b5421ed612456a9b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'fields/f1/0', '{"status":"applied","value":"food"}', '3ce851fafc17dadf27fb8a73401c468b44acda2ff106fc54a0c477d259dd9fb7', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'fields/f2/0', '{"status":"applied","value":"5000"}', '0b0ab42381e2bb4d2859ec1864e72f7807787fd2bad4a716a2874538ba39f214', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'literal/f1/0', '{"segments":[{"result":"na","source":53}]}', 'b82e3ae156e1b50b66bf59d1eb89210ade76c884a0f4c0e8a77ece34fafe938a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'literal/f2/0', '{"segments":[{"result":"na","source":53}]}', 'b82e3ae156e1b50b66bf59d1eb89210ade76c884a0f4c0e8a77ece34fafe938a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'sources/f1/0', '[{"kind":"value","source":53}]', 'b863cc4850ac41d72e8c726892506c422beb9b9afad12203c31d774c5e150d73', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'sources/f2/0', '[{"kind":"value","source":53}]', 'b863cc4850ac41d72e8c726892506c422beb9b9afad12203c31d774c5e150d73', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'span/f1/0', '{"valid":{"from":"2026-10-01"}}', '80ba5cd58b91a2bf147edd7b90037d2a0c0f3aa70102ecbfa4458a539d352912', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'span/f2/0', '{"valid":{"from":"2026-10-01"}}', '80ba5cd58b91a2bf147edd7b90037d2a0c0f3aa70102ecbfa4458a539d352912', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'target', '{"cause":"request","created":true,"entity":"e_K9FD9A5G72KJ0YN4110M2X6TZS","intent":"update","op_index":0,"sv":1,"table":"t2"}', '3d4a6dbefb3c879ed9afbab6409319696bac5ffe00037a00d08f017c85c2c234', NULL, NULL, NULL);
INSERT INTO public.content VALUES (54, 'valid_sources', '[53]', '17673dea3b100a600846ee04777d0c0c2379258f5b5cb1757f7a36f4956a6c41', NULL, NULL, NULL);
INSERT INTO public.content VALUES (55, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-24T13:37:53.526Z","policy_version":1,"ruleset_version":1,"today":"2026-11-24"}', '2476fe2f33f77ce8d3561ec4d4699000eba731e3178cbb3ac892f5130516dba6', NULL, NULL, NULL);
INSERT INTO public.content VALUES (55, 'ops/0/noop', '["f1"]', '6dbd1ae38d591a1d8818e127651ac0a0c7f78f1d180b0aa1aefb82008c3b0758', NULL, NULL, NULL);
INSERT INTO public.content VALUES (55, 'ops/0/set/f2', '"4000"', '91197d7b81dc27b9b94cf890932114c5ab712da496885ba5cc01ee4617bfaae0', NULL, NULL, NULL);
INSERT INTO public.content VALUES (55, 'ops/0/target', '{"by_entity_key":true,"entity":"e_K9FD9A5G72KJ0YN4110M2X6TZS","intent":"update","table":"t2","ver":{"basis":"fallback","current":true,"op":52,"restore_count":0}}', '450889383a78889c4e0c31075dfcfc385b8ed5c7a77ee0709b1b97404eb996ac', NULL, NULL, NULL);
INSERT INTO public.content VALUES (55, 'ops/0/valid', '{"from":{"mode":"given","value":"2026-11-10"},"to":{"mode":"next_change"}}', '7c600349a954d222ff1f1271eaa0a9c540445c22d7e96a9a016d8d264664137a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (55, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (55, 'request_key', '{"key":"c921c1a0df9830ef4d337621223789c5d60c4d29a887c1a37572c359fc1ff18d"}', '987c6f9bb3cc0afe9bd135a48319c515efff24787481bde80cf6b58ea2f5c97c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (56, 'request', '{"entity_key":{"kind":"food"},"intent":"update","set":{"amount":4000},"table":"household.budgets","valid_from":"2026-11-10"}', '6de8c7b6772863dbbc50ebe46df7d75ea76e1602bc6d40942a71951ee91c85af', NULL, NULL, NULL);
INSERT INTO public.content VALUES (56, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_ETYK7XAN5APB5GR1"}', 'aff07e2aa4e76bfb2ff51ddd66cb6dae0803d4390790496b2abeb2043c5cc826', NULL, NULL, NULL);
INSERT INTO public.content VALUES (57, 'fields/f2/0', '{"status":"applied","value":"4000"}', '8e23d82c7ddbe448c60657d8ef710ec0874d39aa72be68e930cab31f55ed2c3c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (57, 'literal/f2/0', '{"segments":[{"result":"na","source":56}]}', 'b903cb2ddcbb0e12413687f6058f52d2b871ebf7330699e026a4a5a316848009', NULL, NULL, NULL);
INSERT INTO public.content VALUES (57, 'sources/f2/0', '[{"kind":"value","source":56}]', '593e1a291dbc0675ec506bfa03f88dc9ca033e93fa172bb081c78882c74de2c0', NULL, NULL, NULL);
INSERT INTO public.content VALUES (57, 'span/f2/0', '{"valid":{"from":"2026-11-10"}}', '3b11f29fa3cdd8a4f4128418a46b42c472731a46787965a030d57bd4bc9016ee', NULL, NULL, NULL);
INSERT INTO public.content VALUES (57, 'target', '{"cause":"request","entity":"e_K9FD9A5G72KJ0YN4110M2X6TZS","intent":"update","op_index":0,"sv":1,"table":"t2"}', 'e1ba193746e4c2c2150092477addb6c51867ceb007027087cea89d68940e3717', NULL, NULL, NULL);
INSERT INTO public.content VALUES (57, 'valid_sources', '[56]', '0494aeb56d68d0683dcdc2856752cd331cb1a9112b239e9a529519dbe29e3e63', NULL, NULL, NULL);
INSERT INTO public.content VALUES (58, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-24T13:37:53.535Z","policy_version":1,"ruleset_version":1,"today":"2026-11-24"}', '3a169dad84ebbce859c41c2d51cd24a58f3cb0afe23fb335ebfa8a41d64563a4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (58, 'ops/0/noop', '["f1"]', '6dbd1ae38d591a1d8818e127651ac0a0c7f78f1d180b0aa1aefb82008c3b0758', NULL, NULL, NULL);
INSERT INTO public.content VALUES (58, 'ops/0/set/f2', '"4500"', 'bf1ac8b2c5a894f0bb4ebd1fb15ab12d2c6a92bd0fe856d165f96705ef3bd2f5', NULL, NULL, NULL);
INSERT INTO public.content VALUES (58, 'ops/0/target', '{"by_entity_key":true,"entity":"e_K9FD9A5G72KJ0YN4110M2X6TZS","intent":"update","table":"t2","ver":{"basis":"fallback","current":true,"op":55,"restore_count":0}}', '889a9ea45e5119bfeef8bd7b5cbed87dcc2ea2f3e311cf600cbe40a167818c3e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (58, 'ops/0/valid', '{"from":{"mode":"given","value":"2026-10-15"},"to":{"mode":"open"}}', '5d334a626a7551e0201ad822cbaca0e27e317959d36d6fdbcbf24f69dc964360', NULL, NULL, NULL);
INSERT INTO public.content VALUES (58, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (58, 'request_key', '{"key":"1deb79c4da93d5e6f2a427e3e90274b33588ce385836916aca9e2d7e7a4564bf"}', 'e31e5884e770a1211250ae967829b74bb36f6efe893050ad9f2ccb700916f26c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (59, 'request', '{"entity_key":{"kind":"food"},"intent":"update","set":{"amount":4500},"table":"household.budgets","valid_from":"2026-10-15","valid_to":"open"}', 'c5d2dd03b95734ba4f02adf9455032dc2b9ed7da85f1b4e9b380424b0cadfa96', NULL, NULL, NULL);
INSERT INTO public.content VALUES (59, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_0BC9M2HQ16GH9VCY"}', '7dce2e12c167cfc62054e35b08257a2f42933f7ccbe0695c114773e0333e4b6e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (60, 'fields/f2/0', '{"status":"awaiting","value":"4500"}', 'f288797fe8e450502df4528235299c293b805ae7d783357cf4b339617a2c52c6', NULL, NULL, NULL);
INSERT INTO public.content VALUES (60, 'literal/f2/0', '{"segments":[{"result":"na","source":59}]}', 'ef6f298ec294bf8b4ed2361ce3505c6bd7a185b4f16a066d5e0b80387b7f5db4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (60, 'sources/f2/0', '[{"kind":"value","source":59}]', 'ee85e2dc2bc2423f1d88a9ca67df8394e495c9665b1425dce963b25eff9c454d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (60, 'span/f2/0', '{"valid":{"from":"2026-10-15"}}', 'e6c0c70a14cb53d847c607a85603c051efee5a3734f0fb019615c85467cf1daf', NULL, NULL, NULL);
INSERT INTO public.content VALUES (60, 'target', '{"cause":"request","entity":"e_K9FD9A5G72KJ0YN4110M2X6TZS","intent":"update","op_index":0,"sv":1,"table":"t2"}', 'e1ba193746e4c2c2150092477addb6c51867ceb007027087cea89d68940e3717', NULL, NULL, NULL);
INSERT INTO public.content VALUES (60, 'valid_sources', '[59]', '8f332db1356cb4786b468baab31bd75565bd751de9d984c92f9defbcc3ef172d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (67, 'ops/0/set/f3', '"12"', 'f9cacf3cb91a12e03bc4546834f95a50a4c5fe02276ac260148ea9296c442d39', NULL, NULL, NULL);
INSERT INTO public.content VALUES (61, 'current/0', '{"deps":[{"event":54,"field":"f2","k":0},{"event":57,"field":"f2","k":0},{"event":60,"field":"f2","k":0}],"field":"f2","op":52,"valid":{"from":"2026-10-15","to":"2026-11-10"},"value":"5000"}', '8073ae020c7890dea4e8000244d5f09095bed94efc3bbb260e09d99fccc843b9', NULL, NULL, NULL);
INSERT INTO public.content VALUES (61, 'current/1', '{"deps":[{"event":57,"field":"f2","k":0},{"event":60,"field":"f2","k":0}],"field":"f2","op":55,"valid":{"from":"2026-11-10"},"value":"4000"}', '12f8ff850df0f03ec83a43948411596d07d4044c5bc8f5519f8b066d63952ed7', NULL, NULL, NULL);
INSERT INTO public.content VALUES (61, 'impact/0', '{"deps":[{"event":54,"field":"f2","k":0},{"event":57,"field":"f2","k":0}],"field":"f2","kind":"overwritten_segment","op":52,"valid":{"from":"2026-10-15","to":"2026-11-10"},"value":"5000"}', '521fcc9f665137202a0ee51b79c5fe138d455d5d84ea89ce907809f9818960d3', NULL, NULL, NULL);
INSERT INTO public.content VALUES (61, 'impact/1', '{"deps":[{"event":57,"field":"f2","k":0}],"field":"f2","kind":"overwritten_segment","op":55,"valid":{"from":"2026-11-10"},"value":"4000"}', 'e2fe93e6bad541bd07dd7dc8b01c7c127aa53b6706e4e1e6302bdb61f0cf1afd', NULL, NULL, NULL);
INSERT INTO public.content VALUES (61, 'proposed/0', '{"deps":[{"event":60,"field":"f2","k":0}],"field":"f2","valid":{"from":"2026-10-15"},"value":"4500"}', 'f6faa8aff2ad990c5fd52f61ef4b8d9cdf80e7d8aac5f2ffc3f249a0100f640e', NULL, NULL, NULL);
INSERT INTO public.content VALUES (61, 'scope_valid', '{"deps":[{"event":60,"field":"f2","k":0}],"spans":[{"from":"2026-10-15"}]}', 'f698a8f359bb795e6eecf79a199215ba88cfb1957109b0749c970a193722b048', NULL, NULL, NULL);
INSERT INTO public.content VALUES (61, 'target', '{"entity":"e_K9FD9A5G72KJ0YN4110M2X6TZS","item":"pi_14N09C7KYY8ZFFKJ","origin_event":60,"policy_version":1,"reason":"overwrites_change_point","ruleset_version":1,"table":"t2","type":"awaiting_confirmation","unit":["f2"]}', '13f05e66a0ddcf5ea76737c69172332d7268609959cc073fd311c25ccc977443', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-24T13:37:53.546Z","policy_version":1,"ruleset_version":1,"today":"2026-11-24"}', '5d30ac0b47bd3a32bfbe57a4eca518d411b3f23ec52635e90f55b1a6e30a8e7a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ops/0/set/f1', '"app"', '4e5ef144c51cd25230c144c3e1d8e842b9860b7a3cec2699d4e24e6517fc4b20', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ops/0/set/f2', '"k-1"', 'f613e2ddb1ed1aefc2d87a1bc773c3a3e671f40809ffe8875486d58482e5259a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ops/0/set/f3', '"10"', '536549599ec6c3b859cd3970025779a13d061783c73e663fea7f963e98379aa8', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ops/0/target', '{"by_external_key":true,"created":true,"intent":"update","row":"r_2XDJE12PK0TSR0ZAVBMKW1B8WB","table":"t3"}', '87854fa74c44c829201689d86815533986930b3d585168d5007c305e9c571b40', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ops/1/set/f1', '"app"', '4e5ef144c51cd25230c144c3e1d8e842b9860b7a3cec2699d4e24e6517fc4b20', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ops/1/set/f2', '"k-2"', '242ae761454b02109f6b54c9077c298d68e7e96cf0087859efa80e54073f77aa', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ops/1/set/f3', '"21"', '6f8f349216adc47cfd723001f3dfbfc11179e1b36c31ce51c85056026f3d85b9', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'ops/1/target', '{"by_external_key":true,"created":true,"intent":"update","row":"r_7T9F8XC601XXQBZ8R6JK0QATGN","table":"t3"}', 'a8be8f5723c18e7d527798708b0663e6e17ff519ad372d9a4a5e20d2c146bdec', NULL, NULL, NULL);
INSERT INTO public.content VALUES (62, 'request', '{"op_count":2,"sv":1,"sv_basis":"explicit"}', 'e0cec6f32835f484f2a07b4776a1164f5e0b3d4ad918e86e9d189d29fce17780', NULL, NULL, NULL);
INSERT INTO public.content VALUES (63, 'request', '{"external_key":{"external_id":"k-1","origin":"app"},"intent":"update","set":{"fare":10},"table":"household.rides"}', '602bd852c41aaef9948bac4e79a237bad5b2c4ee7f721a2a8e6d4f5b741c490b', NULL, NULL, NULL);
INSERT INTO public.content VALUES (63, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_YJCCHD1JGNT8QBBM"}', '88e33819efb023ae94a0d7f7e96a767e35edf43415ba566f64cdecbb737ab2df', NULL, NULL, NULL);
INSERT INTO public.content VALUES (64, 'request', '{"external_key":{"external_id":"k-2","origin":"app"},"intent":"update","set":{"fare":21},"table":"household.rides"}', '9070f120653e01cb1fdfa2c01ae8d9c0a844e997d9435b4f4ef900dd4ab4476f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (64, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":1,"source_id":"s_KMYYHT7K362DJ731"}', '705d16362f254f738fb6de8cda898989d4ec8bfa0ebd56ced6124f7645af805f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'fields/f1/0', '{"status":"applied","value":"app"}', 'c0f87af78708bddb29d36c257c2d3a389a9a16d6077ecd1f72132e2c36458a46', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'fields/f2/0', '{"status":"applied","value":"k-1"}', 'f1b5335622ffbf0c57f3cb8d1242f129d57eec003bddfd855a7ed1c5a204a1ca', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'fields/f3/0', '{"status":"applied","value":"10"}', 'c5d6a3109242c147dbe9c262ab4ffa606fdb23aeab545dcd9f6edd4229e4746d', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'literal/f1/0', '{"segments":[{"result":"na","source":63}]}', 'e0841b0f39d829865177ccca851114fb9e7a5f13ced5e90f3d3327678303633a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'literal/f2/0', '{"segments":[{"result":"na","source":63}]}', 'e0841b0f39d829865177ccca851114fb9e7a5f13ced5e90f3d3327678303633a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'literal/f3/0', '{"segments":[{"result":"na","source":63}]}', 'e0841b0f39d829865177ccca851114fb9e7a5f13ced5e90f3d3327678303633a', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'sources/f1/0', '[{"kind":"value","source":63}]', 'b3dcee24b53b92ebf82de486dc7e1f5721207475796e39f5ccf7c765c022c434', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'sources/f2/0', '[{"kind":"value","source":63}]', 'b3dcee24b53b92ebf82de486dc7e1f5721207475796e39f5ccf7c765c022c434', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'sources/f3/0', '[{"kind":"value","source":63}]', 'b3dcee24b53b92ebf82de486dc7e1f5721207475796e39f5ccf7c765c022c434', NULL, NULL, NULL);
INSERT INTO public.content VALUES (65, 'target', '{"cause":"request","created":true,"intent":"update","op_index":0,"row":"r_2XDJE12PK0TSR0ZAVBMKW1B8WB","sv":1,"table":"t3"}', '61db773196982e575952c21ed84d34b1c3eb8b6ca615f431682965736ecc0767', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'fields/f1/0', '{"status":"applied","value":"app"}', 'c0f87af78708bddb29d36c257c2d3a389a9a16d6077ecd1f72132e2c36458a46', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'fields/f2/0', '{"status":"applied","value":"k-2"}', 'a00fb3f1544a5603c809d0f2c45478c13646761f47ee0ae70eceacfc5973e616', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'fields/f3/0', '{"status":"applied","value":"21"}', 'db2af3002b6b171e6a8ddf6ac2b6b0d0afbeaa88d898be80c8493e77e97a47fd', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'literal/f1/0', '{"segments":[{"result":"na","source":64}]}', '33c84a6f0c71d09e6d7804f71b7e8a38bbd3ff78740063cb982ad2858f322260', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'literal/f2/0', '{"segments":[{"result":"na","source":64}]}', '33c84a6f0c71d09e6d7804f71b7e8a38bbd3ff78740063cb982ad2858f322260', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'literal/f3/0', '{"segments":[{"result":"na","source":64}]}', '33c84a6f0c71d09e6d7804f71b7e8a38bbd3ff78740063cb982ad2858f322260', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'sources/f1/0', '[{"kind":"value","source":64}]', '58b096f741dec54695b0d08a032222f771639c9bcb2dd1fa941aa16fd6baade4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'sources/f2/0', '[{"kind":"value","source":64}]', '58b096f741dec54695b0d08a032222f771639c9bcb2dd1fa941aa16fd6baade4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'sources/f3/0', '[{"kind":"value","source":64}]', '58b096f741dec54695b0d08a032222f771639c9bcb2dd1fa941aa16fd6baade4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (66, 'target', '{"cause":"request","created":true,"intent":"update","op_index":1,"row":"r_7T9F8XC601XXQBZ8R6JK0QATGN","sv":1,"table":"t3"}', '299099f8fec49f971971dcc4a851dee7969d81a4facf59cd0dd6544088bbca7f', NULL, NULL, NULL);
INSERT INTO public.content VALUES (67, 'ctx', '{"literal_checker":"literal@1","now":"2026-11-24T13:37:53.554Z","policy_version":1,"ruleset_version":1,"today":"2026-11-24"}', '213b8631a67d5eb27547d5fbce4f0cd07b6c36c8322c308b94e66600e7783836', NULL, NULL, NULL);
INSERT INTO public.content VALUES (67, 'ops/0/baseline', '{"f3":62}', '850f6f2f9e33426a9e5b1b478f780ef8e999f86ad52151a509a7c4f9f7864a44', NULL, NULL, NULL);
INSERT INTO public.content VALUES (67, 'ops/0/noop', '["f1","f2"]', '8fd6f2004d3e89f6c04b595c49979ed48da7f355575a31f9ae6a2456b6c9bca4', NULL, NULL, NULL);
INSERT INTO public.content VALUES (67, 'ops/0/target', '{"by_external_key":true,"intent":"update","row":"r_2XDJE12PK0TSR0ZAVBMKW1B8WB","table":"t3","ver":{"basis":"external_key","op":62,"restore_count":0}}', 'e2069c356dafcad24b69f57b629e03eaf5227135a42f7eb5f3cf9cb014f3bc72', NULL, NULL, NULL);
INSERT INTO public.content VALUES (67, 'request', '{"op_count":1,"sv":1,"sv_basis":"explicit"}', 'd3bf546a68b333f282cdd47bb235a92063ed5be45c1c33806ca35a0bac09bd23', NULL, NULL, NULL);
INSERT INTO public.content VALUES (68, 'request', '{"external_key":{"external_id":"k-1","origin":"app"},"intent":"update","set":{"fare":12},"table":"household.rides"}', '78ff3623de3e1aca1b75daff2eecf8abd849fec8d2acd8cfd01d39fd79dd241c', NULL, NULL, NULL);
INSERT INTO public.content VALUES (68, 'target', '{"kind":"api_call","level":"agent_inferred","op_index":0,"source_id":"s_SQGJE48NG51WTZS1"}', '277f14e0aaec881af1b8542b3961eff5d67afb18c21cbe43e69547b8e3d27b02', NULL, NULL, NULL);
INSERT INTO public.content VALUES (69, 'fields/f3/0', '{"status":"applied","value":"12"}', 'ea590704ad6cb667a1c44e5aee91b061a120ea192f3fb3d6c64f11c2ca83fcf8', NULL, NULL, NULL);
INSERT INTO public.content VALUES (69, 'literal/f3/0', '{"segments":[{"result":"na","source":68}]}', 'a85b1c503221104998ddbd9e272a8efe5e7fe98227785680540222545cd02ac0', NULL, NULL, NULL);
INSERT INTO public.content VALUES (69, 'sources/f3/0', '[{"kind":"value","source":68}]', '29d246f835e24bc3a7360376a47f538836990cd62f470717347de67553d26ef6', NULL, NULL, NULL);
INSERT INTO public.content VALUES (69, 'target', '{"cause":"request","intent":"update","op_index":0,"row":"r_2XDJE12PK0TSR0ZAVBMKW1B8WB","sv":1,"table":"t3"}', '06954afee1620aa98da3ae29037d943d68cd74cfae8d17865e54bd765dd31856', NULL, NULL, NULL);


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

INSERT INTO public.d_t5_v1 VALUES ('p_TTSA5Z91JXSVFYZ6', '2026-11-04', 9, 1, 37);
INSERT INTO public.d_t5_v1 VALUES ('p_A5SQ54P3C5RE0X27', '2026-11-02', 86, 2, 41);


--
-- Data for Name: deletions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: derived_reads; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.derived_reads VALUES (12, 't1', 'p_A5SQ54P3C5RE0X27', 1, 11);
INSERT INTO public.derived_reads VALUES (16, 't1', 'p_A5SQ54P3C5RE0X27', 1, 15);
INSERT INTO public.derived_reads VALUES (20, 't1', 'p_K55ESCGAGVWWQ6JR', 1, 19);
INSERT INTO public.derived_reads VALUES (24, 't1', 'p_A5SQ54P3C5RE0X27', 1, 23);
INSERT INTO public.derived_reads VALUES (28, 't1', 'p_K55ESCGAGVWWQ6JR', 1, 27);
INSERT INTO public.derived_reads VALUES (32, 't1', 'p_TTSA5Z91JXSVFYZ6', 1, 31);
INSERT INTO public.derived_reads VALUES (36, 't1', 'p_TTSA5Z91JXSVFYZ6', 1, 35);
INSERT INTO public.derived_reads VALUES (40, 't1', 'p_TTSA5Z91JXSVFYZ6', 1, 39);
INSERT INTO public.derived_reads VALUES (44, 't1', 'p_A5SQ54P3C5RE0X27', 1, 43);


--
-- Data for Name: events; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.events VALUES (1, '{"actor":"u_DZEESWD7AKV5KWM10SWNFK03W4","at":"2026-11-24T13:37:53.130Z","node_id":"n_PQ8B4HTQSDY7JM8NQAVV06J7Y4","prev_hash":"0000000000000000000000000000000000000000000000000000000000000000","seq":1,"type":"tenant.genesis","v":1}', 'ed02a2e42f4a43420b82ea6f263c42d1cdd3f5bd74195cb9d1b1fc5ad6061279', 'tenant.genesis', 'u_DZEESWD7AKV5KWM10SWNFK03W4', '2026-11-24T13:37:53.130Z', 1, NULL, NULL, NULL, NULL);
INSERT INTO public.events VALUES (2, '{"actor":"u_DZEESWD7AKV5KWM10SWNFK03W4","at":"2026-11-24T13:37:53.346Z","prev_hash":"ed02a2e42f4a43420b82ea6f263c42d1cdd3f5bd74195cb9d1b1fc5ad6061279","seq":2,"slot":"sl_ZSNW59W1GYV3Z145","type":"schema.draft_submitted","v":1}', '4a28bc270ecda5a4b5ab67905bf792a0b99f95db484a21bbffe9d2110a9d7914', 'schema.draft_submitted', 'u_DZEESWD7AKV5KWM10SWNFK03W4', '2026-11-24T13:37:53.346Z', 2, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (3, '{"actor":"u_DZEESWD7AKV5KWM10SWNFK03W4","at":"2026-11-24T13:37:53.346Z","op":2,"prev_hash":"4a28bc270ecda5a4b5ab67905bf792a0b99f95db484a21bbffe9d2110a9d7914","seq":3,"slot":"sl_ZSNW59W1GYV3Z145","type":"schema.compiled","v":1}', '88f6a8a11c00221651c5e8bcb641f64f87c722ba91a32a9cb98fcc49890b3f2e', 'schema.compiled', 'u_DZEESWD7AKV5KWM10SWNFK03W4', '2026-11-24T13:37:53.346Z', 2, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (4, '{"actor":"u_DZEESWD7AKV5KWM10SWNFK03W4","at":"2026-11-24T13:37:53.346Z","op":2,"prev_hash":"88f6a8a11c00221651c5e8bcb641f64f87c722ba91a32a9cb98fcc49890b3f2e","seq":4,"slot":"sl_ZSNW59W1GYV3Z145","type":"schema.confirmed","v":1}', '2ec994a9cf4ea008740977ec0a27208b68b9e71c97d9b78694115c9c02ff7ed6', 'schema.confirmed', 'u_DZEESWD7AKV5KWM10SWNFK03W4', '2026-11-24T13:37:53.346Z', 2, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (5, '{"actor":"u_DZEESWD7AKV5KWM10SWNFK03W4","at":"2026-11-24T13:37:53.346Z","op":2,"prev_hash":"2ec994a9cf4ea008740977ec0a27208b68b9e71c97d9b78694115c9c02ff7ed6","seq":5,"slot":"sl_ZSNW59W1GYV3Z145","type":"slot.policy_set","v":1}', '8bb400c19a87bcb3d91376a1f60811b4cbca11763cd8e12a7ca7e84e5e20bbad', 'slot.policy_set', 'u_DZEESWD7AKV5KWM10SWNFK03W4', '2026-11-24T13:37:53.346Z', 2, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (6, '{"actor":"u_DZEESWD7AKV5KWM10SWNFK03W4","at":"2026-11-24T13:37:53.346Z","op":2,"prev_hash":"8bb400c19a87bcb3d91376a1f60811b4cbca11763cd8e12a7ca7e84e5e20bbad","seq":6,"slot":"sl_ZSNW59W1GYV3Z145","type":"schema.switched","v":1}', '67da1130f48fb12886a4db636bc29853c295f2ab1129ef0db4542bf100f1491c', 'schema.switched', 'u_DZEESWD7AKV5KWM10SWNFK03W4', '2026-11-24T13:37:53.346Z', 2, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (7, '{"actor":"u_DZEESWD7AKV5KWM10SWNFK03W4","at":"2026-11-24T13:37:53.394Z","prev_hash":"67da1130f48fb12886a4db636bc29853c295f2ab1129ef0db4542bf100f1491c","seq":7,"type":"principal.registered","v":1}', '11ae5302abbf27daa946b90d2c471ed1e04d5315bde480b9743a2f568a56063b', 'principal.registered', 'u_DZEESWD7AKV5KWM10SWNFK03W4', '2026-11-24T13:37:53.394Z', 7, NULL, NULL, NULL, NULL);
INSERT INTO public.events VALUES (8, '{"actor":"u_DZEESWD7AKV5KWM10SWNFK03W4","at":"2026-11-24T13:37:53.397Z","prev_hash":"11ae5302abbf27daa946b90d2c471ed1e04d5315bde480b9743a2f568a56063b","seq":8,"type":"principal.registered","v":1}', '33174538f3a2efff11275e6e1506093a4dd8935f9cb9cf670bf394e6c25e7dd5', 'principal.registered', 'u_DZEESWD7AKV5KWM10SWNFK03W4', '2026-11-24T13:37:53.397Z', 8, NULL, NULL, NULL, NULL);
INSERT INTO public.events VALUES (9, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.400Z","prev_hash":"33174538f3a2efff11275e6e1506093a4dd8935f9cb9cf670bf394e6c25e7dd5","seq":9,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.head","v":1}', 'e736ddff6616351bc9a7279cb360e166e029ed9d3f07e71100d1c079db8b7ab4', 'write.head', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.400Z', 9, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (10, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.400Z","op":9,"prev_hash":"e736ddff6616351bc9a7279cb360e166e029ed9d3f07e71100d1c079db8b7ab4","seq":10,"slot":"sl_ZSNW59W1GYV3Z145","type":"source.recorded","v":1}', 'faf8d63592fee4dd4363ecd0686c9f526d0b7fba6c0f2e65a282e4d189eea2b8', 'source.recorded', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.400Z', 9, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (11, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.400Z","op":9,"prev_hash":"faf8d63592fee4dd4363ecd0686c9f526d0b7fba6c0f2e65a282e4d189eea2b8","seq":11,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.base","v":1}', '224f5f6ab6c5f6620a81e4e37b2e6f3963bc0338c1116f5f25fb986fd3902b93', 'write.base', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.400Z', 9, 'sl_ZSNW59W1GYV3Z145', 't1', 'r_XDTMQRPMBQXRDFX4YKSEW79FBN', NULL);
INSERT INTO public.events VALUES (12, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.400Z","op":9,"prev_hash":"224f5f6ab6c5f6620a81e4e37b2e6f3963bc0338c1116f5f25fb986fd3902b93","seq":12,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.derived","v":1}', '466febefc9bead0520b00265ff98d851712540aa3be46f938f7871a3e27ae62a', 'write.derived', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.400Z', 9, 'sl_ZSNW59W1GYV3Z145', 't5', NULL, NULL);
INSERT INTO public.events VALUES (13, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.426Z","prev_hash":"466febefc9bead0520b00265ff98d851712540aa3be46f938f7871a3e27ae62a","seq":13,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.head","v":1}', '6ec8fdfcf5d370d3c455432886ed1070a1141cf0ac326a8387c8788a4557804a', 'write.head', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.426Z', 13, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (14, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.426Z","op":13,"prev_hash":"6ec8fdfcf5d370d3c455432886ed1070a1141cf0ac326a8387c8788a4557804a","seq":14,"slot":"sl_ZSNW59W1GYV3Z145","type":"source.recorded","v":1}', '76e7e222242363c3d1135fe0991ea9d1eaaed6c62ddc282587662feb2919c29e', 'source.recorded', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.426Z', 13, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (15, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.426Z","op":13,"prev_hash":"76e7e222242363c3d1135fe0991ea9d1eaaed6c62ddc282587662feb2919c29e","seq":15,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.base","v":1}', 'cc9c8cd43744b733b4fe43740eab694b5681d74d094e54a4fd03aabadb0b932f', 'write.base', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.426Z', 13, 'sl_ZSNW59W1GYV3Z145', 't1', 'r_3WNNNT1AYPQD12JA5XES73SDTZ', NULL);
INSERT INTO public.events VALUES (16, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.426Z","op":13,"prev_hash":"cc9c8cd43744b733b4fe43740eab694b5681d74d094e54a4fd03aabadb0b932f","seq":16,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.derived","v":1}', '839c52dd38dc9df8e58c8275c8ba86a1bfa30b158fbf070ecc38f610893d4cae', 'write.derived', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.426Z', 13, 'sl_ZSNW59W1GYV3Z145', 't5', NULL, NULL);
INSERT INTO public.events VALUES (17, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.438Z","prev_hash":"839c52dd38dc9df8e58c8275c8ba86a1bfa30b158fbf070ecc38f610893d4cae","seq":17,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.head","v":1}', '47d7f3aedf4049218834ba41c2305462e0280381bc18413c2f3ebcfe1dd8cf72', 'write.head', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.438Z', 17, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (18, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.438Z","op":17,"prev_hash":"47d7f3aedf4049218834ba41c2305462e0280381bc18413c2f3ebcfe1dd8cf72","seq":18,"slot":"sl_ZSNW59W1GYV3Z145","type":"source.recorded","v":1}', '9a632310ee35db088978e02243678781afc10ef0bcd3b679377fe8ceba6d1fab', 'source.recorded', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.438Z', 17, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (19, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.438Z","op":17,"prev_hash":"9a632310ee35db088978e02243678781afc10ef0bcd3b679377fe8ceba6d1fab","seq":19,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.base","v":1}', '58ebd15787c191948e5b7ff39e2d3372ff82f277b29c0027fdf9aba394f27bae', 'write.base', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.438Z', 17, 'sl_ZSNW59W1GYV3Z145', 't1', 'r_7VVDMS5EX7H3XTBGA7N45G8HKN', NULL);
INSERT INTO public.events VALUES (20, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.438Z","op":17,"prev_hash":"58ebd15787c191948e5b7ff39e2d3372ff82f277b29c0027fdf9aba394f27bae","seq":20,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.derived","v":1}', '739938afe1954b7f0694a307feb3cb2b275acf426779b30ea1b650f038f2b018', 'write.derived', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.438Z', 17, 'sl_ZSNW59W1GYV3Z145', 't5', NULL, NULL);
INSERT INTO public.events VALUES (21, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.448Z","prev_hash":"739938afe1954b7f0694a307feb3cb2b275acf426779b30ea1b650f038f2b018","seq":21,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.head","v":1}', '9d2fe3c0196d3d66bfac7134d2f8b6eef0e820a2419f634515f207262857207d', 'write.head', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.448Z', 21, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (22, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.448Z","op":21,"prev_hash":"9d2fe3c0196d3d66bfac7134d2f8b6eef0e820a2419f634515f207262857207d","seq":22,"slot":"sl_ZSNW59W1GYV3Z145","type":"source.recorded","v":1}', '185d8c5a4615d3ca50b02e4369b88119538ce32832310c93127034caa410101f', 'source.recorded', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.448Z', 21, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (23, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.448Z","op":21,"prev_hash":"185d8c5a4615d3ca50b02e4369b88119538ce32832310c93127034caa410101f","seq":23,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.base","v":1}', '642a5b16eb469c5ba27c71d1461b8ac2a330c095567a099bae71e3c811bf089d', 'write.base', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.448Z', 21, 'sl_ZSNW59W1GYV3Z145', 't1', 'r_XDTMQRPMBQXRDFX4YKSEW79FBN', NULL);
INSERT INTO public.events VALUES (24, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.448Z","op":21,"prev_hash":"642a5b16eb469c5ba27c71d1461b8ac2a330c095567a099bae71e3c811bf089d","seq":24,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.derived","v":1}', '5bcea9a576181d05ea92742d0cf371aaa80cbb71d1033bfff290cb2e0ff757bd', 'write.derived', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.448Z', 21, 'sl_ZSNW59W1GYV3Z145', 't5', NULL, NULL);
INSERT INTO public.events VALUES (25, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.458Z","prev_hash":"5bcea9a576181d05ea92742d0cf371aaa80cbb71d1033bfff290cb2e0ff757bd","seq":25,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.head","v":1}', '7de3b7b0f7335c922d594365474f437d77829e8f6611dc2bdcf05ef7f5b3b683', 'write.head', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.458Z', 25, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (26, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.458Z","op":25,"prev_hash":"7de3b7b0f7335c922d594365474f437d77829e8f6611dc2bdcf05ef7f5b3b683","seq":26,"slot":"sl_ZSNW59W1GYV3Z145","type":"source.recorded","v":1}', 'd43cec1315ce1362efdf63bc86c08492e9cbf91621187d1e300dda4935694f20', 'source.recorded', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.458Z', 25, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (27, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.458Z","op":25,"prev_hash":"d43cec1315ce1362efdf63bc86c08492e9cbf91621187d1e300dda4935694f20","seq":27,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.base","v":1}', '6c077823e9a96335e5f2571899f1e084e73a6040d47acc3d562d6e7c9c55c1ef', 'write.base', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.458Z', 25, 'sl_ZSNW59W1GYV3Z145', 't1', 'r_7VVDMS5EX7H3XTBGA7N45G8HKN', NULL);
INSERT INTO public.events VALUES (28, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.458Z","op":25,"prev_hash":"6c077823e9a96335e5f2571899f1e084e73a6040d47acc3d562d6e7c9c55c1ef","seq":28,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.derived","v":1}', 'a6dff5d6817b2324b40e6934feb7cec1c9106b8247439934cdd199c35159b75d', 'write.derived', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.458Z', 25, 'sl_ZSNW59W1GYV3Z145', 't5', NULL, NULL);
INSERT INTO public.events VALUES (29, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.468Z","prev_hash":"a6dff5d6817b2324b40e6934feb7cec1c9106b8247439934cdd199c35159b75d","seq":29,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.head","v":1}', '96e9f16c7aa84ed47c89223177ab38262e25cb643a176ee32376b311cbd4e5d3', 'write.head', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.468Z', 29, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (30, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.468Z","op":29,"prev_hash":"96e9f16c7aa84ed47c89223177ab38262e25cb643a176ee32376b311cbd4e5d3","seq":30,"slot":"sl_ZSNW59W1GYV3Z145","type":"source.recorded","v":1}', 'd56a3e64213110850a2b323e94abf48f7df09d586c11874bff3c8975eeca698b', 'source.recorded', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.468Z', 29, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (31, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.468Z","op":29,"prev_hash":"d56a3e64213110850a2b323e94abf48f7df09d586c11874bff3c8975eeca698b","seq":31,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.base","v":1}', 'd754005545e205ba9720f9fef752c8a71cccfe7b373b8b96e660bf23a3b5bb36', 'write.base', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.468Z', 29, 'sl_ZSNW59W1GYV3Z145', 't1', 'r_VGKXJ8AASB0XE4BMMRW2BVT63C', NULL);
INSERT INTO public.events VALUES (32, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.468Z","op":29,"prev_hash":"d754005545e205ba9720f9fef752c8a71cccfe7b373b8b96e660bf23a3b5bb36","seq":32,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.derived","v":1}', '58c626eb02bcf847ef9dda9850f7518d99468902666191ecbe4da1bb60306f8b', 'write.derived', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.468Z', 29, 'sl_ZSNW59W1GYV3Z145', 't5', NULL, NULL);
INSERT INTO public.events VALUES (33, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.476Z","prev_hash":"58c626eb02bcf847ef9dda9850f7518d99468902666191ecbe4da1bb60306f8b","seq":33,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.head","v":1}', '5c00953607d12f9b1a4f65a8e9a3e723cd9b9e0e7df8a4597dd69aeb7d3e3cbc', 'write.head', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.476Z', 33, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (34, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.476Z","op":33,"prev_hash":"5c00953607d12f9b1a4f65a8e9a3e723cd9b9e0e7df8a4597dd69aeb7d3e3cbc","seq":34,"slot":"sl_ZSNW59W1GYV3Z145","type":"source.recorded","v":1}', 'b719bf6e334e01ed019165d76ce5dbb76313d1577d46a010a30121d2aeac9344', 'source.recorded', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.476Z', 33, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (35, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.476Z","op":33,"prev_hash":"b719bf6e334e01ed019165d76ce5dbb76313d1577d46a010a30121d2aeac9344","seq":35,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.base","v":1}', '0ce0e92fdbc8f0a965ccd48caadb496227fb384535b72e7cc782aad8ae2bd743', 'write.base', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.476Z', 33, 'sl_ZSNW59W1GYV3Z145', 't1', 'r_VGKXJ8AASB0XE4BMMRW2BVT63C', NULL);
INSERT INTO public.events VALUES (36, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.476Z","op":33,"prev_hash":"0ce0e92fdbc8f0a965ccd48caadb496227fb384535b72e7cc782aad8ae2bd743","seq":36,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.derived","v":1}', '00d7867b4a7e0808e28dab28b533e97fd88ff9ccb18937b2610558c97c19ec74', 'write.derived', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.476Z', 33, 'sl_ZSNW59W1GYV3Z145', 't5', NULL, NULL);
INSERT INTO public.events VALUES (37, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.483Z","prev_hash":"00d7867b4a7e0808e28dab28b533e97fd88ff9ccb18937b2610558c97c19ec74","seq":37,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.head","v":1}', '68f79db0db8403efcb6de457eeb3d39094c7e9cada7702bec719914e4844a3e3', 'write.head', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.483Z', 37, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (38, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.483Z","op":37,"prev_hash":"68f79db0db8403efcb6de457eeb3d39094c7e9cada7702bec719914e4844a3e3","seq":38,"slot":"sl_ZSNW59W1GYV3Z145","type":"source.recorded","v":1}', 'e42682a6c2169bf5288ff34f7ead7ca483fc1cb2e2bd03826736d7b168dbb1b2', 'source.recorded', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.483Z', 37, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (39, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.483Z","op":37,"prev_hash":"e42682a6c2169bf5288ff34f7ead7ca483fc1cb2e2bd03826736d7b168dbb1b2","seq":39,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.base","v":1}', '725f9ad4552ae7f0203002fec3731772630452d19c682f425f7ac674d1dfeafa', 'write.base', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.483Z', 37, 'sl_ZSNW59W1GYV3Z145', 't1', 'r_VGKXJ8AASB0XE4BMMRW2BVT63C', NULL);
INSERT INTO public.events VALUES (40, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.483Z","op":37,"prev_hash":"725f9ad4552ae7f0203002fec3731772630452d19c682f425f7ac674d1dfeafa","seq":40,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.derived","v":1}', '54a78e6a7551545e58e466e60b81d5a6abe9628eb61e3b48ebe94488fe6565d6', 'write.derived', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.483Z', 37, 'sl_ZSNW59W1GYV3Z145', 't5', NULL, NULL);
INSERT INTO public.events VALUES (41, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.491Z","prev_hash":"54a78e6a7551545e58e466e60b81d5a6abe9628eb61e3b48ebe94488fe6565d6","seq":41,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.head","v":1}', '1013cb00bbaec1082858dcd16ea911169ba1a3dfce860afaed085bc5e1637caa', 'write.head', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.491Z', 41, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (42, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.491Z","op":41,"prev_hash":"1013cb00bbaec1082858dcd16ea911169ba1a3dfce860afaed085bc5e1637caa","seq":42,"slot":"sl_ZSNW59W1GYV3Z145","type":"source.recorded","v":1}', '452d78b00389ff10a54efd344b038f4e61a1572c2e59fd3423782f63a9284cc0', 'source.recorded', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.491Z', 41, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (43, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.491Z","op":41,"prev_hash":"452d78b00389ff10a54efd344b038f4e61a1572c2e59fd3423782f63a9284cc0","seq":43,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.base","v":1}', '45bd4f23b0968b05c74ea28442bcfcd107d2cb5bb13b4afd13bb33933716996c', 'write.base', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.491Z', 41, 'sl_ZSNW59W1GYV3Z145', 't1', 'r_3WNNNT1AYPQD12JA5XES73SDTZ', NULL);
INSERT INTO public.events VALUES (44, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.491Z","op":41,"prev_hash":"45bd4f23b0968b05c74ea28442bcfcd107d2cb5bb13b4afd13bb33933716996c","seq":44,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.derived","v":1}', '922f88b5f3f6c5f4b54d2c1077ed5a5243116398daa702a67fca40e05152ecb1', 'write.derived', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.491Z', 41, 'sl_ZSNW59W1GYV3Z145', 't5', NULL, NULL);
INSERT INTO public.events VALUES (45, '{"actor":"ci_F63CYN49FCWQBYAZ4TNM60RM86","at":"2026-11-24T13:37:53.500Z","prev_hash":"922f88b5f3f6c5f4b54d2c1077ed5a5243116398daa702a67fca40e05152ecb1","seq":45,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.head","v":1}', '7cc82a73ce3e94ef68c34b63aea25ac082d92586de8773c3f6864d6f7a4df0f3', 'write.head', 'ci_F63CYN49FCWQBYAZ4TNM60RM86', '2026-11-24T13:37:53.500Z', 45, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (46, '{"actor":"ci_F63CYN49FCWQBYAZ4TNM60RM86","at":"2026-11-24T13:37:53.500Z","op":45,"prev_hash":"7cc82a73ce3e94ef68c34b63aea25ac082d92586de8773c3f6864d6f7a4df0f3","seq":46,"slot":"sl_ZSNW59W1GYV3Z145","type":"source.recorded","v":1}', 'dbbeb41dd2561455352b9e10ec2e5ecee86e7dc9fce6d9dc625bfc3aed984ef3', 'source.recorded', 'ci_F63CYN49FCWQBYAZ4TNM60RM86', '2026-11-24T13:37:53.500Z', 45, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (47, '{"actor":"ci_F63CYN49FCWQBYAZ4TNM60RM86","at":"2026-11-24T13:37:53.500Z","op":45,"prev_hash":"dbbeb41dd2561455352b9e10ec2e5ecee86e7dc9fce6d9dc625bfc3aed984ef3","seq":47,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.base","v":1}', 'ca89e1abc16984a4e080fc7d6303a58539009dc0f9343699b458b6cecf278306', 'write.base', 'ci_F63CYN49FCWQBYAZ4TNM60RM86', '2026-11-24T13:37:53.500Z', 45, 'sl_ZSNW59W1GYV3Z145', 't1', 'r_3WNNNT1AYPQD12JA5XES73SDTZ', NULL);
INSERT INTO public.events VALUES (48, '{"actor":"ci_F63CYN49FCWQBYAZ4TNM60RM86","at":"2026-11-24T13:37:53.500Z","op":45,"prev_hash":"ca89e1abc16984a4e080fc7d6303a58539009dc0f9343699b458b6cecf278306","seq":48,"slot":"sl_ZSNW59W1GYV3Z145","type":"item.created","v":1}', '8d3b734ce2348dc8058749b75ae12cd1bcc142b3df2cd71e42eec1d760c22641', 'item.created', 'ci_F63CYN49FCWQBYAZ4TNM60RM86', '2026-11-24T13:37:53.500Z', 45, 'sl_ZSNW59W1GYV3Z145', 't1', 'r_3WNNNT1AYPQD12JA5XES73SDTZ', 47);
INSERT INTO public.events VALUES (49, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.510Z","prev_hash":"8d3b734ce2348dc8058749b75ae12cd1bcc142b3df2cd71e42eec1d760c22641","seq":49,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.head","v":1}', '1b30adcd674dca156212814777fe6bbd4ed987e3b6212ecb9128a5d0a087962d', 'write.head', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.510Z', 49, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (50, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.510Z","op":49,"prev_hash":"1b30adcd674dca156212814777fe6bbd4ed987e3b6212ecb9128a5d0a087962d","seq":50,"slot":"sl_ZSNW59W1GYV3Z145","type":"source.recorded","v":1}', '97659b56937894fd0077575a67ee7e0825db58012dadef6ac256ba1230d1fc1c', 'source.recorded', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.510Z', 49, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (51, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.510Z","op":49,"prev_hash":"97659b56937894fd0077575a67ee7e0825db58012dadef6ac256ba1230d1fc1c","seq":51,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.base","v":1}', '6aa63cb4990190e0ae05d75cfc94cf51a2e561e21356f8b7332ecba9864dc038', 'write.base', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.510Z', 49, 'sl_ZSNW59W1GYV3Z145', 't4', 'r_30WY0P19Q5ZAZXJQS8QEA7Q2FV', NULL);
INSERT INTO public.events VALUES (52, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.518Z","prev_hash":"6aa63cb4990190e0ae05d75cfc94cf51a2e561e21356f8b7332ecba9864dc038","seq":52,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.head","v":1}', '46d6ed9da1f3ecc0ada4be3458936e5140a2265f4cfee584d177c4dc68621608', 'write.head', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.518Z', 52, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (53, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.518Z","op":52,"prev_hash":"46d6ed9da1f3ecc0ada4be3458936e5140a2265f4cfee584d177c4dc68621608","seq":53,"slot":"sl_ZSNW59W1GYV3Z145","type":"source.recorded","v":1}', '4cd746fb5e85ef12d871ba6dea6c80965199325327b78faf4573573e08d423e2', 'source.recorded', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.518Z', 52, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (54, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.518Z","op":52,"prev_hash":"4cd746fb5e85ef12d871ba6dea6c80965199325327b78faf4573573e08d423e2","seq":54,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.base","v":1}', '1aa2e812adee7379f7ee0c22b0b71c292ff6f2016b75ffa12cd76eb5b0eecbfa', 'write.base', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.518Z', 52, 'sl_ZSNW59W1GYV3Z145', 't2', 'e_K9FD9A5G72KJ0YN4110M2X6TZS', NULL);
INSERT INTO public.events VALUES (55, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.526Z","prev_hash":"1aa2e812adee7379f7ee0c22b0b71c292ff6f2016b75ffa12cd76eb5b0eecbfa","seq":55,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.head","v":1}', 'f74d8aa7de34c605369c49718b6af30440590c97967275fe8e4e44c447975b8d', 'write.head', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.526Z', 55, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (56, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.526Z","op":55,"prev_hash":"f74d8aa7de34c605369c49718b6af30440590c97967275fe8e4e44c447975b8d","seq":56,"slot":"sl_ZSNW59W1GYV3Z145","type":"source.recorded","v":1}', '22dde817c4b95eea1b6f2f3b300be808d7ca9e3e7e18b6fa643a71af9bd45ab8', 'source.recorded', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.526Z', 55, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (57, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.526Z","op":55,"prev_hash":"22dde817c4b95eea1b6f2f3b300be808d7ca9e3e7e18b6fa643a71af9bd45ab8","seq":57,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.base","v":1}', 'b3e4656b7c0da7a4a54d79ac6d34633ead16af24c6644b116c4a53bcb09c5b9e', 'write.base', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.526Z', 55, 'sl_ZSNW59W1GYV3Z145', 't2', 'e_K9FD9A5G72KJ0YN4110M2X6TZS', NULL);
INSERT INTO public.events VALUES (58, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.535Z","prev_hash":"b3e4656b7c0da7a4a54d79ac6d34633ead16af24c6644b116c4a53bcb09c5b9e","seq":58,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.head","v":1}', '141769587e1e0ab5c7a87e0c9b53ad7a488e24c80571ea27456af0bc4d814699', 'write.head', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.535Z', 58, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (59, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.535Z","op":58,"prev_hash":"141769587e1e0ab5c7a87e0c9b53ad7a488e24c80571ea27456af0bc4d814699","seq":59,"slot":"sl_ZSNW59W1GYV3Z145","type":"source.recorded","v":1}', 'b0397c29a60c34536f7e8c5147956e0bed652333b02ea043e1dd1676092a7957', 'source.recorded', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.535Z', 58, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (60, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.535Z","op":58,"prev_hash":"b0397c29a60c34536f7e8c5147956e0bed652333b02ea043e1dd1676092a7957","seq":60,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.base","v":1}', '988a79f3f77de999ed6bc4a0beb42643eedc220661057e748bc2aea21daff3b2', 'write.base', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.535Z', 58, 'sl_ZSNW59W1GYV3Z145', 't2', 'e_K9FD9A5G72KJ0YN4110M2X6TZS', NULL);
INSERT INTO public.events VALUES (61, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.535Z","op":58,"prev_hash":"988a79f3f77de999ed6bc4a0beb42643eedc220661057e748bc2aea21daff3b2","seq":61,"slot":"sl_ZSNW59W1GYV3Z145","type":"item.created","v":1}', '1cd4ed090ea41c310c316c8ea76c1c5d27b08489a6995501b2c7382b70558c0b', 'item.created', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.535Z', 58, 'sl_ZSNW59W1GYV3Z145', 't2', 'e_K9FD9A5G72KJ0YN4110M2X6TZS', 60);
INSERT INTO public.events VALUES (62, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.546Z","prev_hash":"1cd4ed090ea41c310c316c8ea76c1c5d27b08489a6995501b2c7382b70558c0b","seq":62,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.head","v":1}', '4790f0a2fafe46c01694bda22f09392ff0b4d145c92210fc13867a75461c6295', 'write.head', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.546Z', 62, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (63, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.546Z","op":62,"prev_hash":"4790f0a2fafe46c01694bda22f09392ff0b4d145c92210fc13867a75461c6295","seq":63,"slot":"sl_ZSNW59W1GYV3Z145","type":"source.recorded","v":1}', '286624c5a8019c8e3089db6afffb45a795ec019c6ed0b25004dda559d42d7c17', 'source.recorded', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.546Z', 62, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (64, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.546Z","op":62,"prev_hash":"286624c5a8019c8e3089db6afffb45a795ec019c6ed0b25004dda559d42d7c17","seq":64,"slot":"sl_ZSNW59W1GYV3Z145","type":"source.recorded","v":1}', '6e2b16d97ba535f6f23f70c4b05f5d38dc0c047cea47eec9a2250edad63b6e35', 'source.recorded', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.546Z', 62, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (65, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.546Z","op":62,"prev_hash":"6e2b16d97ba535f6f23f70c4b05f5d38dc0c047cea47eec9a2250edad63b6e35","seq":65,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.base","v":1}', 'e5996f5c2a9af79595ebfa51b046564a024d7b775e024b0e4f2d3ecd43ee1dfd', 'write.base', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.546Z', 62, 'sl_ZSNW59W1GYV3Z145', 't3', 'r_2XDJE12PK0TSR0ZAVBMKW1B8WB', NULL);
INSERT INTO public.events VALUES (66, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.546Z","op":62,"prev_hash":"e5996f5c2a9af79595ebfa51b046564a024d7b775e024b0e4f2d3ecd43ee1dfd","seq":66,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.base","v":1}', '48da0d905a1d11cbd83d69f1f70eaa194ac1ed996eb1f94765b799978aae7eba', 'write.base', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.546Z', 62, 'sl_ZSNW59W1GYV3Z145', 't3', 'r_7T9F8XC601XXQBZ8R6JK0QATGN', NULL);
INSERT INTO public.events VALUES (67, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.554Z","prev_hash":"48da0d905a1d11cbd83d69f1f70eaa194ac1ed996eb1f94765b799978aae7eba","seq":67,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.head","v":1}', 'ab38bbb20e153d61854bf932a7f41dd5fc0d4c316b2e74151291076bf21bd4de', 'write.head', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.554Z', 67, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (68, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.554Z","op":67,"prev_hash":"ab38bbb20e153d61854bf932a7f41dd5fc0d4c316b2e74151291076bf21bd4de","seq":68,"slot":"sl_ZSNW59W1GYV3Z145","type":"source.recorded","v":1}', '32a7560a3dae626a251d01d926519afa2e0759fa864155f1e8231ab227335897', 'source.recorded', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.554Z', 67, 'sl_ZSNW59W1GYV3Z145', NULL, NULL, NULL);
INSERT INTO public.events VALUES (69, '{"actor":"ci_N02SN6P86V8WERP82PW08Y7K2B","at":"2026-11-24T13:37:53.554Z","op":67,"prev_hash":"32a7560a3dae626a251d01d926519afa2e0759fa864155f1e8231ab227335897","seq":69,"slot":"sl_ZSNW59W1GYV3Z145","type":"write.base","v":1}', '97dd508aefb8e0f814302f2c82e32b02a0f0d450a9ff1bafdb1932cb3d1f6df5', 'write.base', 'ci_N02SN6P86V8WERP82PW08Y7K2B', '2026-11-24T13:37:53.554Z', 67, 'sl_ZSNW59W1GYV3Z145', 't3', 'r_2XDJE12PK0TSR0ZAVBMKW1B8WB', NULL);


--
-- Data for Name: external_keys; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.external_keys VALUES ('t3', '["app","k-1"]', 'r_2XDJE12PK0TSR0ZAVBMKW1B8WB', NULL, 'present', NULL);
INSERT INTO public.external_keys VALUES ('t3', '["app","k-2"]', 'r_7T9F8XC601XXQBZ8R6JK0QATGN', NULL, 'present', NULL);


--
-- Data for Name: field_name_usage; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: flags; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.flags VALUES ('t1', 'r_3WNNNT1AYPQD12JA5XES73SDTZ', 'disputed', 'pi_NST6T1JK0C0T4R94', '["f2"]', NULL);
INSERT INTO public.flags VALUES ('t2', 'e_K9FD9A5G72KJ0YN4110M2X6TZS', 'awaiting', 'pi_14N09C7KYY8ZFFKJ', '["f2"]', '[{"from":"2026-10-15"}]');


--
-- Data for Name: last_read; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.last_read VALUES ('ci_N02SN6P86V8WERP82PW08Y7K2B', '', 'r_VGKXJ8AASB0XE4BMMRW2BVT63C', 'ver', 37, 0, 'rd_8VWFZ797MTHC5R0K');
INSERT INTO public.last_read VALUES ('ci_N02SN6P86V8WERP82PW08Y7K2B', '', 'r_3WNNNT1AYPQD12JA5XES73SDTZ', 'ver', 41, 0, 'rd_8VWFZ797MTHC5R0K');
INSERT INTO public.last_read VALUES ('ci_N02SN6P86V8WERP82PW08Y7K2B', '', 'r_XDTMQRPMBQXRDFX4YKSEW79FBN', 'ver', 21, 0, 'rd_8VWFZ797MTHC5R0K');
INSERT INTO public.last_read VALUES ('ci_N02SN6P86V8WERP82PW08Y7K2B', '', 'e_K9FD9A5G72KJ0YN4110M2X6TZS', 'ver', 55, 0, 'rd_5HRH4H9DRS3DFJKV');
INSERT INTO public.last_read VALUES ('ci_N02SN6P86V8WERP82PW08Y7K2B', '', 'r_2XDJE12PK0TSR0ZAVBMKW1B8WB', 'ver', 67, 0, 'rd_WEXY534NWHF8KPGS');
INSERT INTO public.last_read VALUES ('ci_N02SN6P86V8WERP82PW08Y7K2B', '', 'r_7T9F8XC601XXQBZ8R6JK0QATGN', 'ver', 62, 0, 'rd_WEXY534NWHF8KPGS');
INSERT INTO public.last_read VALUES ('ci_N02SN6P86V8WERP82PW08Y7K2B', '', 'r_30WY0P19Q5ZAZXJQS8QEA7Q2FV', 'ver', 49, 0, 'rd_QZ5X6RXKKZNMNPFS');
INSERT INTO public.last_read VALUES ('ci_N02SN6P86V8WERP82PW08Y7K2B', '', 'sl_ZSNW59W1GYV3Z145', 'sv', 1, 0, 'rd_0718F304VN4EZWPP');
INSERT INTO public.last_read VALUES ('ci_F63CYN49FCWQBYAZ4TNM60RM86', '', 'r_XDTMQRPMBQXRDFX4YKSEW79FBN', 'ver', 21, 0, 'rd_K3GS9B0F2B1V0BDQ');
INSERT INTO public.last_read VALUES ('ci_F63CYN49FCWQBYAZ4TNM60RM86', '', 'sl_ZSNW59W1GYV3Z145', 'sv', 1, 0, 'rd_K3GS9B0F2B1V0BDQ');
INSERT INTO public.last_read VALUES ('u_DZEESWD7AKV5KWM10SWNFK03W4', '', 'r_VGKXJ8AASB0XE4BMMRW2BVT63C', 'ver', 37, 0, 'rd_EB697C2VEE0E5Z9X');
INSERT INTO public.last_read VALUES ('u_DZEESWD7AKV5KWM10SWNFK03W4', '', 'r_3WNNNT1AYPQD12JA5XES73SDTZ', 'ver', 41, 0, 'rd_EB697C2VEE0E5Z9X');
INSERT INTO public.last_read VALUES ('u_DZEESWD7AKV5KWM10SWNFK03W4', '', 'r_XDTMQRPMBQXRDFX4YKSEW79FBN', 'ver', 21, 0, 'rd_EB697C2VEE0E5Z9X');
INSERT INTO public.last_read VALUES ('u_DZEESWD7AKV5KWM10SWNFK03W4', '', 'r_2XDJE12PK0TSR0ZAVBMKW1B8WB', 'ver', 67, 0, 'rd_4MF59V2QNRPYWSA9');
INSERT INTO public.last_read VALUES ('u_DZEESWD7AKV5KWM10SWNFK03W4', '', 'r_7T9F8XC601XXQBZ8R6JK0QATGN', 'ver', 62, 0, 'rd_4MF59V2QNRPYWSA9');
INSERT INTO public.last_read VALUES ('u_DZEESWD7AKV5KWM10SWNFK03W4', '', 'e_K9FD9A5G72KJ0YN4110M2X6TZS', 'ver', 55, 0, 'rd_1F3G9ABY96PAWP4W');
INSERT INTO public.last_read VALUES ('u_DZEESWD7AKV5KWM10SWNFK03W4', '', 'sl_ZSNW59W1GYV3Z145', 'sv', 1, 0, 'rd_1F3G9ABY96PAWP4W');


--
-- Data for Name: meta; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.meta VALUES ('storage_format', '5');
INSERT INTO public.meta VALUES ('session_settings', '["SET client_encoding = ''UTF8''","SET TIME ZONE ''UTC''","SET datestyle = ''ISO, YMD''","SET intervalstyle = ''iso_8601''","SET extra_float_digits = 3","SET standard_conforming_strings = on"]');
INSERT INTO public.meta VALUES ('tenant_id', 'tn_4G0R6JP6QVJW4Z5GD9QYTCYWMR');
INSERT INTO public.meta VALUES ('ownership_epoch', '2');


--
-- Data for Name: migrations; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: partitions; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.partitions VALUES ('t5', 'p_A5SQ54P3C5RE0X27', '["2026-11-02"]');
INSERT INTO public.partitions VALUES ('t5', 'p_K55ESCGAGVWWQ6JR', '["2026-11-03"]');
INSERT INTO public.partitions VALUES ('t5', 'p_TTSA5Z91JXSVFYZ6', '["2026-11-04"]');


--
-- Data for Name: pending_blocks; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: pending_entries; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.pending_entries VALUES ('pi_NST6T1JK0C0T4R94', 0, 48, 'candidates/0');
INSERT INTO public.pending_entries VALUES ('pi_NST6T1JK0C0T4R94', 1, 48, 'current/0');
INSERT INTO public.pending_entries VALUES ('pi_NST6T1JK0C0T4R94', 2, 48, 'impact/0');
INSERT INTO public.pending_entries VALUES ('pi_NST6T1JK0C0T4R94', 3, 48, 'previous/0');
INSERT INTO public.pending_entries VALUES ('pi_14N09C7KYY8ZFFKJ', 0, 61, 'current/0');
INSERT INTO public.pending_entries VALUES ('pi_14N09C7KYY8ZFFKJ', 1, 61, 'current/1');
INSERT INTO public.pending_entries VALUES ('pi_14N09C7KYY8ZFFKJ', 2, 61, 'impact/0');
INSERT INTO public.pending_entries VALUES ('pi_14N09C7KYY8ZFFKJ', 3, 61, 'impact/1');
INSERT INTO public.pending_entries VALUES ('pi_14N09C7KYY8ZFFKJ', 4, 61, 'proposed/0');
INSERT INTO public.pending_entries VALUES ('pi_14N09C7KYY8ZFFKJ', 5, 61, 'scope_valid');


--
-- Data for Name: pending_items; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.pending_items VALUES ('pi_NST6T1JK0C0T4R94', 'conflict', 'sl_ZSNW59W1GYV3Z145', 't1', 'r_3WNNNT1AYPQD12JA5XES73SDTZ', 'open', NULL, 45);
INSERT INTO public.pending_items VALUES ('pi_14N09C7KYY8ZFFKJ', 'awaiting_confirmation', 'sl_ZSNW59W1GYV3Z145', 't2', 'e_K9FD9A5G72KJ0YN4110M2X6TZS', 'open', NULL, 58);


--
-- Data for Name: possibly_affected; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: premise_decls; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.premise_decls VALUES (49, 0, 0, 't4', 'r_30WY0P19Q5ZAZXJQS8QEA7Q2FV', 't1', 'r_XDTMQRPMBQXRDFX4YKSEW79FBN', '["f2"]', 'whole', NULL, 21, 0, 'current', NULL, NULL, 'ci_N02SN6P86V8WERP82PW08Y7K2B');


--
-- Data for Name: premise_edges; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.premise_edges VALUES (51, 'f1', 0, 'r_XDTMQRPMBQXRDFX4YKSEW79FBN', 49, 0, 0);
INSERT INTO public.premise_edges VALUES (51, 'f2', 0, 'r_XDTMQRPMBQXRDFX4YKSEW79FBN', 49, 0, 0);


--
-- Data for Name: principals; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.principals VALUES ('u_DZEESWD7AKV5KWM10SWNFK03W4', 'user', NULL, NULL, NULL, NULL, NULL, 'active', 1);
INSERT INTO public.principals VALUES ('system', 'system', NULL, NULL, NULL, NULL, NULL, 'active', 1);
INSERT INTO public.principals VALUES ('ci_N02SN6P86V8WERP82PW08Y7K2B', 'connection', 'sample agent', '["saveslot.read","saveslot.write","saveslot.schema"]', NULL, 'token', NULL, 'active', 7);
INSERT INTO public.principals VALUES ('ci_F63CYN49FCWQBYAZ4TNM60RM86', 'connection', 'another agent', '["saveslot.read","saveslot.write","saveslot.schema"]', NULL, 'token', NULL, 'active', 8);


--
-- Data for Name: read_log; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_8VWFZ797MTHC5R0K', 1, 'ci_N02SN6P86V8WERP82PW08Y7K2B', NULL, '2026-11-24T13:37:53.560Z', 67, 'query', false, false, 'sl_ZSNW59W1GYV3Z145', 1, 't1', '{"fields":["f1","f2","f3"],"order":[],"page":false,"table":"t1","time":"none","where":[]}', NULL, NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_5HRH4H9DRS3DFJKV', 2, 'ci_N02SN6P86V8WERP82PW08Y7K2B', NULL, '2026-11-24T13:37:53.566Z', 67, 'query', false, false, 'sl_ZSNW59W1GYV3Z145', 1, 't2', '{"fields":["f1","f2"],"order":[],"page":false,"table":"t2","time":"none","where":[]}', '{"at":"2026-11-24"}', NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_WEXY534NWHF8KPGS', 3, 'ci_N02SN6P86V8WERP82PW08Y7K2B', NULL, '2026-11-24T13:37:53.569Z', 67, 'query', false, false, 'sl_ZSNW59W1GYV3Z145', 1, 't3', '{"fields":["f1","f2","f3"],"order":[],"page":false,"table":"t3","time":"none","where":[]}', NULL, NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_QZ5X6RXKKZNMNPFS', 4, 'ci_N02SN6P86V8WERP82PW08Y7K2B', NULL, '2026-11-24T13:37:53.573Z', 67, 'query', false, false, 'sl_ZSNW59W1GYV3Z145', 1, 't4', '{"fields":["f1","f2"],"order":[],"page":false,"table":"t4","time":"none","where":[]}', NULL, NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_0718F304VN4EZWPP', 5, 'ci_N02SN6P86V8WERP82PW08Y7K2B', NULL, '2026-11-24T13:37:53.576Z', 67, 'query', false, false, 'sl_ZSNW59W1GYV3Z145', 1, 't5', '{"fields":["f1","f2","f3"],"order":[],"page":false,"table":"t5","time":"none","where":[]}', NULL, NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_K3GS9B0F2B1V0BDQ', 6, 'ci_F63CYN49FCWQBYAZ4TNM60RM86', NULL, '2026-11-24T13:37:53.580Z', 67, 'history', false, false, 'sl_ZSNW59W1GYV3Z145', 1, 't1', '{"mode":"timeline","table":"t1","target":"r_XDTMQRPMBQXRDFX4YKSEW79FBN"}', NULL, NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_EB697C2VEE0E5Z9X', 7, 'u_DZEESWD7AKV5KWM10SWNFK03W4', NULL, '2026-11-24T13:37:53.585Z', 67, 'query', false, false, 'sl_ZSNW59W1GYV3Z145', 1, 't1', '{"fields":["f1","f2","f3"],"order":[],"page":false,"table":"t1","time":"none","where":[]}', NULL, NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_4MF59V2QNRPYWSA9', 8, 'u_DZEESWD7AKV5KWM10SWNFK03W4', NULL, '2026-11-24T13:37:53.589Z', 67, 'query', false, false, 'sl_ZSNW59W1GYV3Z145', 1, 't3', '{"fields":["f1","f2","f3"],"order":[],"page":false,"table":"t3","time":"none","where":[]}', NULL, NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_JYW67FZK02STMASR', 9, 'u_DZEESWD7AKV5KWM10SWNFK03W4', NULL, '2026-11-24T13:37:53.591Z', 67, 'query', false, false, 'sl_ZSNW59W1GYV3Z145', 1, 't2', '{"fields":["f1","f2"],"order":[],"page":false,"table":"t2","time":"at","where":[]}', '{"at":"2026-10-05"}', NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_1F3G9ABY96PAWP4W', 10, 'u_DZEESWD7AKV5KWM10SWNFK03W4', NULL, '2026-11-24T13:37:53.595Z', 67, 'query', false, false, 'sl_ZSNW59W1GYV3Z145', 1, 't2', '{"fields":["f1","f2"],"order":[],"page":false,"table":"t2","time":"at","where":[]}', '{"at":"2026-11-15"}', NULL, NULL, NULL);
INSERT INTO public.read_log OVERRIDING SYSTEM VALUE VALUES ('rd_6FH9AF57EAZYDEJY', 11, 'u_DZEESWD7AKV5KWM10SWNFK03W4', NULL, '2026-11-24T13:37:53.598Z', 67, 'pending', false, false, NULL, NULL, NULL, '{"list":true,"slot":null,"status":"open","type":null}', NULL, NULL, NULL, NULL);


--
-- Data for Name: read_log_rows; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.read_log_rows VALUES ('rd_8VWFZ797MTHC5R0K', 0, 't1', 'r_VGKXJ8AASB0XE4BMMRW2BVT63C', 37, 0);
INSERT INTO public.read_log_rows VALUES ('rd_8VWFZ797MTHC5R0K', 1, 't1', 'r_3WNNNT1AYPQD12JA5XES73SDTZ', 41, 0);
INSERT INTO public.read_log_rows VALUES ('rd_8VWFZ797MTHC5R0K', 2, 't1', 'r_XDTMQRPMBQXRDFX4YKSEW79FBN', 21, 0);
INSERT INTO public.read_log_rows VALUES ('rd_5HRH4H9DRS3DFJKV', 0, 't2', 'e_K9FD9A5G72KJ0YN4110M2X6TZS', 55, 0);
INSERT INTO public.read_log_rows VALUES ('rd_WEXY534NWHF8KPGS', 0, 't3', 'r_2XDJE12PK0TSR0ZAVBMKW1B8WB', 67, 0);
INSERT INTO public.read_log_rows VALUES ('rd_WEXY534NWHF8KPGS', 1, 't3', 'r_7T9F8XC601XXQBZ8R6JK0QATGN', 62, 0);
INSERT INTO public.read_log_rows VALUES ('rd_QZ5X6RXKKZNMNPFS', 0, 't4', 'r_30WY0P19Q5ZAZXJQS8QEA7Q2FV', 49, 0);
INSERT INTO public.read_log_rows VALUES ('rd_0718F304VN4EZWPP', 0, 't5', 'p_A5SQ54P3C5RE0X27', 41, 0);
INSERT INTO public.read_log_rows VALUES ('rd_0718F304VN4EZWPP', 1, 't5', 'p_TTSA5Z91JXSVFYZ6', 37, 0);
INSERT INTO public.read_log_rows VALUES ('rd_K3GS9B0F2B1V0BDQ', 0, 't1', 'r_XDTMQRPMBQXRDFX4YKSEW79FBN', 21, 0);
INSERT INTO public.read_log_rows VALUES ('rd_EB697C2VEE0E5Z9X', 0, 't1', 'r_VGKXJ8AASB0XE4BMMRW2BVT63C', 37, 0);
INSERT INTO public.read_log_rows VALUES ('rd_EB697C2VEE0E5Z9X', 1, 't1', 'r_3WNNNT1AYPQD12JA5XES73SDTZ', 41, 0);
INSERT INTO public.read_log_rows VALUES ('rd_EB697C2VEE0E5Z9X', 2, 't1', 'r_XDTMQRPMBQXRDFX4YKSEW79FBN', 21, 0);
INSERT INTO public.read_log_rows VALUES ('rd_4MF59V2QNRPYWSA9', 0, 't3', 'r_2XDJE12PK0TSR0ZAVBMKW1B8WB', 67, 0);
INSERT INTO public.read_log_rows VALUES ('rd_4MF59V2QNRPYWSA9', 1, 't3', 'r_7T9F8XC601XXQBZ8R6JK0QATGN', 62, 0);
INSERT INTO public.read_log_rows VALUES ('rd_JYW67FZK02STMASR', 0, 't2', 'e_K9FD9A5G72KJ0YN4110M2X6TZS', 55, 0);
INSERT INTO public.read_log_rows VALUES ('rd_1F3G9ABY96PAWP4W', 0, 't2', 'e_K9FD9A5G72KJ0YN4110M2X6TZS', 55, 0);


--
-- Data for Name: request_keys; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.request_keys VALUES ('d4f8012e1a2baed073b8fa93608bb803865079cd713e0aaff2b44423c4e5abf4', 2, '2026-11-24T13:37:53.346Z', NULL);
INSERT INTO public.request_keys VALUES ('533c72928b69421e7167740f0aa37681ede29759254366279d2d7b9b31dd2fa1', 9, '2026-11-24T13:37:53.400Z', NULL);
INSERT INTO public.request_keys VALUES ('3718e9dc61f358acf92c0c5cf8892fee046dd1d8557e6cdc856634228d174357', 13, '2026-11-24T13:37:53.426Z', NULL);
INSERT INTO public.request_keys VALUES ('283daf2df3d24e352997699891067dc933fb75dd19b7653888932863ea2b4b6b', 17, '2026-11-24T13:37:53.438Z', NULL);
INSERT INTO public.request_keys VALUES ('12a9369030808c7fe7a6f53e6167f7bb396e0a5d454ceb74c7a0fe5ac8ab1efb', 21, '2026-11-24T13:37:53.448Z', NULL);
INSERT INTO public.request_keys VALUES ('ef71d897a56c3e385824bb13d28eab0e102d68b241b6029c56b13f5a90f87982', 25, '2026-11-24T13:37:53.458Z', NULL);
INSERT INTO public.request_keys VALUES ('de65f290dffe64ba64a0a2582a69f8690edc8e4fb827127677ab18a0f7311e7c', 29, '2026-11-24T13:37:53.468Z', NULL);
INSERT INTO public.request_keys VALUES ('e694aa92a0ab08efc9333e17e3c8541effcc692750781565e1e700adeb9e55de', 33, '2026-11-24T13:37:53.476Z', NULL);
INSERT INTO public.request_keys VALUES ('9cda96a77fedcecee1b9d8e8eac0fcd29f228e47f4b175846db87befe9b1430b', 37, '2026-11-24T13:37:53.483Z', NULL);
INSERT INTO public.request_keys VALUES ('91d85e1a49a33e5d5aa4be268047dfb26860a71abed87e6005955d4c4c8a7355', 41, '2026-11-24T13:37:53.491Z', NULL);
INSERT INTO public.request_keys VALUES ('0404c5aeed91b6b70a4972c8c1b30cb7e50c75e7a1ba7ab19c7de8ca230c2c5b', 45, '2026-11-24T13:37:53.500Z', NULL);
INSERT INTO public.request_keys VALUES ('552f12803ad72c535f6cd96e92974d5e69c6ac494da113696778e1c29a994b47', 49, '2026-11-24T13:37:53.510Z', NULL);
INSERT INTO public.request_keys VALUES ('440a6795e4528cb6448e2cd5c752cca30b9717779aee8681e10089d7631a595b', 52, '2026-11-24T13:37:53.518Z', NULL);
INSERT INTO public.request_keys VALUES ('c921c1a0df9830ef4d337621223789c5d60c4d29a887c1a37572c359fc1ff18d', 55, '2026-11-24T13:37:53.526Z', NULL);
INSERT INTO public.request_keys VALUES ('1deb79c4da93d5e6f2a427e3e90274b33588ce385836916aca9e2d7e7a4564bf', 58, '2026-11-24T13:37:53.535Z', NULL);


--
-- Data for Name: residue_progress; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: row_origins; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.row_origins VALUES ('r_XDTMQRPMBQXRDFX4YKSEW79FBN', 't1', 11);
INSERT INTO public.row_origins VALUES ('r_3WNNNT1AYPQD12JA5XES73SDTZ', 't1', 15);
INSERT INTO public.row_origins VALUES ('r_7VVDMS5EX7H3XTBGA7N45G8HKN', 't1', 19);
INSERT INTO public.row_origins VALUES ('r_VGKXJ8AASB0XE4BMMRW2BVT63C', 't1', 31);
INSERT INTO public.row_origins VALUES ('r_30WY0P19Q5ZAZXJQS8QEA7Q2FV', 't4', 51);
INSERT INTO public.row_origins VALUES ('e_K9FD9A5G72KJ0YN4110M2X6TZS', 't2', 54);
INSERT INTO public.row_origins VALUES ('r_2XDJE12PK0TSR0ZAVBMKW1B8WB', 't3', 65);
INSERT INTO public.row_origins VALUES ('r_7T9F8XC601XXQBZ8R6JK0QATGN', 't3', 66);


--
-- Data for Name: schema_versions; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.schema_versions VALUES ('sl_ZSNW59W1GYV3Z145', 1, 3, 'd_4ZM3CMFAPP78YBCA', 6, 'current');


--
-- Data for Name: slots; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.slots VALUES ('sl_ZSNW59W1GYV3Z145', 'household', 'Asia/Shanghai', 1, 5, 1);


--
-- Data for Name: sources; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.sources VALUES (10, 's_M4TAQ0HM03N4YS29', 'user_message', 'user_stated', 'sl_ZSNW59W1GYV3Z145', 'present');
INSERT INTO public.sources VALUES (14, 's_GN7H33E479H4S7TD', 'api_call', 'agent_inferred', 'sl_ZSNW59W1GYV3Z145', 'present');
INSERT INTO public.sources VALUES (18, 's_G1X808GWSQYW2D6A', 'api_call', 'agent_inferred', 'sl_ZSNW59W1GYV3Z145', 'present');
INSERT INTO public.sources VALUES (22, 's_PBGBE7ENT7YWRB2F', 'user_message', 'user_stated', 'sl_ZSNW59W1GYV3Z145', 'present');
INSERT INTO public.sources VALUES (26, 's_Q5WN7NW596318BZ8', 'api_call', 'agent_inferred', 'sl_ZSNW59W1GYV3Z145', 'present');
INSERT INTO public.sources VALUES (30, 's_KCZ4F3K56FN7MQ40', 'api_call', 'agent_inferred', 'sl_ZSNW59W1GYV3Z145', 'present');
INSERT INTO public.sources VALUES (34, 's_BK52B25AWY239VBC', 'api_call', 'agent_inferred', 'sl_ZSNW59W1GYV3Z145', 'present');
INSERT INTO public.sources VALUES (38, 's_A8VM83M6CN8SDK4Y', 'api_call', 'agent_inferred', 'sl_ZSNW59W1GYV3Z145', 'present');
INSERT INTO public.sources VALUES (42, 's_ANXW111R106W7AWT', 'api_call', 'agent_inferred', 'sl_ZSNW59W1GYV3Z145', 'present');
INSERT INTO public.sources VALUES (46, 's_D9DPG81HXZ154H83', 'api_call', 'agent_inferred', 'sl_ZSNW59W1GYV3Z145', 'present');
INSERT INTO public.sources VALUES (50, 's_GJX302ZRSJP5YDV2', 'api_call', 'agent_inferred', 'sl_ZSNW59W1GYV3Z145', 'present');
INSERT INTO public.sources VALUES (53, 's_XE72K34K5P4EZGJ2', 'api_call', 'agent_inferred', 'sl_ZSNW59W1GYV3Z145', 'present');
INSERT INTO public.sources VALUES (56, 's_ETYK7XAN5APB5GR1', 'api_call', 'agent_inferred', 'sl_ZSNW59W1GYV3Z145', 'present');
INSERT INTO public.sources VALUES (59, 's_0BC9M2HQ16GH9VCY', 'api_call', 'agent_inferred', 'sl_ZSNW59W1GYV3Z145', 'present');
INSERT INTO public.sources VALUES (63, 's_YJCCHD1JGNT8QBBM', 'api_call', 'agent_inferred', 'sl_ZSNW59W1GYV3Z145', 'present');
INSERT INTO public.sources VALUES (64, 's_KMYYHT7K362DJ731', 'api_call', 'agent_inferred', 'sl_ZSNW59W1GYV3Z145', 'present');
INSERT INTO public.sources VALUES (68, 's_SQGJE48NG51WTZS1', 'api_call', 'agent_inferred', 'sl_ZSNW59W1GYV3Z145', 'present');


--
-- Data for Name: t_t1_v1; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.t_t1_v1 VALUES ('r_XDTMQRPMBQXRDFX4YKSEW79FBN', false, '2026-11-02', 54, 'lunch');
INSERT INTO public.t_t1_v1 VALUES ('r_7VVDMS5EX7H3XTBGA7N45G8HKN', true, '2026-11-03', 18, 'coffee');
INSERT INTO public.t_t1_v1 VALUES ('r_VGKXJ8AASB0XE4BMMRW2BVT63C', false, '2026-11-04', 9, 'snack');
INSERT INTO public.t_t1_v1 VALUES ('r_3WNNNT1AYPQD12JA5XES73SDTZ', false, '2026-11-02', 32, 'taxi');


--
-- Data for Name: t_t1_v1__ver; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.t_t1_v1__ver VALUES ('r_XDTMQRPMBQXRDFX4YKSEW79FBN', 'f1', 9, NULL, 'insert', 11, 'f1', 0, NULL, NULL, '2026-11-02', NULL, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_XDTMQRPMBQXRDFX4YKSEW79FBN', 'f3', 9, NULL, 'insert', 11, 'f3', 0, NULL, NULL, NULL, NULL, 'lunch');
INSERT INTO public.t_t1_v1__ver VALUES ('r_3WNNNT1AYPQD12JA5XES73SDTZ', 'f1', 13, NULL, 'insert', 15, 'f1', 0, NULL, NULL, '2026-11-02', NULL, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_3WNNNT1AYPQD12JA5XES73SDTZ', 'f3', 13, NULL, 'insert', 15, 'f3', 0, NULL, NULL, NULL, NULL, 'taxi');
INSERT INTO public.t_t1_v1__ver VALUES ('r_7VVDMS5EX7H3XTBGA7N45G8HKN', 'f1', 17, NULL, 'insert', 19, 'f1', 0, NULL, NULL, '2026-11-03', NULL, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_7VVDMS5EX7H3XTBGA7N45G8HKN', 'f2', 17, NULL, 'insert', 19, 'f2', 0, NULL, NULL, NULL, 18, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_7VVDMS5EX7H3XTBGA7N45G8HKN', 'f3', 17, NULL, 'insert', 19, 'f3', 0, NULL, NULL, NULL, NULL, 'coffee');
INSERT INTO public.t_t1_v1__ver VALUES ('r_XDTMQRPMBQXRDFX4YKSEW79FBN', 'f2', 9, 21, 'insert', 11, 'f2', 0, NULL, NULL, NULL, 45, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_XDTMQRPMBQXRDFX4YKSEW79FBN', 'f2', 21, NULL, 'correct', 23, 'f2', 0, NULL, NULL, NULL, 54, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_7VVDMS5EX7H3XTBGA7N45G8HKN', 'existence', 25, NULL, 'revoke', 27, 'existence', 0, true, NULL, NULL, NULL, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_VGKXJ8AASB0XE4BMMRW2BVT63C', 'f1', 29, NULL, 'insert', 31, 'f1', 0, NULL, NULL, '2026-11-04', NULL, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_VGKXJ8AASB0XE4BMMRW2BVT63C', 'f2', 29, NULL, 'insert', 31, 'f2', 0, NULL, NULL, NULL, 9, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_VGKXJ8AASB0XE4BMMRW2BVT63C', 'f3', 29, NULL, 'insert', 31, 'f3', 0, NULL, NULL, NULL, NULL, 'snack');
INSERT INTO public.t_t1_v1__ver VALUES ('r_VGKXJ8AASB0XE4BMMRW2BVT63C', 'existence', 33, 37, 'revoke', 35, 'existence', 0, true, NULL, NULL, NULL, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_VGKXJ8AASB0XE4BMMRW2BVT63C', 'existence', 37, NULL, 'revoke', 39, 'existence', 0, NULL, NULL, NULL, NULL, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_3WNNNT1AYPQD12JA5XES73SDTZ', 'f2', 13, 41, 'insert', 15, 'f2', 0, NULL, NULL, NULL, 30, NULL);
INSERT INTO public.t_t1_v1__ver VALUES ('r_3WNNNT1AYPQD12JA5XES73SDTZ', 'f2', 41, NULL, 'update', 43, 'f2', 0, NULL, NULL, NULL, 32, NULL);


--
-- Data for Name: t_t2_v1; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.t_t2_v1 VALUES ('e_K9FD9A5G72KJ0YN4110M2X6TZS', '2026-10-01', '2026-11-10', 'food', 5000);
INSERT INTO public.t_t2_v1 VALUES ('e_K9FD9A5G72KJ0YN4110M2X6TZS', '2026-11-10', NULL, 'food', 4000);


--
-- Data for Name: t_t2_v1__ver; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.t_t2_v1__ver VALUES ('e_K9FD9A5G72KJ0YN4110M2X6TZS', 'f1', '2026-10-01', NULL, 52, NULL, 'update', 54, 'f1', 0, NULL, NULL, 'food', NULL);
INSERT INTO public.t_t2_v1__ver VALUES ('e_K9FD9A5G72KJ0YN4110M2X6TZS', 'f2', '2026-10-01', NULL, 52, 55, 'update', 54, 'f2', 0, NULL, NULL, NULL, 5000);
INSERT INTO public.t_t2_v1__ver VALUES ('e_K9FD9A5G72KJ0YN4110M2X6TZS', 'f2', '2026-10-01', '2026-11-10', 55, NULL, 'update', 54, 'f2', 0, NULL, NULL, NULL, 5000);
INSERT INTO public.t_t2_v1__ver VALUES ('e_K9FD9A5G72KJ0YN4110M2X6TZS', 'f2', '2026-11-10', NULL, 55, NULL, 'update', 57, 'f2', 0, NULL, NULL, NULL, 4000);


--
-- Data for Name: t_t3_v1; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.t_t3_v1 VALUES ('r_7T9F8XC601XXQBZ8R6JK0QATGN', false, 'app', 'k-2', 21);
INSERT INTO public.t_t3_v1 VALUES ('r_2XDJE12PK0TSR0ZAVBMKW1B8WB', false, 'app', 'k-1', 12);


--
-- Data for Name: t_t3_v1__ver; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.t_t3_v1__ver VALUES ('r_2XDJE12PK0TSR0ZAVBMKW1B8WB', 'f1', 62, NULL, 'update', 65, 'f1', 0, NULL, NULL, 'app', NULL, NULL);
INSERT INTO public.t_t3_v1__ver VALUES ('r_2XDJE12PK0TSR0ZAVBMKW1B8WB', 'f2', 62, NULL, 'update', 65, 'f2', 0, NULL, NULL, NULL, 'k-1', NULL);
INSERT INTO public.t_t3_v1__ver VALUES ('r_7T9F8XC601XXQBZ8R6JK0QATGN', 'f1', 62, NULL, 'update', 66, 'f1', 0, NULL, NULL, 'app', NULL, NULL);
INSERT INTO public.t_t3_v1__ver VALUES ('r_7T9F8XC601XXQBZ8R6JK0QATGN', 'f2', 62, NULL, 'update', 66, 'f2', 0, NULL, NULL, NULL, 'k-2', NULL);
INSERT INTO public.t_t3_v1__ver VALUES ('r_7T9F8XC601XXQBZ8R6JK0QATGN', 'f3', 62, NULL, 'update', 66, 'f3', 0, NULL, NULL, NULL, NULL, 21);
INSERT INTO public.t_t3_v1__ver VALUES ('r_2XDJE12PK0TSR0ZAVBMKW1B8WB', 'f3', 62, 67, 'update', 65, 'f3', 0, NULL, NULL, NULL, NULL, 10);
INSERT INTO public.t_t3_v1__ver VALUES ('r_2XDJE12PK0TSR0ZAVBMKW1B8WB', 'f3', 67, NULL, 'update', 69, 'f3', 0, NULL, NULL, NULL, NULL, 12);


--
-- Data for Name: t_t4_v1; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.t_t4_v1 VALUES ('r_30WY0P19Q5ZAZXJQS8QEA7Q2FV', false, 'half of lunch', 'r_XDTMQRPMBQXRDFX4YKSEW79FBN');


--
-- Data for Name: t_t4_v1__ver; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.t_t4_v1__ver VALUES ('r_30WY0P19Q5ZAZXJQS8QEA7Q2FV', 'f1', 49, NULL, 'insert', 51, 'f1', 0, NULL, NULL, 'half of lunch', NULL);
INSERT INTO public.t_t4_v1__ver VALUES ('r_30WY0P19Q5ZAZXJQS8QEA7Q2FV', 'f2', 49, NULL, 'insert', 51, 'f2', 0, NULL, NULL, NULL, 'r_XDTMQRPMBQXRDFX4YKSEW79FBN');


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

\unrestrict VWu4qdclqFUZevUAwaoO1q3tfR3kbGMzznV7ZmpJ4XZ3yhAlHxWa5sMBXNiO6qM

