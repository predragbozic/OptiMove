--
-- PostgreSQL database dump
--

\restrict SYNTHETICKEYNOTASECRET

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET row_security = off;

--
-- Name: auth; Type: SCHEMA; Schema: -; Owner: supabase_admin
--

CREATE SCHEMA auth;

ALTER SCHEMA auth OWNER TO supabase_admin;

--
-- Name: training_load; Type: SCHEMA; Schema: -; Owner: postgres
--

CREATE SCHEMA training_load;

ALTER SCHEMA training_load OWNER TO postgres;

--
-- Name: plans; Type: SCHEMA; Schema: -; Owner: postgres
--

CREATE SCHEMA plans;

ALTER SCHEMA plans OWNER TO postgres;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

--
-- Name: uid(); Type: FUNCTION; Schema: auth; Owner: supabase_admin
--

CREATE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ select null::uuid $$;

ALTER FUNCTION auth.uid() OWNER TO supabase_admin;

--
-- Name: touch_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  -- a comment; with a semicolon
  new.updated_at := now();
  return new;
end;
$$;

ALTER FUNCTION public.touch_updated_at() OWNER TO postgres;

--
-- Name: users; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email character varying(255) NOT NULL,
    full_name text,
    content_language character varying(8) DEFAULT 'en'::character varying NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT users_email_check CHECK (((email)::text <> ''::text)),
    CONSTRAINT users_language_check CHECK (((content_language)::text = ANY ((ARRAY['en'::character varying, 'sr'::character varying])::text[])))
);

ALTER TABLE public.users OWNER TO postgres;

--
-- Name: teams; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.teams (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    owner_id uuid
);

ALTER TABLE public.teams OWNER TO postgres;

--
-- Name: plan_items; Type: TABLE; Schema: plans; Owner: postgres
--

CREATE TABLE plans.plan_items (
    id bigint NOT NULL,
    plan_id uuid NOT NULL,
    note text
);

ALTER TABLE plans.plan_items OWNER TO postgres;

--
-- Name: plan_items_id_seq; Type: SEQUENCE; Schema: plans; Owner: postgres
--

CREATE SEQUENCE plans.plan_items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE plans.plan_items_id_seq OWNER TO postgres;

ALTER SEQUENCE plans.plan_items_id_seq OWNED BY plans.plan_items.id;

--
-- Name: items; Type: TABLE; Schema: training_load; Owner: postgres
--

CREATE TABLE training_load.items (
    id uuid NOT NULL,
    team_id uuid NOT NULL
);

ALTER TABLE training_load.items OWNER TO postgres;

--
-- Name: app_audit; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.app_audit (
    id uuid NOT NULL,
    note text
);

ALTER TABLE public.app_audit OWNER TO postgres;

COMMENT ON TABLE public.users IS 'people who sign in: do not put a value here';

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_language_known CHECK (((content_language)::text <> ''::text));

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_owner_fk FOREIGN KEY (owner_id) REFERENCES public.users(id);

ALTER TABLE ONLY plans.plan_items
    ADD CONSTRAINT plan_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY training_load.items
    ADD CONSTRAINT items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.app_audit
    ADD CONSTRAINT app_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY plans.plan_items ALTER COLUMN id SET DEFAULT nextval('plans.plan_items_id_seq'::regclass);

CREATE INDEX teams_owner_idx ON public.teams USING btree (owner_id);

CREATE INDEX users_language_idx ON public.users USING btree (content_language);

CREATE INDEX items_team_idx ON training_load.items USING btree (team_id);

CREATE TRIGGER users_touch BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TRIGGER items_touch BEFORE UPDATE ON training_load.items FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_self ON public.users USING ((id = auth.uid()));

GRANT ALL ON TABLE public.users TO anon;

GRANT ALL ON SCHEMA public TO authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;

CREATE PUBLICATION supabase_realtime WITH (publish = 'insert, update, delete, truncate');

\unrestrict SYNTHETICKEYNOTASECRET

--
-- PostgreSQL database dump complete
--
