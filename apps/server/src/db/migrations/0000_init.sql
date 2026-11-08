CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"harness" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"auth_mode" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"body" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts_state" (
	"account_id" text PRIMARY KEY NOT NULL,
	"sleep_until" timestamp with time zone,
	"sleep_reason" text,
	"util" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cred_expires_at" timestamp with time zone,
	"last_auth_check" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "book_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"book_id" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"body" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "books" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"genre" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"tier" text DEFAULT 'standard' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"cursor" integer DEFAULT 1 NOT NULL,
	"accepted_through" integer DEFAULT 0 NOT NULL,
	"audited_through" integer DEFAULT 0 NOT NULL,
	"published_through" integer DEFAULT 0 NOT NULL,
	"cards_through" integer DEFAULT 0 NOT NULL,
	"total_cjk" integer DEFAULT 0 NOT NULL,
	"format_version" integer DEFAULT 1 NOT NULL,
	"head_commit" text,
	"writer_profile" text,
	"paused_reason" text,
	"endgame" boolean DEFAULT false NOT NULL,
	"v1_id" integer,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "capabilities" (
	"harness" text NOT NULL,
	"version" text NOT NULL,
	"isolation" text NOT NULL,
	"body" jsonb NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	CONSTRAINT "capabilities_harness_version_isolation_pk" PRIMARY KEY("harness","version","isolation")
);
--> statement-breakpoint
CREATE TABLE "chapters" (
	"book_id" text NOT NULL,
	"no" integer NOT NULL,
	"chapter_id" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"volume" text DEFAULT '' NOT NULL,
	"arc" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'planned' NOT NULL,
	"workflow" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cjk" integer DEFAULT 0 NOT NULL,
	"accepted_commit" text,
	"accepted_at" timestamp with time zone,
	"audited" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"revised_at" timestamp with time zone,
	"verdict" text,
	"revisions" integer DEFAULT 0 NOT NULL,
	"degraded" boolean DEFAULT false NOT NULL,
	"debts" integer DEFAULT 0 NOT NULL,
	"writer_model" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chapters_book_id_no_pk" PRIMARY KEY("book_id","no")
);
--> statement-breakpoint
CREATE TABLE "circuit_breakers" (
	"harness" text NOT NULL,
	"version" text NOT NULL,
	"isolation" text NOT NULL,
	"state" text DEFAULT 'closed' NOT NULL,
	"opened_at" timestamp with time zone,
	"effective_at" timestamp with time zone,
	"reason" text,
	"samples" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "circuit_breakers_harness_version_isolation_pk" PRIMARY KEY("harness","version","isolation")
);
--> statement-breakpoint
CREATE TABLE "harness_installs" (
	"harness" text NOT NULL,
	"version" text NOT NULL,
	"bin_path" text NOT NULL,
	"sha256" text DEFAULT '' NOT NULL,
	"sha256_source" text DEFAULT 'tofu' NOT NULL,
	"tier" text DEFAULT 'unknown' NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"node_version" text,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "harness_installs_harness_version_pk" PRIMARY KEY("harness","version")
);
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'v1' NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"request" jsonb NOT NULL,
	"log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"report" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "inbox" (
	"id" text PRIMARY KEY NOT NULL,
	"book_id" text,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"dedupe_key" text,
	"related_task_id" text,
	"timeout_at" timestamp with time zone,
	"on_timeout" text DEFAULT 'wait' NOT NULL,
	"resolution" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "login_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"harness" text NOT NULL,
	"state" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"exit_code" integer,
	"output" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"channel" text NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"approval_token_hash" text,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pats" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"hash" text NOT NULL,
	"scopes" jsonb DEFAULT '["admin"]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"harness" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"body" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publish_schedule" (
	"book_id" text NOT NULL,
	"no" integer NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"slot" timestamp with time zone,
	"published_at" timestamp with time zone,
	"state" text DEFAULT 'queued' NOT NULL,
	CONSTRAINT "publish_schedule_book_id_no_pk" PRIMARY KEY("book_id","no")
);
--> statement-breakpoint
CREATE TABLE "quota_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"window" text NOT NULL,
	"book_id" text,
	"task_id" text,
	"run_id" text,
	"amount" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quota_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"window" text NOT NULL,
	"utilization" real,
	"resets_at" timestamp with time zone,
	"source" text DEFAULT 'event' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "readers" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"lookup_id" text,
	"pw_hash" text NOT NULL,
	"token_version" integer DEFAULT 1 NOT NULL,
	"allow_books" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"legacy" boolean DEFAULT false NOT NULL,
	"v1_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reading_progress" (
	"reader_id" text NOT NULL,
	"book_id" text NOT NULL,
	"no" integer NOT NULL,
	"scroll" real DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reading_progress_reader_id_book_id_pk" PRIMARY KEY("reader_id","book_id")
);
--> statement-breakpoint
CREATE TABLE "routing_presets" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"body" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"t" text NOT NULL,
	"body" jsonb NOT NULL,
	CONSTRAINT "run_events_run_id_seq_pk" PRIMARY KEY("run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"book_id" text,
	"task_kind" text NOT NULL,
	"attempt" integer NOT NULL,
	"role" text NOT NULL,
	"profile_id" text NOT NULL,
	"account_id" text,
	"harness" text NOT NULL,
	"harness_version" text DEFAULT '' NOT NULL,
	"model" text,
	"model_reported" text,
	"isolation" text NOT NULL,
	"driver" text DEFAULT 'spawn' NOT NULL,
	"session_id" text,
	"state" text DEFAULT 'preparing' NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"shim_pid" integer,
	"shim_start" text,
	"harness_pid" integer,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"exit_code" integer,
	"error_class" text,
	"outcome" jsonb,
	"usage" jsonb,
	"nonce_report" jsonb,
	"denials" integer DEFAULT 0 NOT NULL,
	"run_dir" text NOT NULL,
	"base_commit" text,
	"stack_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"owner_kind" text DEFAULT 'account' NOT NULL,
	"owner_id" text,
	"name" text NOT NULL,
	"ciphertext" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"sha256" text NOT NULL,
	"bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"reader_id" text,
	"token_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone,
	"ip" text,
	"ua" text
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"book_id" text,
	"kind" text NOT NULL,
	"target" text NOT NULL,
	"lane" text NOT NULL,
	"role" text,
	"tier" text,
	"priority" integer DEFAULT 0 NOT NULL,
	"deps" text[] DEFAULT '{}'::text[] NOT NULL,
	"state" text DEFAULT 'ready' NOT NULL,
	"base_commit" text,
	"hard_manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"soft_manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rebase_validators" text[] DEFAULT '{}'::text[] NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 6 NOT NULL,
	"last_error_class" text,
	"last_error" text,
	"wait_reason" text,
	"not_before" timestamp with time zone,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"parent_task_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "usage_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"account_id" text,
	"profile_id" text,
	"harness" text NOT NULL,
	"model" text,
	"task_kind" text NOT NULL,
	"tier" text,
	"book_id" text,
	"run_id" text,
	"input" integer DEFAULT 0 NOT NULL,
	"cached" integer DEFAULT 0 NOT NULL,
	"cache_write" integer DEFAULT 0 NOT NULL,
	"output" integer DEFAULT 0 NOT NULL,
	"reasoning" integer DEFAULT 0 NOT NULL,
	"util_delta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"usd" double precision
);
--> statement-breakpoint
CREATE TABLE "v1_import_map" (
	"kind" text NOT NULL,
	"v1_id" integer NOT NULL,
	"v2_id" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "v1_import_map_kind_v1_id_pk" PRIMARY KEY("kind","v1_id")
);
--> statement-breakpoint
ALTER TABLE "accounts_state" ADD CONSTRAINT "accounts_state_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_ts_idx" ON "audit_log" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "book_events_book_ts_idx" ON "book_events" USING btree ("book_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "books_slug_uq" ON "books" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "books_status_idx" ON "books" USING btree ("status");--> statement-breakpoint
CREATE INDEX "chapters_state_idx" ON "chapters" USING btree ("book_id","state");--> statement-breakpoint
CREATE INDEX "chapters_pub_idx" ON "chapters" USING btree ("book_id","published_at");--> statement-breakpoint
CREATE INDEX "inbox_state_idx" ON "inbox" USING btree ("state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_dedupe_open_uq" ON "inbox" USING btree ("dedupe_key") WHERE state = 'open';--> statement-breakpoint
CREATE INDEX "publish_due_idx" ON "publish_schedule" USING btree ("state","not_before");--> statement-breakpoint
CREATE INDEX "quota_res_open_idx" ON "quota_reservations" USING btree ("account_id","window","settled_at");--> statement-breakpoint
CREATE INDEX "quota_snap_idx" ON "quota_snapshots" USING btree ("account_id","window","ts");--> statement-breakpoint
CREATE INDEX "readers_lookup_idx" ON "readers" USING btree ("lookup_id");--> statement-breakpoint
CREATE INDEX "run_events_ts_idx" ON "run_events" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "runs_state_lease_idx" ON "runs" USING btree ("state","lease_expires_at");--> statement-breakpoint
CREATE INDEX "runs_task_idx" ON "runs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "runs_book_idx" ON "runs" USING btree ("book_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "secrets_owner_name_uq" ON "secrets" USING btree ("owner_kind","owner_id","kind","name");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "tasks_book_state_prio_idx" ON "tasks" USING btree ("book_id","state","priority");--> statement-breakpoint
CREATE INDEX "tasks_state_notbefore_idx" ON "tasks" USING btree ("state","not_before");--> statement-breakpoint
CREATE INDEX "tasks_kind_target_idx" ON "tasks" USING btree ("book_id","kind","target");--> statement-breakpoint
CREATE INDEX "usage_ts_idx" ON "usage_ledger" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "usage_profile_kind_idx" ON "usage_ledger" USING btree ("profile_id","task_kind");--> statement-breakpoint
CREATE INDEX "usage_book_idx" ON "usage_ledger" USING btree ("book_id");