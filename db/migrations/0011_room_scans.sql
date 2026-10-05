CREATE TABLE `room_scans` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`roomId` bigint unsigned NOT NULL,
	`houseId` bigint unsigned NOT NULL,
	`captureId` bigint unsigned,
	`source` varchar(32) NOT NULL,
	`scanDate` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`before` json,
	`after` json NOT NULL,
	`changes` json NOT NULL,
	`revertedAt` timestamp,
	CONSTRAINT `room_scans_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `room_scans_room_idx` ON `room_scans` (`roomId`);