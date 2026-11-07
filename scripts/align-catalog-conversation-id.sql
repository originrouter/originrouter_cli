-- align-catalog-conversation-id.sql
-- 把本地目录里的一次会话改回云端已经冻结的 conversation id。
--
-- 什么时候用
-- ----------
-- 云端按 provider 的 id（Claude Code 的 session uuid）认一次会话：谁先上报，
-- 云端就把它自己的 conversation_id 冻结给这次会话，以后所有上报都并到这一行。
-- 本地目录也一样：provider 的 id 变了、还是同一次会话时，本地把它们并成一行，
-- 留下的那一行的 id 是"最近活动的那次尝试"的 id。
--
-- 两个 id 各写各的，就会分叉。本地改了一次 id（迁移期的合并、或者换机器），
-- 云端还冻着老 id，于是所有"按 id 查行"的接口都查不到：
--
--   POST /cli/v1/agent/catalog/conversations/reconcile-previews  -> 404
--   POST /cli/v1/agent/history/manifests/start                   -> 404
--
-- 这两个接口按 (account, conversation_id, device_id) 找行，id 对不上就是 404。
-- 把本地这一行改回云端冻结的 id，两边就对上了；不用改任何代码。
--
-- 用法
-- ----
--   sqlite3 ~/.originrouter/accounts/<account>/agent-catalog.sqlite3 \
--     < scripts/align-catalog-conversation-id.sql
--
-- 幂等：改完之后再跑一次没有可改的行，什么也不做。
-- 守护进程不用停：目录是 WAL，写入是单个事务，守护进程的写会等这个事务结束。
--
-- 回滚
-- ----
-- 把下面 _align 里的两个 id 对调再跑一遍即可（前提是这段时间里没有再改过名字）。

PRAGMA busy_timeout = 5000;

BEGIN IMMEDIATE;

-- (1) 要改的那一对 id。只有这里需要改。
CREATE TEMP TABLE IF NOT EXISTS _align (
  old_id TEXT PRIMARY KEY,
  new_id TEXT NOT NULL
);
DELETE FROM _align;
INSERT INTO _align (old_id, new_id) VALUES (
  'claude-e32c9e6574e14ec2989619df2b657115',  -- 本地目录现在的 id
  'claude-439df88f2e1a4b8581ca4124d1969057'   -- 云端冻结的 id
);

-- (2) 守护：新 id 已经有行了就不能改。同一行已经在新 id 上时不算。
CREATE TEMP TRIGGER IF NOT EXISTS _align_guard
BEFORE UPDATE ON agent_conversations
WHEN NEW.conversation_id = (SELECT new_id FROM _align)
 AND NOT EXISTS (SELECT 1 FROM agent_conversations WHERE conversation_id = (SELECT old_id FROM _align))
BEGIN
  SELECT RAISE(ABORT, 'the target conversation id already exists');
END;

-- (3) 会话行改名。
UPDATE agent_conversations
SET conversation_id = (SELECT new_id FROM _align)
WHERE conversation_id = (SELECT old_id FROM _align);

-- (4) 指向会话的行跟着改名。表清单和目录里合并重复会话时用的一致
--     (agentCatalog.js 的 _foldConversationInto)。
UPDATE agent_runs
SET conversation_id = (SELECT new_id FROM _align)
WHERE conversation_id = (SELECT old_id FROM _align);

UPDATE agent_artifacts
SET conversation_id = (SELECT new_id FROM _align)
WHERE conversation_id = (SELECT old_id FROM _align);

UPDATE agent_launch_receipts
SET conversation_id = (SELECT new_id FROM _align)
WHERE conversation_id = (SELECT old_id FROM _align);

UPDATE agent_catalog_insert_queue
SET conversation_id = (SELECT new_id FROM _align)
WHERE conversation_id = (SELECT old_id FROM _align);

UPDATE agent_catalog_preview_queue
SET conversation_id = (SELECT new_id FROM _align)
WHERE conversation_id = (SELECT old_id FROM _align);

-- (5) 正文同步状态。
--
-- 云端那条 id 下已经有一份"已同步"的记录（正文指纹、分块、清单），那是事实。
-- 老 id 下那条只有"待同步"：它是改名那一下留下的，删掉它，目录就不会再拿老
-- id 去云端要正文清单（那个接口按 id 查行，会 404）。
UPDATE catalog_meta
SET value = json_remove(value, '$."' || (SELECT old_id FROM _align) || '"')
WHERE key = 'agent_history_body_sync_v1'
  AND json_type(value, '$."' || (SELECT old_id FROM _align) || '"') IS NOT NULL;

COMMIT;

DROP TRIGGER IF EXISTS _align_guard;
DROP TABLE IF EXISTS _align;

-- (6) 收尾检查。
--
-- 会话在新 id 下，只有一行。期望 1。
SELECT COUNT(*) AS `conversation_rows_on_the_new_id`
FROM agent_conversations
WHERE conversation_id = 'claude-439df88f2e1a4b8581ca4124d1969057';

-- 老 id 什么都不剩。期望 0。
SELECT COUNT(*) AS `rows_left_on_the_old_id`
FROM agent_conversations
WHERE conversation_id = 'claude-e32c9e6574e14ec2989619df2b657115';

-- 指向会话的行都在新 id 下。期望 0 / 17 / 4 / 3。
SELECT
  (SELECT COUNT(*) FROM agent_runs
    WHERE conversation_id = 'claude-e32c9e6574e14ec2989619df2b657115') AS `runs_on_the_old_id`,
  (SELECT COUNT(*) FROM agent_runs
    WHERE conversation_id = 'claude-439df88f2e1a4b8581ca4124d1969057') AS `runs_on_the_new_id`,
  (SELECT COUNT(*) FROM agent_artifacts
    WHERE conversation_id = 'claude-e32c9e6574e14ec2989619df2b657115') AS `artifacts_on_the_old_id`,
  (SELECT COUNT(*) FROM agent_catalog_preview_queue
    WHERE conversation_id = 'claude-e32c9e6574e14ec2989619df2b657115') AS `previews_on_the_old_id`;
