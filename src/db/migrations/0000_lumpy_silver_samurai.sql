CREATE TABLE `app_audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_app_audit_owner_created` ON `app_audit_events` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `watchlist_items` (
	`id` text PRIMARY KEY NOT NULL,
	`watchlist_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`instrument_id` text NOT NULL,
	`symbol` text NOT NULL,
	`display_name` text,
	`exchange` text,
	`logo_url` text,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`watchlist_id`) REFERENCES `watchlists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_watchlist_items_list_instrument` ON `watchlist_items` (`watchlist_id`,`instrument_id`);--> statement-breakpoint
CREATE INDEX `idx_watchlist_items_owner_list_position` ON `watchlist_items` (`owner_id`,`watchlist_id`,`position`);--> statement-breakpoint
CREATE TABLE `watchlists` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_watchlists_owner_name` ON `watchlists` (`owner_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_watchlists_owner_default` ON `watchlists` (`owner_id`) WHERE "watchlists"."is_default" = 1;--> statement-breakpoint
CREATE INDEX `idx_watchlists_owner_order` ON `watchlists` (`owner_id`,`sort_order`);
