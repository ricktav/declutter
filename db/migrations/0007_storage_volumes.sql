CREATE TABLE `storage_dirs` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`volumeId` bigint unsigned NOT NULL,
	`path` varchar(512) NOT NULL,
	`bytes` bigint NOT NULL,
	`measuredAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `storage_dirs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `storage_volumes` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`itemId` bigint unsigned NOT NULL,
	`mountPoint` varchar(255) NOT NULL,
	`label` varchar(128),
	`fsType` varchar(32),
	`device` varchar(128),
	`capacityBytes` bigint NOT NULL,
	`usedBytes` bigint NOT NULL,
	`dataRole` varchar(16),
	`source` varchar(32) NOT NULL DEFAULT 'manual',
	`measuredAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `storage_volumes_id` PRIMARY KEY(`id`),
	CONSTRAINT `sv_item_mount_uq` UNIQUE(`itemId`,`mountPoint`)
);
--> statement-breakpoint
CREATE INDEX `sd_volume_idx` ON `storage_dirs` (`volumeId`);--> statement-breakpoint
CREATE INDEX `sv_role_idx` ON `storage_volumes` (`dataRole`);