CREATE TABLE `item_links` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`itemId` bigint unsigned,
	`areaId` bigint unsigned,
	`kind` varchar(32) NOT NULL,
	`title` varchar(255),
	`content` text,
	`url` text,
	`storageKey` varchar(512),
	`mimeType` varchar(128),
	`size` bigint,
	`sourceCaptureId` bigint unsigned,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `item_links_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `photo_pins` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`photoId` bigint unsigned NOT NULL,
	`xPct` double NOT NULL,
	`yPct` double NOT NULL,
	`wPct` double,
	`hPct` double,
	`label` varchar(255) NOT NULL DEFAULT '',
	`itemId` bigint unsigned,
	`origin` varchar(32) NOT NULL DEFAULT 'user',
	`status` varchar(32) NOT NULL DEFAULT 'confirmed',
	`flagged` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `photo_pins_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `photos` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`itemId` bigint unsigned,
	`areaId` bigint unsigned,
	`roomId` bigint unsigned,
	`title` varchar(255),
	`storageKey` varchar(512) NOT NULL,
	`mimeType` varchar(128),
	`size` bigint,
	`sourceCaptureId` bigint unsigned,
	`cropBox` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `photos_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `item_links_item_idx` ON `item_links` (`itemId`);--> statement-breakpoint
CREATE INDEX `item_links_source_capture_idx` ON `item_links` (`sourceCaptureId`);--> statement-breakpoint
CREATE INDEX `photo_pins_photo_idx` ON `photo_pins` (`photoId`);--> statement-breakpoint
CREATE INDEX `photo_pins_item_idx` ON `photo_pins` (`itemId`);--> statement-breakpoint
CREATE INDEX `photos_item_idx` ON `photos` (`itemId`);--> statement-breakpoint
CREATE INDEX `photos_room_idx` ON `photos` (`roomId`);--> statement-breakpoint
CREATE INDEX `photos_source_capture_idx` ON `photos` (`sourceCaptureId`);