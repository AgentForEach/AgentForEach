-- AgentForEach PostgreSQL schema (DATABASE_PROVIDER=postgres).
-- Generated from the runtime's collection definitions by
--   npm run db:catalog --workspace @agentforeach/gateway
-- Do not edit by hand. Every statement is idempotent: apply it once, and again
-- after an upgrade, with a role allowed to create extensions and tables:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/postgres-schema.sql
-- then run the runtime with DATABASE_PROVISION=false. Tables are in schema
-- "public"; for DATABASE_SCHEMA=<name>, use schemaSql(spec, { schema }) from
-- @agentforeach/storage-postgres instead.

CREATE EXTENSION IF NOT EXISTS vector;

-- abort-requests
CREATE TABLE IF NOT EXISTS "public"."abort-requests" ("pk" text NOT NULL, "id" text NOT NULL, "doc" jsonb NOT NULL, "etag" text NOT NULL, "expires_at" timestamptz, PRIMARY KEY (pk, id));
CREATE INDEX IF NOT EXISTS "abort-requests_expires_at_09741ab50b" ON "public"."abort-requests" (expires_at) WHERE expires_at IS NOT NULL;

-- aws-durable-conformance
CREATE TABLE IF NOT EXISTS "public"."aws-durable-conformance" ("pk" text NOT NULL, "id" text NOT NULL, "doc" jsonb NOT NULL, "etag" text NOT NULL, "expires_at" timestamptz, PRIMARY KEY (pk, id));
CREATE INDEX IF NOT EXISTS "aws-durable-conformance_expires_at_90f49cd53a" ON "public"."aws-durable-conformance" (expires_at) WHERE expires_at IS NOT NULL;

