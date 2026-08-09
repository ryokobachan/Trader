CREATE TABLE `strategy_preferences` (
	`owner_id` text NOT NULL,
	`strategy_id` text NOT NULL,
	`name_override` text,
	`headline_override` text,
	`deleted_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`owner_id`, `strategy_id`),
	CONSTRAINT "ck_strategy_preferences_name_length" CHECK("strategy_preferences"."name_override" IS NULL OR length("strategy_preferences"."name_override") BETWEEN 1 AND 120),
	CONSTRAINT "ck_strategy_preferences_headline_length" CHECK("strategy_preferences"."headline_override" IS NULL OR length("strategy_preferences"."headline_override") BETWEEN 1 AND 500),
	CONSTRAINT "ck_strategy_preferences_has_payload" CHECK("strategy_preferences"."name_override" IS NOT NULL OR "strategy_preferences"."headline_override" IS NOT NULL OR "strategy_preferences"."deleted_at" IS NOT NULL)
);
