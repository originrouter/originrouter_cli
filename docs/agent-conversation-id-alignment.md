# 一次会话在本地和云端用了两个 id

## 现象

设备每 5 分钟上报一次目录和正文，两条按 id 查行的接口固定 404：

```
POST /cli/v1/agent/catalog/conversations/reconcile-previews  404  agent conversation not found on this device
POST /cli/v1/agent/history/manifests/start                   404  history_conversation_not_found
```

同一批次里的 `POST /cli/v1/agent/catalog/conversations` 是 200：会话本身在云端，
只是那两条接口按另一个 id 找它。

## 两个 id 是怎么来的

**一次会话 = provider 的那个 id。** Claude Code 的 session uuid
（`cde89751-…`）才是这次会话的身份；我们的 `conversation_id` 只是这次会话在
本地的标签。

**云端把标签冻结在第一次上报上。** 设备报上来的 `native_session_id` 已经在云端
有行了，这次上报就并进那一行，云端不换 id（`upsert_agent_conversation_metadata`
的认领路径）。所以云端的 `conversation_id` 是"谁先上报就用谁的标签"。

**本地也会改标签。** 迁移期（`sql/054` 那次合并、或者设备目录自己的一次合并）
把同一个 provider id 的多行并成一行，留下的是"最近活动的那次尝试"的 id。

两侧各自按自己的规则选了标签，就分叉了。本地是
`claude-e32c9e6574e14ec2989619df2b657115`，云端是
`claude-439df88f2e1a4b8581ca4124d1969057`——同一次会话。

**按 id 查行的接口因此全部查不到。** 这两条接口按
`(account, conversation_id, device_id)` 找行：id 是本地那个，云端只有另一个，
于是 404。

## 为什么它不会自己好

- 云端的 id 被认领路径冻结了，不会改成设备现在用的那个。
- 本地的 id 从此稳定：`(agent_type, native_session_id)` 上有部分唯一索引
  （`idx_agent_conversations_provider`），一个 provider 会话不可能再有第二行；
  记录一次运行之前先合并（`mergeConversationsForNativeSession`），留下的是
  已经持有这个 provider id 的那一行。
- 目录上报的游标也已经越过它了：本地那一行最近一次活动之后没有新的活动，就
  不会再被上报一次，云端也就没有机会认领一个新 id。

也就是说，两边会一直各说各的，直到有一边让一步。

## 修法：把本地这一行改回云端冻结的 id

`scripts/align-catalog-conversation-id.sql` 就是这件事。它改的是设备自己的
本地目录（sqlite），一个事务：

1. 会话行改名；
2. 指向它的行跟着改名：`agent_runs`、`agent_artifacts`、
   `agent_launch_receipts`、`agent_catalog_insert_queue`、
   `agent_catalog_preview_queue`（和目录合并重复会话时用的表清单一致）；
3. 正文同步状态里删掉老 id 下那条"待同步"——云端那条 id 下已经有一份"已同步"
   的记录，那是事实；留着它，目录就会拿老 id 去云端要正文清单。

改名之后：

- 本地报的 id 就是云端的 id，`reconcile-previews` 和 `manifests/start` 找得到
  行，404 停止；
- 云端的行、它的正文分块和检查点一个字节都没动，App 里这次会话还是那一次，
  正文也不用重传；
- 之后本地的 id 就一直是这个：provider id 不会再变，唯一索引也不允许再有第二行。

守护进程不用停：目录是 WAL 模式，写入是一个事务，别人的写会等这个事务结束。
脚本幂等，跑第二遍没有可改的行。

回滚就是把脚本里那一对 id 对调再跑一遍。

## 还没覆盖的：同一会话在第二台机器上

云端的认领是**按账号**找 provider id 的（`_adopted_conversation_id` 只看
`user_id + agent_type + native_session_id`），而按 id 查行的接口是**按设备**
找的（`conversation_id + device_id`）。

于是第二台机器接上同一个 Claude Code 会话时：云端认领第一台机器的那一行，
第二台机器自己那条 id 就永远查不到行，同样的 404 会再出现一遍；而那一行的
`device_id` 会被后一次上报改写成最后上报的那台设备（`device_id = VALUES(device_id)`），
于是两台设备会来回抢这一行。

这不是迁移期的问题，是"一次会话在两台机器上"的常态问题。生产上还没有发生：
这个账号只有一台在用的 CLI 设备（其余几台都已吊销），provider 会话也没有
跨设备出现过。要收口，得让按 id 查行的接口能认出"这个 id 是另一台设备认领过的
那一次会话"，或者让云端按设备分别记行——前者要先想清楚设备归属的语义
（`reconcile-previews` 只允许"当前所属设备"写），不能顺手改。
