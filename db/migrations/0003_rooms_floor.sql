ALTER TABLE `rooms` ADD `floor` varchar(32);--> statement-breakpoint
ALTER TABLE `rooms` ADD CONSTRAINT `rooms_house_name_uq` UNIQUE(`houseId`,`name`);