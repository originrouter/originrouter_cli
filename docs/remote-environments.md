# SSH remote environments on a headless server

Remote targets, encrypted SSH credentials and connection state belong to the
CLI device running the daemon. The target SSH host does not need OriginRouter.
The App and model never receive a saved password or private key back from the
device. Confirm the target host fingerprint through an independent channel
before saving it.

By default, the daemon uses the operating system's credential store. On Linux
it specifically requires an available, unlocked, persistent Secret Service;
the in-memory kernel keyring is not used as a fallback. A headless system
without Secret Service may instead explicitly configure the encrypted file
vault described below. The daemon does not silently switch storage backends.

## Configure the headless vault

1. Create a dedicated, stable, **32-byte binary random key file**, owned by the
   same Unix user that runs the CLI service. It must be a regular file with no
   group or other permissions (for example, mode `0600`); symbolic links are
   rejected. Store and back up this key separately from the encrypted vault
   files. A service manager's credential facility is suitable if it makes the
   same key available noninteractively after each restart.
2. Set `ORIGINROUTER_SSH_VAULT_KEY_FILE` to the key file's absolute path in the
   daemon's environment. For a systemd user service, an override can provide
   `Environment=ORIGINROUTER_SSH_VAULT_KEY_FILE=/absolute/path/to/key`; reload
   the unit and restart the daemon after configuring it. A variable set only in
   an interactive shell may not be inherited by an already installed service.
3. Add SSH targets from the App after the daemon starts with that configuration.
   Passwords and private keys are encrypted with AES-256-GCM, using a fresh
   nonce and an account-specific credential reference as authenticated data.
   Encrypted files live under the CLI state directory in
   `remote-environment-secrets/`; account target definitions remain in their
   account-specific database.

The CLI service user must be able to read the key at startup and while using
SSH targets. Do not put the key in the App, a prompt, a repository, or an
unencrypted shared backup. Anyone who can read both the key and ciphertext can
recover the credentials; this vault does not protect against a compromised CLI
service account or administrator. Losing the key makes the stored SSH
credentials unrecoverable.

The selected vault and key identity are pinned per account. If the key or
backend changes, existing credentials fail closed instead of being silently
mixed with credentials encrypted under another key. Before changing vaults,
remove existing targets while the original vault remains available and then
re-add them with the new vault. This release does not migrate credentials or
rotate the headless key automatically. A failed cleanup remains recorded and
can be retried from the App after the credential store is available.

## Connection and approval behavior

Each model session opens its own logical SSH session and working directory.
The underlying verified SSH connection can be reused between sessions. A
command's `cd` and shell variables do not persist automatically; use the
explicit change-directory tool. An unconfirmed command-start reply, timeout, cancellation, or connection loss
may leave the remote command running. Its outcome is reported as unknown and it is
never automatically replayed. The affected logical session refuses queued and
new commands until it is closed. Independently inspect the host before deciding
whether to open a new session; closing the session does not prove that the old
remote command stopped. Model requests use the current Agent permission
and approval configuration. Configuring a host or accepting a host fingerprint
is a user management operation, not a model tool.

The management `list` response includes current-account logical sessions with
their target, owning Agent session, working directory and unconfirmed-outcome
flag. The App can request `close_session` with both target ID and session
handle; the daemon only closes the matching current-account session. Session
information is a snapshot and can change after it is read. A lost close receipt
requires refreshing and checking the device before trying again.
