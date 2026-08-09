CREATE TABLE `strategy_portfolio_transactions` (
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
	PRIMARY KEY(`owner_id`, `strategy_id`, `transaction_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_strategy_transactions_owner_strategy_date` ON `strategy_portfolio_transactions` (`owner_id`,`strategy_id`,`date`);--> statement-breakpoint
CREATE INDEX `idx_app_audit_owner_entity_action` ON `app_audit_events` (`owner_id`,`entity_type`,`entity_id`,`action`);
