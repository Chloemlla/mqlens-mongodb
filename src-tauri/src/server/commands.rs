//! Command bodies for MQLens Server accounts and sessions.
//!
//! Each takes the accounts file path explicitly, like the other `_impl`s, so
//! tests run against a temporary file with no `AppHandle`.

use crate::server::accounts::{self, ServerAccount, ServerAccountInput, ServerAccountView};
use crate::server::channel::client;
use crate::server::key_source;
use crate::server::pb::mqlens::v1::connection_service_client::ConnectionServiceClient;
use crate::server::pb::mqlens::v1::ListConnectionsRequest;
use crate::server::session::{self, blocking, AccountSession, FileTokenStore, TokenStore};
use crate::AppState;
use serde::Serialize;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use zeroize::Zeroizing;

/// How long a vault reset waits for its sessions to end on their servers.
const RESET_SIGN_OUT_TIMEOUT: Duration = Duration::from_secs(10);

/// One of the server's connections as the webview sees it: a reference, never
/// a connection string or credential, and what the user may do there.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteConnectionView {
    pub id: String,
    pub name: String,
    pub tags: Vec<String>,
    pub deployment_kind: String,
    pub op_classes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SignOutResult {
    /// False when the server could not confirm it: the session is gone here,
    /// but may stay usable on the server until it expires.
    pub ended_on_server: bool,
}

fn token_store(state: &AppState, path: &Path) -> Arc<dyn TokenStore> {
    Arc::new(FileTokenStore::new(
        path.to_path_buf(),
        key_source(state.vault_key.clone()),
    ))
}

pub(crate) fn account_list_impl(
    state: &AppState,
    path: &Path,
) -> Result<Vec<ServerAccountView>, String> {
    let key = state.require_key()?;
    Ok(accounts::load(path, &key)?
        .iter()
        .map(ServerAccount::view)
        .collect())
}

pub(crate) async fn account_save_impl(
    state: &AppState,
    path: &Path,
    input: ServerAccountInput,
) -> Result<ServerAccountView, String> {
    let key = state.require_key()?;
    let candidate = input.clone().into_account()?;
    // An edit that changes who or where the account signs in ends its session
    // first, while the stored token can still log it out on the server.
    let existing = accounts::load(path, &key)?
        .into_iter()
        .find(|a| a.id == candidate.id);
    if let Some(existing) = existing {
        if existing.refresh_token.is_some() && !existing.same_identity(&candidate) {
            sign_out_account(state, path, &existing).await;
        }
    }
    let file = path.to_path_buf();
    let current = key_source(state.vault_key.clone());
    let (saved, _) =
        blocking(move || accounts::save_account_while(&file, &key, Some(&current), input)).await?;
    if saved.refresh_token.is_none() {
        state.server.remove(&saved.id).await;
    }
    Ok(saved.view())
}

pub(crate) async fn account_delete_impl(
    state: &AppState,
    path: &Path,
    account_id: &str,
) -> Result<(), String> {
    let key = state.require_key()?;
    // Removed first, under the file lock, so the session ended below is exactly
    // the one stored at that moment, including one a sign-in stored just before.
    // A sign-in storing later finds the account gone and ends its own session.
    let file = path.to_path_buf();
    let id = account_id.to_string();
    let current = key_source(state.vault_key.clone());
    let removed =
        blocking(move || accounts::delete_account_while(&file, &key, Some(&current), &id)).await?;
    state.server.remove(account_id).await;
    if let Some(account) = removed {
        if let Some(token) = account.refresh_token.as_deref() {
            session::revoke(&account, token).await;
        }
    }
    Ok(())
}

pub(crate) async fn sign_in_impl(
    state: &AppState,
    path: &Path,
    account_id: &str,
    password: String,
) -> Result<ServerAccountView, String> {
    let password = Zeroizing::new(password);
    let key = state.require_key()?;
    let account = accounts::find(path, &key, account_id)?;
    // Signing in again replaces the stored session: end that one properly
    // rather than leave it usable on the server.
    if account.refresh_token.is_some() {
        sign_out_account(state, path, &account).await;
    }
    let session = AccountSession::sign_in(&account, &password, token_store(state, path)).await?;
    state.server.insert(session).await;
    // The vault may have locked while the server answered; a session must not
    // be left behind for a locked vault.
    if state.require_key().is_err() {
        state.server.remove(account_id).await;
        return Err("vault is locked".to_string());
    }
    let mut view = account.view();
    view.signed_in = true;
    Ok(view)
}

