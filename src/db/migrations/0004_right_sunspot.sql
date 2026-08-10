CREATE TABLE `custom_strategies` (
	`owner_id` text NOT NULL,
	`strategy_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`definition_json` text NOT NULL,
	`deleted_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`owner_id`, `strategy_id`),
	CONSTRAINT "ck_custom_strategies_version" CHECK("custom_strategies"."version" >= 1),
	CONSTRAINT "ck_custom_strategies_definition_json" CHECK(json_valid("custom_strategies"."definition_json"))
);
--> statement-breakpoint
CREATE INDEX `idx_custom_strategies_owner_deleted_updated` ON `custom_strategies` (`owner_id`,`deleted_at`,`updated_at`);