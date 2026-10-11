ALTER TABLE `captures` ADD `houseId` bigint unsigned;--> statement-breakpoint
CREATE INDEX `captures_house_idx` ON `captures` (`houseId`);