pub(crate) async fn sign_out_impl(
    state: &AppState,
    path: &Path,
    account_id: &str,
) -> Result<SignOutResult, String> {
    let key = state.require_key()?;
    let account = accounts::find(path, &key, account_id)?;
    let session = current_session(state, path, &account).await?;
    let ended_on_server = session.sign_out().await?;
    Ok(SignOutResult { ended_on_server })
}

pub(crate) async fn list_connections_impl(
    state: &AppState,
    path: &Path,
    account_id: &str,
) -> Result<Vec<RemoteConnectionView>, String> {
    let key = state.require_key()?;
    let account = accounts::find(path, &key, account_id)?;
    let session = state
        .server
        .session(&account, token_store(state, path))
        .await?;
    let response = session
        .call(ListConnectionsRequest {}, |channel, request| async move {
            client!(ConnectionServiceClient, channel)
                .list_connections(request)
                .await
        })
        .await?;
    Ok(response
        .connections
        .into_iter()
        .map(|c| RemoteConnectionView {
            id: c.id,
            name: c.name,
            tags: c.tags,
            deployment_kind: c.deployment_kind,
            op_classes: c.op_classes,
        })
        .collect())
}

/// Ends every stored session before a vault reset makes the accounts file
/// unreadable. Best effort and bounded: an unreachable server must not hold up
/// a reset, and sessions are dropped here regardless.
pub(crate) async fn sign_out_all_best_effort(state: &AppState, path: &Path) {
    sign_out_all_within(state, path, RESET_SIGN_OUT_TIMEOUT).await
}

/// Each account gets `limit` of its own, all at once, so one unreachable server
/// cannot use up the time every other account needed.
async fn sign_out_all_within(state: &AppState, path: &Path, limit: Duration) {
    state.server.clear().await;
    let Ok(key) = state.require_key() else {
        return;
    };
    // Every token is taken out of the file in one locked step, so no session,
    // here or in another instance, presents one again while it is revoked,
    // which would trip the server's reuse check. No lock is held across the
    // network calls below.
    let file = path.to_path_buf();
    let taken = blocking(move || {
        accounts::update(&file, &key, |all| {
            Ok(all
                .iter_mut()
                .filter_map(|a| a.refresh_token.take().map(|token| (a.clone(), token)))
                .collect::<Vec<_>>())
        })
    })
    .await;
    if let Ok(taken) = taken {
        let revokes = taken
            .iter()
            .map(|(account, token)| tokio::time::timeout(limit, session::revoke(account, token)));
        futures::future::join_all(revokes).await;
    }
}

/// Ends an account's session on the server and here, best effort. Returns
/// whether the server confirmed it.
async fn sign_out_account(state: &AppState, path: &Path, account: &ServerAccount) -> bool {
    match current_session(state, path, account).await {
        Ok(session) => session.sign_out().await.unwrap_or(false),
        Err(_) => false,
    }
}

