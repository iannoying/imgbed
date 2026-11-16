-- 图片元数据。图片文件本体存在 R2，这里只存说明、标签等。
CREATE TABLE IF NOT EXISTS images (
  id           TEXT PRIMARY KEY,
  key          TEXT NOT NULL UNIQUE,      -- R2 对象 key，例如 2026/11/AbC123xyz789.png
  filename     TEXT,                      -- 原始文件名
  content_type TEXT NOT NULL,
  size         INTEGER NOT NULL,
  width        INTEGER,
  height       INTEGER,
  sha256       TEXT NOT NULL UNIQUE,      -- 去重用：同一张图只存一份
  description  TEXT NOT NULL DEFAULT '',  -- 图片内容说明（agent 写入）
  tags         TEXT NOT NULL DEFAULT '',  -- 形如 ",tag1,tag2,"，便于 LIKE 精确匹配
  source       TEXT,                      -- 上传者，例如 claude-code / web / cli
  source_url   TEXT,                      -- 若从 URL 抓取，记录原始地址
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_images_created_at ON images (created_at DESC);
