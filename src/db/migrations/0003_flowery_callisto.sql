PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_strategy_portfolio_transactions` (
	`owner_id` text NOT NULL,
	`strategy_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`date` text NOT NULL,
	`symbol` text NOT NULL,
	`side` text NOT NULL,
	`shares` real NOT NULL,
	`price` real NOT NULL,
	`fee` real DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`owner_id`, `strategy_id`, `transaction_id`),
	CONSTRAINT "ck_strategy_transactions_side" CHECK("__new_strategy_portfolio_transactions"."side" IN ('buy', 'sell', 'dividend')),
	CONSTRAINT "ck_strategy_transactions_shares" CHECK("__new_strategy_portfolio_transactions"."shares" > 0),
	CONSTRAINT "ck_strategy_transactions_price" CHECK("__new_strategy_portfolio_transactions"."price" >= 0),
	CONSTRAINT "ck_strategy_transactions_fee" CHECK("__new_strategy_portfolio_transactions"."fee" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_strategy_portfolio_transactions`("owner_id", "strategy_id", "transaction_id", "date", "symbol", "side", "shares", "price", "fee", "created_at", "updated_at") SELECT "owner_id", "strategy_id", "transaction_id", "date", "symbol", "side", "shares", "price", "fee", "created_at", "updated_at" FROM `strategy_portfolio_transactions`;--> statement-breakpoint
DROP TABLE `strategy_portfolio_transactions`;--> statement-breakpoint
ALTER TABLE `__new_strategy_portfolio_transactions` RENAME TO `strategy_portfolio_transactions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_strategy_transactions_owner_strategy_date` ON `strategy_portfolio_transactions` (`owner_id`,`strategy_id`,`date`);--> statement-breakpoint
CREATE TABLE `__new_watchlists` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "ck_watchlists_name_length" CHECK(length("__new_watchlists"."name") BETWEEN 1 AND 60),
	CONSTRAINT "ck_watchlists_is_default_boolean" CHECK("__new_watchlists"."is_default" IN (0, 1))
);
--> statement-breakpoint
INSERT INTO `__new_watchlists`("id", "owner_id", "name", "sort_order", "is_default", "version", "created_at", "updated_at") SELECT "id", "owner_id", "name", "sort_order", "is_default", "version", "created_at", "updated_at" FROM `watchlists`;--> statement-breakpoint
DROP TABLE `watchlists`;--> statement-breakpoint
ALTER TABLE `__new_watchlists` RENAME TO `watchlists`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_watchlists_owner_name` ON `watchlists` (`owner_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_watchlists_owner_default` ON `watchlists` (`owner_id`) WHERE "watchlists"."is_default" = 1;--> statement-breakpoint
CREATE INDEX `idx_watchlists_owner_order` ON `watchlists` (`owner_id`,`sort_order`);