/// The session to end for `account` as it is stored now, taken out of the
/// runtime. A cached session for an identity the account no longer has is
/// dropped: signing it out would find no token of its own and end nothing.
async fn current_session(
    state: &AppState,
    path: &Path,
    account: &ServerAccount,
) -> Result<Arc<AccountSession>, String> {
    match state.server.remove(&account.id).await {
        Some(session) if session.serves(account) => Ok(session),
        _ => AccountSession::resume(account, token_store(state, path)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::fake::{file_store, Env, EMAIL, KEY, PASSWORD, TENANT};

    fn unlocked() -> AppState {
        let state = AppState::new();
        *state.vault_key.lock().unwrap() = Some(KEY);
        state
    }

    fn form(env: &Env) -> ServerAccountInput {
        ServerAccountInput {
            id: Some(env.account.id.clone()),
            name: env.account.name.clone(),
            url: env.account.url.clone(),
            tenant: TENANT.to_string(),
            email: EMAIL.to_string(),
            allow_insecure_http: false,
            extra_ca_pem: None,
        }
    }

    #[tokio::test]
    async fn every_command_needs_an_unlocked_vault() {
        let env = Env::new().await;
        let state = AppState::new();
        let id = env.account.id.as_str();
        assert_eq!(
            account_list_impl(&state, &env.path).unwrap_err(),
            "vault is locked"
        );
        assert!(account_save_impl(&state, &env.path, form(&env))
            .await
            .is_err());
        assert!(account_delete_impl(&state, &env.path, id).await.is_err());
        assert!(sign_in_impl(&state, &env.path, id, PASSWORD.to_string())
            .await
            .is_err());
        assert!(sign_out_impl(&state, &env.path, id).await.is_err());
        assert!(list_connections_impl(&state, &env.path, id).await.is_err());
        env.fake.with(|s| assert_eq!(s.logins, 0));
    }

    #[tokio::test]
    async fn signing_in_lists_the_servers_connections() {
        let env = Env::new().await;
        let state = unlocked();
        let id = env.account.id.as_str();

        let err = list_connections_impl(&state, &env.path, id)
            .await
            .unwrap_err();
        assert!(err.contains("Sign in"), "{err}");

        let view = sign_in_impl(&state, &env.path, id, PASSWORD.to_string())
            .await
            .unwrap();
        assert!(view.signed_in);
        assert!(account_list_impl(&state, &env.path).unwrap()[0].signed_in);

        let connections = list_connections_impl(&state, &env.path, id).await.unwrap();
        assert_eq!(
            connections,
            vec![RemoteConnectionView {
                id: "c1".to_string(),
                name: "Orders".to_string(),
                tags: vec!["prod".to_string()],
                deployment_kind: "replica_set".to_string(),
                op_classes: vec!["read".to_string(), "write".to_string()],
            }]
        );
        // The session made at sign-in is reused: no refresh was needed.
        env.fake.with(|s| assert_eq!(s.refreshes, 0));
    }

    #[tokio::test]
    async fn a_failed_sign_in_leaves_the_account_signed_out() {
        let env = Env::new().await;
        let state = unlocked();
        let err = sign_in_impl(&state, &env.path, &env.account.id, "nope".to_string())
            .await
            .unwrap_err();
        assert!(err.contains("did not accept"), "{err}");
        assert!(!account_list_impl(&state, &env.path).unwrap()[0].signed_in);
    }

    #[tokio::test]
    async fn signing_in_again_ends_the_previous_session() {
        let env = Env::new().await;
        let state = unlocked();
        let id = env.account.id.as_str();
        sign_in_impl(&state, &env.path, id, PASSWORD.to_string())
            .await
            .unwrap();
        sign_in_impl(&state, &env.path, id, PASSWORD.to_string())
            .await
            .unwrap();
        env.fake.with(|s| {
            assert_eq!(s.logouts, 1);
            assert_eq!(s.live_families(), 1);
        });
        list_connections_impl(&state, &env.path, id).await.unwrap();
    }

    #[tokio::test]
    async fn signing_out_ends_the_session_everywhere() {
        let env = Env::new().await;
        let state = unlocked();
        let id = env.account.id.as_str();
        sign_in_impl(&state, &env.path, id, PASSWORD.to_string())
            .await
            .unwrap();

        let result = sign_out_impl(&state, &env.path, id).await.unwrap();
        assert!(result.ended_on_server);
        assert!(!account_list_impl(&state, &env.path).unwrap()[0].signed_in);
        env.fake.with(|s| assert_eq!(s.live_families(), 0));
        assert!(list_connections_impl(&state, &env.path, id).await.is_err());

        // Signing out an account that is not signed in is not an error.
        assert!(
            sign_out_impl(&state, &env.path, id)
                .await
                .unwrap()
                .ended_on_server
        );
    }

    #[tokio::test]
    async fn renaming_keeps_the_session_but_changing_identity_ends_it() {
        let env = Env::new().await;
        let state = unlocked();
        let id = env.account.id.as_str();
        sign_in_impl(&state, &env.path, id, PASSWORD.to_string())
            .await
            .unwrap();

        let renamed = ServerAccountInput {
            name: "Acme prod".to_string(),
            ..form(&env)
        };
        let view = account_save_impl(&state, &env.path, renamed).await.unwrap();
        assert!(view.signed_in);
        assert_eq!(view.name, "Acme prod");
        list_connections_impl(&state, &env.path, id).await.unwrap();

        let other_user = ServerAccountInput {
            email: "dba@acme.test".to_string(),
            ..form(&env)
        };
        let view = account_save_impl(&state, &env.path, other_user)
            .await
            .unwrap();
        assert!(!view.signed_in);
        env.fake.with(|s| {
            assert_eq!(s.logouts, 1);
            assert_eq!(s.live_families(), 0);
        });
        assert!(list_connections_impl(&state, &env.path, id).await.is_err());
    }

    #[tokio::test]
    async fn deleting_a_signed_in_account_ends_its_session() {
        let env = Env::new().await;
        let state = unlocked();
        let id = env.account.id.as_str();
        sign_in_impl(&state, &env.path, id, PASSWORD.to_string())
            .await
            .unwrap();

        account_delete_impl(&state, &env.path, id).await.unwrap();
        assert!(account_list_impl(&state, &env.path).unwrap().is_empty());
        env.fake.with(|s| assert_eq!(s.live_families(), 0));
        // Deleting what is already gone is fine.
        account_delete_impl(&state, &env.path, id).await.unwrap();
    }

    #[tokio::test]
    async fn a_new_account_is_saved_signed_out() {
        let env = Env::new().await;
        let state = unlocked();
        let fresh = ServerAccountInput {
            id: None,
            name: "Second".to_string(),
            ..form(&env)
        };
        let view = account_save_impl(&state, &env.path, fresh).await.unwrap();
        assert!(!view.signed_in);
        assert_ne!(view.id, env.account.id);
        assert_eq!(account_list_impl(&state, &env.path).unwrap().len(), 2);
    }

    // Another instance repointed the account (here, the same server reached by
    // another name) and signed in again, while this one still caches the old
    // session. Signing out here must end the sign-in that is current.
    #[tokio::test]
    async fn signing_out_ends_the_current_session_not_a_stale_cached_one() {
        let env = Env::new().await;
        let here = unlocked();
        let elsewhere = unlocked();
        let id = env.account.id.as_str();
        sign_in_impl(&here, &env.path, id, PASSWORD.to_string())
            .await
            .unwrap();

        let moved = ServerAccountInput {
            url: env.account.url.replace("127.0.0.1", "localhost"),
            ..form(&env)
        };
        account_save_impl(&elsewhere, &env.path, moved)
            .await
            .unwrap();
        sign_in_impl(&elsewhere, &env.path, id, PASSWORD.to_string())
            .await
            .unwrap();
        env.fake.with(|s| assert_eq!(s.live_families(), 1));

        let result = sign_out_impl(&here, &env.path, id).await.unwrap();
        assert!(result.ended_on_server);
        assert!(!account_list_impl(&here, &env.path).unwrap()[0].signed_in);
        env.fake.with(|s| {
            assert_eq!(
                s.live_families(),
                0,
                "the current sign-in is still live on the server"
            )
        });
    }

    // A sign-in can store its session after a delete has started. The delete
    // must end whatever session the account holds when it is removed.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn deleting_ends_a_session_stored_while_the_delete_waited() {
        let env = Env::new().await;
        let state = Arc::new(unlocked());

        // A live session for this account, obtained through a separate store.
        let other = tempfile::tempdir().unwrap();
        let other_path = other.path().join(accounts::ACCOUNTS_FILE_NAME);
        std::fs::copy(&env.path, &other_path).unwrap();
        if let Err(e) =
            AccountSession::sign_in(&env.account, PASSWORD, file_store(&other_path)).await
        {
            panic!("sign in failed: {e}");
        }
        let token = accounts::find(&other_path, &KEY, &env.account.id)
            .unwrap()
            .refresh_token
            .unwrap();

        // The delete has to wait for the accounts lock...
        let held = accounts::lock(&env.path).unwrap();
        let deleting = {
            let state = state.clone();
            let path = env.path.clone();
            let id = env.account.id.clone();
            tokio::spawn(async move { account_delete_impl(&state, &path, &id).await })
        };
        tokio::time::sleep(Duration::from_millis(200)).await;
        // ...while the session is stored under it, as a sign-in finishing then does.
        let mut all = accounts::load(&env.path, &KEY).unwrap();
        all[0].refresh_token = Some(token);
        accounts::save(&env.path, &KEY, &all).unwrap();
        drop(held);

        deleting.await.unwrap().unwrap();
        assert!(account_list_impl(&state, &env.path).unwrap().is_empty());
        env.fake.with(|s| {
            assert_eq!(
                s.live_families(),
                0,
                "the deleted account's session is still live on the server"
            )
        });
    }

    // An edit waiting on the old identity's sign-out can outlive a vault reset
    // in another window. It must not then write the accounts file under the
    // key the reset discarded: the new vault could not read its own accounts.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_edit_that_outlives_a_vault_reset_writes_nothing() {
        let env = Env::new().await;
        let state = Arc::new(unlocked());
        // Signing out then needs a refresh, which the fake holds for a while.
        env.fake.with(|s| s.access_ttl_secs = -1);
        sign_in_impl(&state, &env.path, &env.account.id, PASSWORD.to_string())
            .await
            .unwrap();
        env.fake.with(|s| {
            s.access_ttl_secs = 3600;
            s.refresh_delay = Duration::from_millis(400);
        });

        let editing = {
            let state = state.clone();
            let path = env.path.clone();
            let moved = ServerAccountInput {
                email: "dba@acme.test".to_string(),
                ..form(&env)
            };
            tokio::spawn(async move { account_save_impl(&state, &path, moved).await })
        };
        tokio::time::sleep(Duration::from_millis(150)).await;
        // Another window resets the vault and sets up a new one.
        std::fs::remove_file(&env.path).unwrap();
        *state.vault_key.lock().unwrap() = Some([9; 32]);

        let result = editing.await.unwrap();
        assert!(result.is_err(), "the edit went through: {result:?}");
        assert!(
            !env.path.exists(),
            "the edit recreated the accounts file under the discarded key"
        );
    }

    // Two windows signing in to the same signed-out account at once each get a
    // server session; only one can be stored, and the other must be ended.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_first_sign_ins_leave_one_live_session() {
        let env = Env::new().await;
        let a = Arc::new(unlocked());
        let b = Arc::new(unlocked());
        env.fake
            .with(|s| s.login_delay = Duration::from_millis(200));
        let sign_in = |state: Arc<AppState>| {
            let path = env.path.clone();
            let id = env.account.id.clone();
            tokio::spawn(
                async move { sign_in_impl(&state, &path, &id, PASSWORD.to_string()).await },
            )
        };
        let (x, y) = (sign_in(a.clone()), sign_in(b.clone()));
        x.await.unwrap().unwrap();
        y.await.unwrap().unwrap();

        env.fake.with(|s| {
            assert_eq!(s.logins, 2);
            assert_eq!(
                s.live_families(),
                1,
                "a displaced sign-in is still live on the server"
            );
        });
        // Both windows go on working with the session that is stored.
        list_connections_impl(&a, &env.path, &env.account.id)
            .await
            .unwrap();
        list_connections_impl(&b, &env.path, &env.account.id)
            .await
            .unwrap();
    }

    // One unreachable server must not use up the reset's time for everyone:
    // every other account's session still gets ended before its token is gone.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_reset_reaches_every_account_even_if_one_server_hangs() {
        let env = Env::new().await;
        let state = unlocked();
        sign_in_impl(&state, &env.path, &env.account.id, PASSWORD.to_string())
            .await
            .unwrap();

        // A server that accepts connections and never answers.
        let hung = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let hung_url = format!("http://{}", hung.local_addr().unwrap());
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((socket, _)) = hung.accept().await {
                held.push(socket);
            }
        });
        // Listed first, so it would be first in line for the accounts lock.
        accounts::update(&env.path, &KEY, |all| {
            let mut stuck = ServerAccountInput {
                id: None,
                name: "Hung".to_string(),
                url: hung_url,
                tenant: TENANT.to_string(),
                email: EMAIL.to_string(),
                allow_insecure_http: false,
                extra_ca_pem: None,
            }
            .into_account()?;
            stuck.refresh_token = Some("refresh-for-the-hung-server".to_string());
            all.insert(0, stuck);
            Ok(())
        })
        .unwrap();

        let started = std::time::Instant::now();
        sign_out_all_within(&state, &env.path, Duration::from_millis(500)).await;
        env.fake.with(|s| {
            assert_eq!(
                s.live_families(),
                0,
                "the reachable server's session was never ended"
            )
        });
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn a_vault_reset_ends_stored_sessions_first() {
        let env = Env::new().await;
        let state = unlocked();
        sign_in_impl(&state, &env.path, &env.account.id, PASSWORD.to_string())
            .await
            .unwrap();

        sign_out_all_best_effort(&state, &env.path).await;
        env.fake.with(|s| assert_eq!(s.live_families(), 0));
        assert!(!account_list_impl(&state, &env.path).unwrap()[0].signed_in);

        // Locked, there is nothing it can read; it still drops live sessions.
        let locked = AppState::new();
        sign_out_all_best_effort(&locked, &env.path).await;
    }
}
