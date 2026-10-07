-- Schema for the app.
--
-- config/migrate.js applies the same shape on every boot, so this file is a
-- reference and a fast path for a fresh install rather than the source of
-- truth.
--
--   mysql -u root -p < sql/schema.sql
--
-- Tables are listed in dependency order: a foreign key needs its target table
-- to exist already, so `stores` comes first. Every child cascades on delete,
-- so shop/redact deleting a store clears everything it owns.

CREATE DATABASE IF NOT EXISTS migration_tool
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE migration_tool;

CREATE TABLE IF NOT EXISTS `stores` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `shop_domain` varchar(255) NOT NULL,
  `store_name` varchar(255) DEFAULT NULL,
  `email` varchar(255) DEFAULT NULL,
  `access_token` text DEFAULT NULL,
  `access_token_expires_at` datetime DEFAULT NULL,
  `refresh_token` text DEFAULT NULL,
  `refresh_token_expires_at` datetime DEFAULT NULL,
  `api_version` varchar(16) NOT NULL DEFAULT '2025-01',
  `currency` varchar(8) DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `installed_at` datetime DEFAULT NULL,
  `uninstalled_at` datetime DEFAULT NULL,
  `onboarded_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_shop_domain` (`shop_domain`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `dummy_shops` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `shop_name` varchar(255) DEFAULT NULL,
  `status` tinyint(1) DEFAULT 1,
  PRIMARY KEY (`id`),
  KEY `idx_dummy_shop_active` (`shop_name`,`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `plans` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `price` double NOT NULL DEFAULT 0,
  `is_popular` tinyint(1) DEFAULT 0,
  `is_active` tinyint(1) DEFAULT 1,
  `days` int(11) DEFAULT NULL,
  `plan_content` longtext DEFAULT NULL,
  `max_records` int(11) DEFAULT NULL,
  `max_migrations` int(11) DEFAULT NULL,
  `allowed_entities` json DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_plan_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `user_memberships` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) DEFAULT NULL,
  `membership_id` int(11) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `status` tinyint(1) DEFAULT 1,
  PRIMARY KEY (`id`),
  KEY `idx_membership_store` (`user_id`,`status`),
  CONSTRAINT `fk_membership_store` FOREIGN KEY (`user_id`) REFERENCES `stores` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_membership_plan` FOREIGN KEY (`membership_id`) REFERENCES `plans` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `membership_payments` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `membership_id` int(11) DEFAULT NULL,
  `user_id` int(11) DEFAULT NULL,
  `api_client_id` bigint(20) DEFAULT NULL,
  `charge_id` bigint(20) DEFAULT NULL,
  `date_add` datetime DEFAULT NULL,
  `date_update` datetime DEFAULT NULL,
  `status` int(11) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_payment_membership` (`membership_id`),
  KEY `idx_payment_store` (`user_id`),
  CONSTRAINT `fk_payment_membership` FOREIGN KEY (`membership_id`) REFERENCES `user_memberships` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_payment_store` FOREIGN KEY (`user_id`) REFERENCES `stores` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `faqs` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `question` varchar(512) NOT NULL,
  `answer` text NOT NULL,
  `position` int(11) NOT NULL DEFAULT 0,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_faqs_active` (`is_active`,`position`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------------
-- Migration
-- ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `source_connections` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `store_id` int(11) NOT NULL,
  `platform` enum('woocommerce','wordpress','csv','magento','bigcommerce') NOT NULL,
  `base_url` varchar(255) NOT NULL,
  `credentials` text DEFAULT NULL,
  `credentials_hint` varchar(64) DEFAULT NULL,
  `status` enum('connected','failed','disconnected') NOT NULL DEFAULT 'connected',
  `last_error` varchar(512) DEFAULT NULL,
  `source_version` varchar(64) DEFAULT NULL,
  `scan_counts` json DEFAULT NULL,
  `last_tested_at` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_conn_store` (`store_id`,`status`),
  CONSTRAINT `fk_conn_store` FOREIGN KEY (`store_id`) REFERENCES `stores` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `migrations` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `store_id` int(11) NOT NULL,
  `source_connection_id` int(11) DEFAULT NULL,
  `type` enum('demo','full','delta','retry') NOT NULL DEFAULT 'full',
  `status` enum('draft','queued','running','paused','completed','failed','cancelled') NOT NULL DEFAULT 'draft',
  `wizard_step` tinyint(4) NOT NULL DEFAULT 1,
  `entities` json DEFAULT NULL,
  `options` json DEFAULT NULL,
  `total_records` int(11) NOT NULL DEFAULT 0,
  `parent_migration_id` int(11) DEFAULT NULL,
  `worker_id` varchar(64) DEFAULT NULL,
  `locked_at` datetime DEFAULT NULL,
  `last_error` varchar(512) DEFAULT NULL,
  `started_at` datetime DEFAULT NULL,
  `finished_at` datetime DEFAULT NULL,
  `storage_path` varchar(512) DEFAULT NULL,
  `phase` enum('export','convert','import','done') DEFAULT NULL,
  `personal_files_expire_at` datetime DEFAULT NULL,
  `files_expire_at` datetime DEFAULT NULL,
  `files_deleted_at` datetime DEFAULT NULL,
  `personal_files_deleted_at` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_mig_store_status` (`store_id`,`status`),
  KEY `idx_mig_work` (`status`,`locked_at`),
  KEY `idx_mig_expiry` (`files_deleted_at`,`files_expire_at`),
  CONSTRAINT `fk_mig_store` FOREIGN KEY (`store_id`) REFERENCES `stores` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_mig_conn` FOREIGN KEY (`source_connection_id`) REFERENCES `source_connections` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_mig_parent` FOREIGN KEY (`parent_migration_id`) REFERENCES `migrations` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `migration_steps` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `migration_id` int(11) NOT NULL,
  `entity` varchar(32) NOT NULL,
  `position` tinyint(4) NOT NULL,
  `status` enum('pending','running','done','failed','skipped') NOT NULL DEFAULT 'pending',
  `total` int(11) NOT NULL DEFAULT 0,
  `processed` int(11) NOT NULL DEFAULT 0,
  `succeeded` int(11) NOT NULL DEFAULT 0,
  `failed` int(11) NOT NULL DEFAULT 0,
  `skipped` int(11) NOT NULL DEFAULT 0,
  `source_cursor` varchar(255) DEFAULT NULL,
  `phase` enum('export','convert','import','done') DEFAULT NULL,
  `exported` int(11) NOT NULL DEFAULT 0,
  `imported` int(11) NOT NULL DEFAULT 0,
  `export_page` int(11) NOT NULL DEFAULT 0,
  `import_line` int(11) NOT NULL DEFAULT 0,
  `bulk_operation_id` varchar(128) DEFAULT NULL,
  `started_at` datetime DEFAULT NULL,
  `finished_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_step` (`migration_id`,`entity`),
  CONSTRAINT `fk_step_mig` FOREIGN KEY (`migration_id`) REFERENCES `migrations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `id_map` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `store_id` int(11) NOT NULL,
  `source_connection_id` int(11) NOT NULL,
  `entity` varchar(32) NOT NULL,
  `source_id` varchar(64) NOT NULL,
  `source_url` varchar(512) DEFAULT NULL,
  `shopify_gid` varchar(128) NOT NULL,
  `shopify_handle` varchar(255) DEFAULT NULL,
  `source_hash` char(40) DEFAULT NULL,
  `migration_id` int(11) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_map` (`source_connection_id`,`entity`,`source_id`),
  KEY `idx_map_migration` (`migration_id`),
  KEY `idx_map_gid` (`shopify_gid`),
  CONSTRAINT `fk_map_store` FOREIGN KEY (`store_id`) REFERENCES `stores` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_map_conn` FOREIGN KEY (`source_connection_id`) REFERENCES `source_connections` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_map_mig` FOREIGN KEY (`migration_id`) REFERENCES `migrations` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- migration_errors and migration_logs are replaced by each migration's
-- errors.csv and log.txt files (see services/migration/storage.js). The
-- database keeps only the counts, never the records themselves.
