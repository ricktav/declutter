DROP INDEX `att_house_idx` ON `attachments`;--> statement-breakpoint
ALTER TABLE `attachments` DROP COLUMN `houseId`;--> statement-breakpoint
ALTER TABLE `attachments` DROP COLUMN `floor`;--> statement-breakpoint
ALTER TABLE `attachments` DROP COLUMN `room`;--> statement-breakpoint
ALTER TABLE `houses` DROP COLUMN `floors`;--> statement-breakpoint
ALTER TABLE `items` DROP COLUMN `floor`;--> statement-breakpoint
ALTER TABLE `items` DROP COLUMN `room`;