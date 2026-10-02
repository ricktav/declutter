CREATE TABLE `areas` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`slug` varchar(64) NOT NULL,
	`name` varchar(128) NOT NULL,
	`icon` varchar(64) NOT NULL DEFAULT 'box',
	`color` varchar(32) NOT NULL DEFAULT '#6366f1',
	`description` text,
	`attributeDefs` json,
	`sortOrder` bigint NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `areas_id` PRIMARY KEY(`id`),
	CONSTRAINT `areas_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`itemId` bigint unsigned,
	`areaId` bigint unsigned,
	`houseId` bigint unsigned,
	`roomId` bigint unsigned,
	`floor` varchar(32),
	`room` varchar(128),
	`kind` varchar(32) NOT NULL,
	`title` varchar(255),
	`content` text,
	`url` text,
	`storageKey` varchar(512),
	`mimeType` varchar(128),
	`size` bigint,
	`sourceCaptureId` bigint unsigned,
	`cropBox` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `attachments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `captures` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`kind` varchar(32) NOT NULL DEFAULT 'note',
	`rawText` text,
	`url` text,
	`storageKey` varchar(512),
	`contentHash` varchar(64),
	`exifGps` json,
	`status` varchar(32) NOT NULL DEFAULT 'pending',
	`suggestion` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `captures_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`scope` varchar(32) NOT NULL DEFAULT 'global',
	`scopeId` bigint NOT NULL DEFAULT 0,
	`role` varchar(32) NOT NULL,
	`content` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `chat_messages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`entityType` varchar(32) NOT NULL,
	`entityId` bigint,
	`action` varchar(64) NOT NULL,
	`summary` varchar(512) NOT NULL,
	`payload` json,
	`actor` varchar(32) NOT NULL DEFAULT 'user',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `houses` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`name` varchar(128) NOT NULL,
	`address` text,
	`lat` double,
	`lng` double,
	`notes` text,
	`floors` json,
	`bagId` varchar(32),
	`parcelId` varchar(64),
	`parcelAreaM2` double,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `houses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `idea_items` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`ideaId` bigint unsigned NOT NULL,
	`itemId` bigint unsigned NOT NULL,
	CONSTRAINT `idea_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ideas` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`areaId` bigint unsigned,
	`title` varchar(255) NOT NULL,
	`body` text,
	`status` varchar(32) NOT NULL DEFAULT 'new',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `ideas_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `items` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`areaId` bigint unsigned NOT NULL,
	`houseId` bigint unsigned,
	`roomId` bigint unsigned,
	`parentId` bigint unsigned,
	`name` varchar(255) NOT NULL,
	`description` text,
	`status` varchar(32) NOT NULL DEFAULT 'active',
	`verificationStatus` varchar(32) NOT NULL DEFAULT 'confirmed',
	`attributes` json,
	`pos` json,
	`floor` varchar(32),
	`room` varchar(128),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`archivedAt` timestamp,
	CONSTRAINT `items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `measurements` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`targetType` varchar(16) NOT NULL,
	`targetId` bigint unsigned NOT NULL,
	`field` varchar(64),
	`valueM` double NOT NULL,
	`method` varchar(32) NOT NULL,
	`note` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `measurements_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `photo_annotations` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`attachmentId` bigint unsigned NOT NULL,
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
	CONSTRAINT `photo_annotations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `relations` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`fromItemId` bigint unsigned NOT NULL,
	`toItemId` bigint unsigned NOT NULL,
	`type` varchar(64) NOT NULL DEFAULT 'related-to',
	`origin` varchar(32) NOT NULL DEFAULT 'user',
	`status` varchar(32) NOT NULL DEFAULT 'confirmed',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `relations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`houseId` bigint unsigned NOT NULL,
	`name` varchar(128) NOT NULL,
	`source` varchar(64) NOT NULL,
	`scanDate` timestamp,
	`widthM` double,
	`depthM` double,
	`wallHeightM` double,
	`walls` json,
	`openings` json,
	`lat` double,
	`lng` double,
	`parentRoomId` bigint unsigned,
	`offsetXM` double,
	`offsetYM` double,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `rooms_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`areaId` bigint unsigned,
	`itemId` bigint unsigned,
	`ideaId` bigint unsigned,
	`title` varchar(255) NOT NULL,
	`notes` text,
	`status` varchar(32) NOT NULL DEFAULT 'todo',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`startedAt` timestamp,
	`completedAt` timestamp,
	CONSTRAINT `tasks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `time_logs` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`taskId` bigint unsigned NOT NULL,
	`startedAt` timestamp NOT NULL,
	`endedAt` timestamp,
	`seconds` bigint NOT NULL DEFAULT 0,
	`note` varchar(255),
	CONSTRAINT `time_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `wiki_pages` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`entityType` varchar(32) NOT NULL,
	`entityId` bigint NOT NULL DEFAULT 0,
	`slug` varchar(128) NOT NULL,
	`title` varchar(255) NOT NULL,
	`content` text NOT NULL,
	`generatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `wiki_pages_id` PRIMARY KEY(`id`),
	CONSTRAINT `wiki_pages_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE INDEX `att_item_idx` ON `attachments` (`itemId`);--> statement-breakpoint
CREATE INDEX `att_house_idx` ON `attachments` (`houseId`);--> statement-breakpoint
CREATE INDEX `att_room_idx` ON `attachments` (`roomId`);--> statement-breakpoint
CREATE INDEX `att_source_capture_idx` ON `attachments` (`sourceCaptureId`);--> statement-breakpoint
CREATE INDEX `captures_hash_idx` ON `captures` (`contentHash`);--> statement-breakpoint
CREATE INDEX `chat_scope_idx` ON `chat_messages` (`scope`,`scopeId`);--> statement-breakpoint
CREATE INDEX `events_created_idx` ON `events` (`createdAt`);--> statement-breakpoint
CREATE INDEX `ideas_area_idx` ON `ideas` (`areaId`);--> statement-breakpoint
CREATE INDEX `items_area_idx` ON `items` (`areaId`);--> statement-breakpoint
CREATE INDEX `items_house_idx` ON `items` (`houseId`);--> statement-breakpoint
CREATE INDEX `items_room_idx` ON `items` (`roomId`);--> statement-breakpoint
CREATE INDEX `meas_target_idx` ON `measurements` (`targetType`,`targetId`);--> statement-breakpoint
CREATE INDEX `pins_att_idx` ON `photo_annotations` (`attachmentId`);--> statement-breakpoint
CREATE INDEX `pins_item_idx` ON `photo_annotations` (`itemId`);--> statement-breakpoint
CREATE INDEX `rel_from_idx` ON `relations` (`fromItemId`);--> statement-breakpoint
CREATE INDEX `rel_to_idx` ON `relations` (`toItemId`);--> statement-breakpoint
CREATE INDEX `rooms_house_idx` ON `rooms` (`houseId`);--> statement-breakpoint
CREATE INDEX `rooms_parent_idx` ON `rooms` (`parentRoomId`);--> statement-breakpoint
CREATE INDEX `tasks_status_idx` ON `tasks` (`status`);