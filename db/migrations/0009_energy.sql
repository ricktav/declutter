CREATE TABLE `energy_months` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`itemId` bigint unsigned NOT NULL,
	`month` char(7) NOT NULL,
	`kwhNormal` decimal(10,3),
	`kwhOffpeak` decimal(10,3),
	`kwhReturnedNormal` decimal(10,3),
	`kwhReturnedOffpeak` decimal(10,3),
	`kwhProduced` decimal(10,3),
	`avgW` decimal(8,1),
	`baseW` decimal(8,1),
	`peakW` decimal(8,1),
	`hours` decimal(6,1),
	`source` varchar(32) NOT NULL DEFAULT 'collector',
	`measuredAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `energy_months_id` PRIMARY KEY(`id`),
	CONSTRAINT `em_item_month_uq` UNIQUE(`itemId`,`month`)
);
--> statement-breakpoint
CREATE TABLE `energy_tariffs` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`validFrom` date NOT NULL,
	`normalEurKwh` decimal(7,5) NOT NULL,
	`offpeakEurKwh` decimal(7,5) NOT NULL,
	`feedInEurKwh` decimal(7,5) NOT NULL,
	`feedInCostEurKwh` decimal(7,5) NOT NULL,
	`fixedEurDay` decimal(6,3) NOT NULL,
	`note` varchar(128),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `energy_tariffs_id` PRIMARY KEY(`id`),
	CONSTRAINT `et_valid_from_uq` UNIQUE(`validFrom`)
);
--> statement-breakpoint
INSERT INTO `energy_tariffs` (`validFrom`,`normalEurKwh`,`offpeakEurKwh`,`feedInEurKwh`,`feedInCostEurKwh`,`fixedEurDay`,`note`)
VALUES ('2015-01-01', 0.24395, 0.24395, 0.06050, 0.03993, 1.510, 'contract prices 2026; older prices unknown');
