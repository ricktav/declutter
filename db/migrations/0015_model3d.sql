ALTER TABLE `items` ADD `model3dRoute` varchar(16) DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE `items` ADD `model3dUrl` varchar(512);--> statement-breakpoint
ALTER TABLE `items` ADD `model3dUpdatedAt` timestamp;