-- aws-durable-instances
CREATE TABLE IF NOT EXISTS "public"."aws-durable-instances" ("pk" text NOT NULL, "id" text NOT NULL, "doc" jsonb NOT NULL, "etag" text NOT NULL, "expires_at" timestamptz, PRIMARY KEY (pk, id));
CREATE INDEX IF NOT EXISTS "aws-durable-instances_expires_at_fc0f0936eb" ON "public"."aws-durable-instances" (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS "aws-durable-instances_doc_status_fea6325fec" ON "public"."aws-durable-instances" ((doc #> '{"status"}'::text[]));
CREATE INDEX IF NOT EXISTS "aws-durable-instances_doc_sweptAt_21a0332826" ON "public"."aws-durable-instances" ((doc #> '{"sweptAt"}'::text[]));
CREATE INDEX IF NOT EXISTS "aws-durable-instances_doc_userId_072bbd80dc" ON "public"."aws-durable-instances" ((doc #> '{"userId"}'::text[]));

-- aws-sandbox-sessions
CREATE TABLE IF NOT EXISTS "public"."aws-sandbox-sessions" ("pk" text NOT NULL, "id" text NOT NULL, "doc" jsonb NOT NULL, "etag" text NOT NULL, "expires_at" timestamptz, PRIMARY KEY (pk, id));

-- aws-sandbox-workspaces
CREATE TABLE IF NOT EXISTS "public"."aws-sandbox-workspaces" ("pk" text NOT NULL, "id" text NOT NULL, "doc" jsonb NOT NULL, "etag" text NOT NULL, "expires_at" timestamptz, PRIMARY KEY (pk, id));

-- chat-runs
CREATE TABLE IF NOT EXISTS "public"."chat-runs" ("pk" text NOT NULL, "id" text NOT NULL, "doc" jsonb NOT NULL, "etag" text NOT NULL, "expires_at" timestamptz, PRIMARY KEY (pk, id));
CREATE INDEX IF NOT EXISTS "chat-runs_expires_at_3e00c3e8a8" ON "public"."chat-runs" (expires_at) WHERE expires_at IS NOT NULL;

-- cron-due-index
CREATE TABLE IF NOT EXISTS "public"."cron-due-index" ("pk" text NOT NULL, "id" text NOT NULL, "doc" jsonb NOT NULL, "etag" text NOT NULL, "expires_at" timestamptz, PRIMARY KEY (pk, id));
CREATE INDEX IF NOT EXISTS "cron-due-index_expires_at_c1e8e7e974" ON "public"."cron-due-index" (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS "cron-due-index_doc_userId_7ffc19d87d" ON "public"."cron-due-index" ((doc #> '{"userId"}'::text[]));

-- cron-heartbeat-events
CREATE TABLE IF NOT EXISTS "public"."cron-heartbeat-events" ("pk" text NOT NULL, "id" text NOT NULL, "doc" jsonb NOT NULL, "etag" text NOT NULL, "expires_at" timestamptz, PRIMARY KEY (pk, id));
CREATE INDEX IF NOT EXISTS "cron-heartbeat-events_expires_at_3f766404a7" ON "public"."cron-heartbeat-events" (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS "cron-heartbeat-events_doc_userId_815039f69f" ON "public"."cron-heartbeat-events" ((doc #> '{"userId"}'::text[]));

-- cron-jobs
CREATE TABLE IF NOT EXISTS "public"."cron-jobs" ("pk" text NOT NULL, "id" text NOT NULL, "doc" jsonb NOT NULL, "etag" text NOT NULL, "expires_at" timestamptz, PRIMARY KEY (pk, id));

-- cron-runs
CREATE TABLE IF NOT EXISTS "public"."cron-runs" ("pk" text NOT NULL, "id" text NOT NULL, "doc" jsonb NOT NULL, "etag" text NOT NULL, "expires_at" timestamptz, PRIMARY KEY (pk, id));
CREATE INDEX IF NOT EXISTS "cron-runs_expires_at_d3edcb3d30" ON "public"."cron-runs" (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS "cron-runs_doc_userId_e065947414" ON "public"."cron-runs" ((doc #> '{"userId"}'::text[]));

-- episodes
CREATE TABLE IF NOT EXISTS "public"."episodes" ("pk" text NOT NULL, "id" text NOT NULL, "doc" jsonb NOT NULL, "etag" text NOT NULL, "expires_at" timestamptz, "embedding" vector, "fts:english:summary" tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, CASE WHEN jsonb_typeof(doc #> '{"summary"}'::text[]) = 'string' THEN doc #>> '{"summary"}'::text[] ELSE '' END)) STORED, PRIMARY KEY (pk, id));
ALTER TABLE "public"."episodes" ADD COLUMN IF NOT EXISTS "embedding" vector;
ALTER TABLE "public"."episodes" ADD COLUMN IF NOT EXISTS "fts:english:summary" tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, CASE WHEN jsonb_typeof(doc #> '{"summary"}'::text[]) = 'string' THEN doc #>> '{"summary"}'::text[] ELSE '' END)) STORED;

-- hitl-requests
CREATE TABLE IF NOT EXISTS "public"."hitl-requests" ("pk" text NOT NULL, "id" text NOT NULL, "doc" jsonb NOT NULL, "etag" text NOT NULL, "expires_at" timestamptz, PRIMARY KEY (pk, id));
CREATE INDEX IF NOT EXISTS "hitl-requests_expires_at_9df4edf854" ON "public"."hitl-requests" (expires_at) WHERE expires_at IS NOT NULL;

-- identity-channel-index
CREATE TABLE IF NOT EXISTS "public"."identity-channel-index" ("pk" text NOT NULL, "id" text NOT NULL, "doc" jsonb NOT NULL, "etag" text NOT NULL, "expires_at" timestamptz, PRIMARY KEY (pk, id));
CREATE INDEX IF NOT EXISTS "identity-channel-index_doc_userId_f8406c2a6f" ON "public"."identity-channel-index" ((doc #> '{"userId"}'::text[]));

-- identity-links
CREATE TABLE IF NOT EXISTS "public"."identity-links" ("pk" text NOT NULL, "id" text NOT NULL, "doc" jsonb NOT NULL, "etag" text NOT NULL, "expires_at" timestamptz, PRIMARY KEY (pk, id));

-- identity-pairing
CREATE TABLE IF NOT EXISTS "public"."identity-pairing" ("pk" text NOT NULL, "id" text NOT NULL, "doc" jsonb NOT NULL, "etag" text NOT NULL, "expires_at" timestamptz, PRIMARY KEY (pk, id));
CREATE INDEX IF NOT EXISTS "identity-pairing_expires_at_98679077de" ON "public"."identity-pairing" (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS "identity-pairing_doc_userId_ecbd79f496" ON "public"."identity-pairing" ((doc #> '{"userId"}'::text[]));

-- memories
CREATE TABLE IF NOT EXISTS "public"."memories" ("pk" text NOT NULL, "id" text NOT NULL, "doc" jsonb NOT NULL, "etag" text NOT NULL, "expires_at" timestamptz, "embedding" vector, "fts:english:text" tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, CASE WHEN jsonb_typeof(doc #> '{"text"}'::text[]) = 'string' THEN doc #>> '{"text"}'::text[] ELSE '' END)) STORED, PRIMARY KEY (pk, id));
ALTER TABLE "public"."memories" ADD COLUMN IF NOT EXISTS "embedding" vector;
ALTER TABLE "public"."memories" ADD COLUMN IF NOT EXISTS "fts:english:text" tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, CASE WHEN jsonb_typeof(doc #> '{"text"}'::text[]) = 'string' THEN doc #>> '{"text"}'::text[] ELSE '' END)) STORED;

-- onboarding-state
CREATE TABLE IF NOT EXISTS "public"."onboarding-state" ("pk" text NOT NULL, "id" text NOT NULL, "doc" jsonb NOT NULL, "etag" text NOT NULL, "expires_at" timestamptz, PRIMARY KEY (pk, id));

-- prompt-documents
CREATE TABLE IF NOT EXISTS "public"."prompt-documents" ("pk" text NOT NULL, "id" text NOT NULL, "doc" jsonb NOT NULL, "etag" text NOT NULL, "expires_at" timestamptz, PRIMARY KEY (pk, id));

-- rate-limits
CREATE TABLE IF NOT EXISTS "public"."rate-limits" ("pk" text NOT NULL, "id" text NOT NULL, "doc" jsonb NOT NULL, "etag" text NOT NULL, "expires_at" timestamptz, PRIMARY KEY (pk, id));
CREATE INDEX IF NOT EXISTS "rate-limits_expires_at_610dcf487e" ON "public"."rate-limits" (expires_at) WHERE expires_at IS NOT NULL;

-- session-digests
CREATE TABLE IF NOT EXISTS "public"."session-digests" ("pk" text NOT NULL, "id" text NOT NULL, "doc" jsonb NOT NULL, "etag" text NOT NULL, "expires_at" timestamptz, PRIMARY KEY (pk, id));
CREATE INDEX IF NOT EXISTS "session-digests_expires_at_bcaef13f7b" ON "public"."session-digests" (expires_at) WHERE expires_at IS NOT NULL;

-- session-messages-v2
CREATE TABLE IF NOT EXISTS "public"."session-messages-v2" ("pk" text NOT NULL, "id" text NOT NULL, "doc" jsonb NOT NULL, "etag" text NOT NULL, "expires_at" timestamptz, PRIMARY KEY (pk, id));
CREATE INDEX IF NOT EXISTS "session-messages-v2_expires_at_4d55f84edd" ON "public"."session-messages-v2" (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS "session-messages-v2_doc_userId_6bd447a62e" ON "public"."session-messages-v2" ((doc #> '{"userId"}'::text[]));

-- sessions
CREATE TABLE IF NOT EXISTS "public"."sessions" ("pk" text NOT NULL, "id" text NOT NULL, "doc" jsonb NOT NULL, "etag" text NOT NULL, "expires_at" timestamptz, PRIMARY KEY (pk, id));
CREATE INDEX IF NOT EXISTS "sessions_expires_at_abdc78e48b" ON "public"."sessions" (expires_at) WHERE expires_at IS NOT NULL;

-- usage-records
CREATE TABLE IF NOT EXISTS "public"."usage-records" ("pk" text NOT NULL, "id" text NOT NULL, "doc" jsonb NOT NULL, "etag" text NOT NULL, "expires_at" timestamptz, PRIMARY KEY (pk, id));
CREATE INDEX IF NOT EXISTS "usage-records_expires_at_0bc573050b" ON "public"."usage-records" (expires_at) WHERE expires_at IS NOT NULL;

-- user-skills
CREATE TABLE IF NOT EXISTS "public"."user-skills" ("pk" text NOT NULL, "id" text NOT NULL, "doc" jsonb NOT NULL, "etag" text NOT NULL, "expires_at" timestamptz, PRIMARY KEY (pk, id));

-- whatsapp-state
CREATE TABLE IF NOT EXISTS "public"."whatsapp-state" ("pk" text NOT NULL, "id" text NOT NULL, "doc" jsonb NOT NULL, "etag" text NOT NULL, "expires_at" timestamptz, PRIMARY KEY (pk, id));
CREATE INDEX IF NOT EXISTS "whatsapp-state_expires_at_76de7b32ef" ON "public"."whatsapp-state" (expires_at) WHERE expires_at IS NOT NULL;
