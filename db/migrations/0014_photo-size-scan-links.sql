CREATE TABLE `room_scan_links` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`roomId` bigint unsigned NOT NULL,
	`source` varchar(64) NOT NULL,
	`externalId` varchar(255) NOT NULL,
	`capturedAt` timestamp,
	`metadata` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `room_scan_links_id` PRIMARY KEY(`id`),
	CONSTRAINT `room_scan_links_source_ext_uq` UNIQUE(`source`,`externalId`)
);
--> statement-breakpoint
ALTER TABLE `photos` ADD `width` bigint;--> statement-breakpoint
ALTER TABLE `photos` ADD `height` bigint;--> statement-breakpoint
CREATE INDEX `room_scan_links_room_idx` ON `room_scan_links` (`roomId`);