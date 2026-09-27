//! A signed-in MQLens Server session, and the calls made through it.
//!
//! The access token lives only in memory. The refresh token lives only in the
//! encrypted accounts file, and is read from there, under the file's
//! cross-process lock, every time it is used.
//!
//! That rule is what keeps a refresh token from ever being presented twice. The
//! server treats a spent refresh token presented again as theft: it revokes the
//! token family and cuts every access token the user holds, their other logins
//! included. Two refreshes of one token race straight into that, whether they
//! come from two tasks here or from two MQLens instances. So every refresh:
//!
//! 1. waits for this session's token lock, and reuses a token another task
//!    obtained while it waited;
//! 2. takes the accounts file lock and reads the current refresh token from
//!    disk, so a token another instance rotated to is the one used;
//! 3. sends it, and stores the successor before the new access token is used,
//!    all before the file lock is released.
//!
//! A refresh the server rejects as unauthenticated ends the session: the stored
//! token is dead, so it is cleared and the user signs in again. Any other
//! failure leaves the stored token in place, since the server most likely never
//! spent it, so a network blip does not sign anyone out. If the server did
//! spend it, the next refresh is refused and the session ends then.

use crate::server::accounts::{self, AuthMethod, ServerAccount};
use crate::server::channel::{self, client};
use crate::server::errors;
use crate::server::pb::mqlens::v1::auth_service_client::AuthServiceClient;
use crate::server::pb::mqlens::v1::{
    login_request, LocalCreds, LoginRequest, LoginResponse, LogoutRequest, Principal,
    RefreshRequest,
};
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tonic::metadata::MetadataValue;
use tonic::transport::Channel;
use tonic::{Request, Response, Status};
use zeroize::Zeroizing;

/// An access token with less validity left than this is refreshed before use,
/// so a call does not set out with a token that expires on the way.
pub(crate) const REFRESH_MARGIN_SECS: i64 = 60;
const AUTH_RPC_TIMEOUT: Duration = Duration::from_secs(30);
/// Deadline for a call through `AccountSession::call`.
pub(crate) const CALL_TIMEOUT: Duration = if cfg!(test) {
    Duration::from_secs(2)
} else {
    Duration::from_secs(30)
};
const LOGOUT_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) const SESSION_ENDED: &str = "Your MQLens Server session has ended. Sign in again.";

/// Where a session's refresh token is kept.
///
/// A token belongs to an identity, not only to an account id: another MQLens
/// instance can repoint the account at a different server or user at any time.
/// So both calls take the account as the session knows it, and act only while
/// the stored account is still that identity (`ServerAccount::same_identity`).
/// Otherwise `read` finds nothing, storing a token fails, and clearing one
/// does nothing, since the token there now belongs to someone else.
pub(crate) trait TokenStore: Send + Sync + 'static {
    /// Blocks until the caller holds the store's cross-process lock; released
    /// when the returned guard drops. Not re-entrant.
    fn lock(&self) -> Result<Box<dyn Send>, String>;
    /// The stored refresh token. The caller holds the lock.
    fn read(&self, account: &ServerAccount) -> Result<Option<Zeroizing<String>>, String>;
    /// Replaces the stored refresh token. The caller holds the lock.
    fn write(&self, account: &ServerAccount, token: Option<&str>) -> Result<(), String>;
    /// Stores `token` and returns the one it displaced, if any: another
    /// sign-in to the same account finished first, and its server session
    /// must now be ended, since nothing stores its token any more. The caller
    /// holds the lock.
    fn replace(
        &self,
        account: &ServerAccount,
        token: &str,
    ) -> Result<Option<Zeroizing<String>>, String> {
        let previous = self.read(account)?;
        self.write(account, Some(token))?;
        Ok(previous.filter(|p| p.as_str() != token))
    }
}

pub(crate) const ACCOUNT_CHANGED: &str =
    "This MQLens Server account was changed to another server or user. Sign in again.";

/// The vault key, or why it is not available.
pub(crate) type KeySource = Arc<dyn Fn() -> Result<[u8; 32], String> + Send + Sync>;

/// The accounts file as a token store.
pub(crate) struct FileTokenStore {
    path: PathBuf,
    key: KeySource,
}

impl FileTokenStore {
    pub(crate) fn new(path: PathBuf, key: KeySource) -> Self {
        Self { path, key }
    }
}

impl TokenStore for FileTokenStore {
    fn lock(&self) -> Result<Box<dyn Send>, String> {
        Ok(Box::new(accounts::lock(&self.path)?))
    }

    fn read(&self, account: &ServerAccount) -> Result<Option<Zeroizing<String>>, String> {
        let key = (self.key)()?;
        Ok(accounts::load(&self.path, &key)?
            .into_iter()
            .find(|a| a.id == account.id && a.same_identity(account))
            .and_then(|a| a.refresh_token)
            .map(Zeroizing::new))
    }

    fn write(&self, account: &ServerAccount, token: Option<&str>) -> Result<(), String> {
        let key = (self.key)()?;
        let mut all = accounts::load(&self.path, &key)?;
        let stored = all.iter_mut().find(|a| a.id == account.id);
        match (stored, token) {
            (Some(stored), _) if stored.same_identity(account) => {
                stored.refresh_token = token.map(str::to_string);
                accounts::save(&self.path, &key, &all)
            }
            // Clearing: the session is gone, or belongs to someone else now.
            (_, None) => Ok(()),
            (None, Some(_)) => Err("This MQLens Server account has been removed".to_string()),
            (Some(_), Some(_)) => Err(ACCOUNT_CHANGED.to_string()),
        }
    }
}

#[derive(Default)]
struct Tokens {
    access: Option<Zeroizing<String>>,
    /// Unix seconds.
    expires_at: i64,
    /// Bumped whenever the access token changes, so a caller whose token was
    /// rejected can tell whether someone has already replaced it.
    generation: u64,
    principal: Option<Principal>,
}

pub(crate) struct AccountSession {
    /// The account as it was when the session started, without its token. The
    /// session only ever serves that identity.
    account: ServerAccount,
    channel: Channel,
    store: Arc<dyn TokenStore>,
    tokens: tokio::sync::Mutex<Tokens>,
    ended: AtomicBool,
}

impl AccountSession {
    fn new(account: &ServerAccount, store: Arc<dyn TokenStore>) -> Result<Self, String> {
        Ok(Self {
            account: ServerAccount {
                refresh_token: None,
                ..account.clone()
            },
            channel: channel::channel(&account.channel_config())?,
            store,
            tokens: tokio::sync::Mutex::new(Tokens::default()),
            ended: AtomicBool::new(false),
        })
    }

    pub(crate) fn account_id(&self) -> &str {
        &self.account.id
    }

    /// Whether this session belongs to `account` as it is now: the same
    /// account, still pointing at the same server and user.
    pub(crate) fn serves(&self, account: &ServerAccount) -> bool {
        self.account.id == account.id && self.account.same_identity(account)
    }

    /// True once the session can no longer make calls: signed out, or its
    /// stored token was refused or could not be kept.
    pub(crate) fn is_ended(&self) -> bool {
        self.ended.load(Ordering::SeqCst)
    }

    pub(crate) async fn principal(&self) -> Option<Principal> {
        self.tokens.lock().await.principal.clone()
    }

    /// A session for an account's stored token. Makes no call: the first call
    /// through it refreshes. Must run inside a tokio runtime.
    pub(crate) fn resume(
        account: &ServerAccount,
        store: Arc<dyn TokenStore>,
    ) -> Result<Arc<Self>, String> {
        Ok(Arc::new(Self::new(account, store)?))
    }

    /// Signs in with the account's email and `password`, storing the new
    /// session's refresh token over any stored before.
    pub(crate) async fn sign_in(
        account: &ServerAccount,
        password: &str,
        store: Arc<dyn TokenStore>,
    ) -> Result<Arc<Self>, String> {
        if account.auth != AuthMethod::Password {
            return Err("This MQLens Server account does not sign in with a password".to_string());
        }
        if password.is_empty() {
            return Err("Enter your MQLens Server password".to_string());
        }
        let session = Self::new(account, store)?;

        let mut request = Request::new(LoginRequest {
            tenant: account.tenant.clone(),
            login: Some(login_request::Login::Local(LocalCreds {
                email: account.email.clone(),
                password: password.to_string(),
            })),
        });
        request.set_timeout(AUTH_RPC_TIMEOUT);
        let login = client!(AuthServiceClient, session.channel.clone())
            .login(request)
            .await
            .map_err(|status| login_error(&status))?
            .into_inner();

        let stored = {
            let store = session.store.clone();
            let who = session.account.clone();
            let refresh = Zeroizing::new(login.refresh_token.clone());
            blocking(move || {
                let _lock = store.lock()?;
                store.replace(&who, &refresh)
            })
            .await
        };
        match stored {
            Ok(Some(displaced)) => {
                // A concurrent sign-in stored first; its session is ours to end.
                let _ = logout_with_refresh_token(&session.channel, &displaced).await;
            }
            Ok(None) => {}
            Err(e) => {
                // A session nobody holds must not stay usable on the server.
                let _ = logout(&session.channel, &login.access_token, &login.refresh_token).await;
                return Err(format!("Could not save the MQLens Server session: {e}"));
            }
        }
        session.adopt(login).await;
        Ok(Arc::new(session))
    }

    async fn adopt(&self, login: LoginResponse) {
        let mut tokens = self.tokens.lock().await;
        tokens.access = Some(Zeroizing::new(login.access_token));
        tokens.expires_at = login.expires_at;
        if login.principal.is_some() {
            tokens.principal = login.principal;
        }
        tokens.generation += 1;
    }

    /// Makes one unary call with the session's access token. A call refused as
    /// unauthenticated refreshes once, unless another task already has, and is
    /// retried once; refused again, the session ends.
    pub(crate) async fn call<M, R, F, Fut>(&self, message: M, rpc: F) -> Result<R, String>
    where
        M: Clone,
        F: Fn(Channel, Request<M>) -> Fut,
        Fut: Future<Output = Result<Response<R>, Status>>,
    {
        let (token, generation) = self.access_token(None).await?;
        match rpc(
            self.channel.clone(),
            with_deadline(authorized(message.clone(), &token)?),
        )
        .await
        {
            Ok(response) => return Ok(response.into_inner()),
            Err(status) if errors::is_unauthenticated(&status) => {}
            Err(status) => return Err(errors::describe(&status)),
        }
        let (token, _) = self.access_token(Some(generation)).await?;
        match rpc(
            self.channel.clone(),
            with_deadline(authorized(message, &token)?),
        )
        .await
        {
            Ok(response) => Ok(response.into_inner()),
            Err(status) if errors::is_unauthenticated(&status) => {
                self.end_locally().await;
                Err(errors::with_correlation(SESSION_ENDED.to_string(), &status))
            }
            Err(status) => Err(errors::describe(&status)),
        }
    }

    /// A usable access token and its generation. `rejected` is the generation
    /// of a token the server just refused: if it is still current, it is
    /// replaced even though it has not expired.
    async fn access_token(
        &self,
        rejected: Option<u64>,
    ) -> Result<(Zeroizing<String>, u64), String> {
        let mut tokens = self.tokens.lock().await;
        if self.is_ended() {
            return Err(SESSION_ENDED.to_string());
        }
        let reusable = match &tokens.access {
            Some(_) if rejected == Some(tokens.generation) => false,
            Some(_) => tokens.expires_at - unix_now() > REFRESH_MARGIN_SECS,
            None => false,
        };
        if !reusable {
            self.refresh_locked(&mut tokens).await?;
        }
        match &tokens.access {
            Some(access) => Ok((access.clone(), tokens.generation)),
            None => Err(SESSION_ENDED.to_string()),
        }
    }

    /// Exchanges the stored refresh token for a new pair. The caller holds the
    /// token lock; this takes the file lock for the whole exchange.
    async fn refresh_locked(&self, tokens: &mut Tokens) -> Result<(), String> {
        tokens.access = None;
        let store = self.store.clone();
        let who = self.account.clone();
        let (lock, stored) = blocking(move || {
            let lock = store.lock()?;
            let stored = store.read(&who)?;
            Ok((lock, stored))
        })
        .await?;
        let Some(refresh) = stored else {
            // Signed out elsewhere, or the account was edited to another identity.
            self.ended.store(true, Ordering::SeqCst);
            return Err(SESSION_ENDED.to_string());
        };

        let result = match refresh_rpc(&self.channel, &refresh).await {
            Ok(fresh) => {
                let store = self.store.clone();
                let who = self.account.clone();
                let successor = Zeroizing::new(fresh.refresh_token.clone());
                match blocking(move || store.write(&who, Some(&successor))).await {
                    Ok(()) => {
                        tokens.access = Some(Zeroizing::new(fresh.access_token));
                        tokens.expires_at = fresh.expires_at;
                        if fresh.principal.is_some() {
                            tokens.principal = fresh.principal;
                        }
                        tokens.generation += 1;
                        Ok(())
                    }
                    Err(e) => {
                        // The stored token is spent and its successor cannot be
                        // kept, so nothing could resume this session: end it on
                        // the server too rather than leave it live and unheld.
                        let _ =
                            logout(&self.channel, &fresh.access_token, &fresh.refresh_token).await;
                        self.ended.store(true, Ordering::SeqCst);
                        Err(format!(
                            "Could not save the refreshed MQLens Server session, so it was ended: {e}. Sign in again."
                        ))
                    }
                }
            }
            Err(status) if errors::is_unauthenticated(&status) => {
                let store = self.store.clone();
                let who = self.account.clone();
                let _ = blocking(move || store.write(&who, None)).await;
                self.ended.store(true, Ordering::SeqCst);
                Err(errors::with_correlation(SESSION_ENDED.to_string(), &status))
            }
            Err(status) => Err(errors::describe(&status)),
        };
        drop(lock);
        result
    }

    /// Ends the session here after the server refused a freshly refreshed
    /// token, which only happens when the account itself has lost access.
    async fn end_locally(&self) {
        self.ended.store(true, Ordering::SeqCst);
        let mut tokens = self.tokens.lock().await;
        tokens.access = None;
        tokens.generation += 1;
        let store = self.store.clone();
        let who = self.account.clone();
        let _ = blocking(move || {
            let _lock = store.lock()?;
            store.write(&who, None)
        })
        .await;
    }

    /// Signs out: ends the session on the server when it can be reached, and
    /// always here. Returns false only when a stored session may still be
    /// usable on the server because the server could not confirm its end.
    pub(crate) async fn sign_out(&self) -> Result<bool, String> {
        let mut tokens = self.tokens.lock().await;
        self.ended.store(true, Ordering::SeqCst);
        let store = self.store.clone();
        let who = self.account.clone();
        let (lock, stored) = blocking(move || {
            let lock = store.lock()?;
            let stored = store.read(&who)?;
            Ok((lock, stored))
        })
        .await?;

        let mut ended_on_server = true;
        if let Some(refresh) = stored {
            let live_access = tokens
                .access
                .clone()
                .filter(|_| tokens.expires_at > unix_now());
            ended_on_server = match live_access {
                Some(access) => logout(&self.channel, &access, &refresh).await.is_ok(),
                None => logout_with_refresh_token(&self.channel, &refresh).await,
            };
        }

        let store = self.store.clone();
        let who = self.account.clone();
        let cleared = blocking(move || store.write(&who, None)).await;
        drop(lock);
        tokens.access = None;
        tokens.generation += 1;
        cleared.map(|()| ended_on_server)
    }
}

/// A server can accept the connection and then never answer; the connect
/// timeout does not cover that, so every call carries its own deadline.
fn with_deadline<M>(mut request: Request<M>) -> Request<M> {
    request.set_timeout(CALL_TIMEOUT);
    request
}

fn authorized<M>(message: M, access_token: &str) -> Result<Request<M>, String> {
    let value = MetadataValue::try_from(format!("Bearer {access_token}"))
        .map_err(|_| "MQLens Server issued an access token that cannot be sent".to_string())?;
    let mut request = Request::new(message);
    request.metadata_mut().insert("authorization", value);
    Ok(request)
}

pub(crate) async fn refresh_rpc(
    channel: &Channel,
    refresh_token: &str,
) -> Result<LoginResponse, Status> {
    let mut request = Request::new(RefreshRequest {
        refresh_token: refresh_token.to_string(),
    });
    request.set_timeout(AUTH_RPC_TIMEOUT);
    client!(AuthServiceClient, channel.clone())
        .refresh(request)
        .await
        .map(Response::into_inner)
}

async fn logout(channel: &Channel, access_token: &str, refresh_token: &str) -> Result<(), Status> {
    let mut request = authorized(
        LogoutRequest {
            refresh_token: refresh_token.to_string(),
        },
        access_token,
    )
    .map_err(Status::internal)?;
    request.set_timeout(LOGOUT_TIMEOUT);
    client!(AuthServiceClient, channel.clone())
        .logout(request)
        .await
        .map(|_| ())
}

/// Ends the server session behind `refresh_token` for an account that no
/// longer stores it, such as one just deleted. Best effort; returns whether the
/// server confirmed.
pub(crate) async fn revoke(account: &ServerAccount, refresh_token: &str) -> bool {
    match channel::channel(&account.channel_config()) {
        Ok(channel) => logout_with_refresh_token(&channel, refresh_token).await,
        Err(_) => false,
    }
}

/// Logout needs an access token; a refresh gets one, and the refresh token it
/// spends is being thrown away regardless.
async fn logout_with_refresh_token(channel: &Channel, refresh_token: &str) -> bool {
    match refresh_rpc(channel, refresh_token).await {
        Ok(fresh) => logout(channel, &fresh.access_token, &fresh.refresh_token)
            .await
            .is_ok(),
        Err(_) => false,
    }
}

fn login_error(status: &Status) -> String {
    if errors::is_unauthenticated(status) {
        errors::with_correlation(
            "MQLens Server did not accept this email and password for this tenant".to_string(),
            status,
        )
    } else {
        errors::describe(status)
    }
}

/// Runs file and lock work off the async executor.
pub(crate) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| format!("MQLens Server session task failed: {e}"))?
}

pub(crate) fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::accounts::ServerAccountInput;
    use crate::server::fake::{file_store, list_connections, Env, KEY, PASSWORD, TENANT};
    use tonic::Code;

    /// What another MQLens instance does when the user points this account at
    /// a different user: the stored session belongs to the old one and goes.
    fn change_identity(env: &Env) {
        accounts::save_account(
            &env.path,
            &KEY,
            ServerAccountInput {
                id: Some(env.account.id.clone()),
                name: env.account.name.clone(),
                url: env.account.url.clone(),
                tenant: TENANT.to_string(),
                email: "dba@acme.test".to_string(),
                allow_insecure_http: false,
                extra_ca_pem: None,
            },
        )
        .unwrap();
    }

    fn store_token(env: &Env, token: &str) {
        accounts::update(&env.path, &KEY, |all| {
            all.iter_mut()
                .find(|a| a.id == env.account.id)
                .unwrap()
                .refresh_token = Some(token.to_string());
            Ok(())
        })
        .unwrap();
    }

    #[tokio::test]
    async fn an_account_edited_during_sign_in_keeps_no_token_from_the_old_identity() {
        let env = Env::new().await;
        env.fake
            .with(|s| s.login_delay = Duration::from_millis(300));
        let signing_in = {
            let account = env.account.clone();
            let store = env.store();
            tokio::spawn(async move { AccountSession::sign_in(&account, PASSWORD, store).await })
        };
        tokio::time::sleep(Duration::from_millis(100)).await;
        change_identity(&env);

        match signing_in.await.unwrap() {
            Ok(_) => panic!("signed in although the account changed to another user"),
            Err(e) => assert!(e.contains("changed"), "{e}"),
        }
        assert_eq!(env.stored_token(), None);
        // The login the old identity got is not left usable on the server.
        env.fake.with(|s| {
            assert_eq!(s.logouts, 1);
            assert_eq!(s.live_families(), 0);
        });
    }

    #[tokio::test]
    async fn an_old_session_never_presents_another_identitys_token() {
        let env = Env::new().await;
        let old = signed_in(&env).await;
        change_identity(&env);
        store_token(&env, "refresh-for-the-new-identity");
        env.fake.revoke_access_tokens();
        let refreshes = env.fake.with(|s| s.refreshes);

        let err = list_connections(&old).await.unwrap_err();
        assert!(err.contains("Sign in again"), "{err}");
        assert!(old.is_ended());
        assert_eq!(
            env.fake.with(|s| s.refreshes),
            refreshes,
            "the old session sent a refresh token that is not its own"
        );
        assert_eq!(
            env.stored_token().as_deref(),
            Some("refresh-for-the-new-identity"),
            "the old session cleared the new identity's session"
        );
    }

    async fn signed_in(env: &Env) -> Arc<AccountSession> {
        match AccountSession::sign_in(&env.account, PASSWORD, env.store()).await {
            Ok(session) => session,
            Err(e) => panic!("sign in failed: {e}"),
        }
    }

    #[tokio::test]
    async fn signing_in_stores_only_an_encrypted_refresh_token() {
        let env = Env::new().await;
        let session = signed_in(&env).await;

        let stored = env.stored_token().expect("a stored refresh token");
        let raw = std::fs::read(&env.path).unwrap();
        assert!(
            !String::from_utf8_lossy(&raw).contains(&stored),
            "stored encrypted"
        );

        assert_eq!(list_connections(&session).await.unwrap()[0].id, "c1");
        assert_eq!(
            session.principal().await.unwrap().email,
            crate::server::fake::EMAIL
        );
        env.fake.with(|s| {
            assert_eq!(s.logins, 1);
            assert_eq!(s.refreshes, 0);
        });
    }

    // A server can accept the connection and then never answer a call. The
    // call gives up rather than leaving the command pending forever, and a slow
    // server is no reason to end the session.
    #[tokio::test]
    async fn a_call_the_server_never_answers_times_out() {
        let env = Env::new().await;
        let session = signed_in(&env).await;
        env.fake.with(|s| s.list_delay = CALL_TIMEOUT * 3);

        let started = std::time::Instant::now();
        let result = list_connections(&session).await;
        assert!(
            started.elapsed() < CALL_TIMEOUT * 2,
            "the call waited {:?}",
            started.elapsed()
        );
        let err = result.unwrap_err();
        assert!(err.contains("did not answer in time"), "{err}");
        assert!(!session.is_ended());
    }

    #[tokio::test]
    async fn a_rejected_password_stores_nothing() {
        let env = Env::new().await;
        let err = match AccountSession::sign_in(&env.account, "wrong", env.store()).await {
            Err(e) => e,
            Ok(_) => panic!("signed in with the wrong password"),
        };
        assert!(
            err.contains("did not accept this email and password"),
            "{err}"
        );
        assert_eq!(env.stored_token(), None);
    }

    #[tokio::test]
    async fn a_resumed_session_refreshes_once_and_stores_the_successor() {
        let env = Env::new().await;
        signed_in(&env).await;
        let first = env.stored_token().unwrap();

        let session = AccountSession::resume(&env.stored_account(), env.store()).unwrap();
        list_connections(&session).await.unwrap();
        list_connections(&session).await.unwrap();

        assert_ne!(env.stored_token().unwrap(), first);
        env.fake.with(|s| {
            assert_eq!(s.refreshes, 1);
            assert_eq!(s.reuse_detected, 0);
        });
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_calls_share_a_single_refresh() {
        let env = Env::new().await;
        signed_in(&env).await;
        let session = AccountSession::resume(&env.stored_account(), env.store()).unwrap();
        env.fake
            .with(|s| s.refresh_delay = Duration::from_millis(50));

        let calls: Vec<_> = (0..50)
            .map(|_| {
                let session = session.clone();
                tokio::spawn(async move { list_connections(&session).await })
            })
            .collect();
        for call in futures::future::join_all(calls).await {
            call.unwrap().unwrap();
        }
        env.fake.with(|s| {
            assert_eq!(s.refreshes, 1);
            assert_eq!(s.reuse_detected, 0);
            assert_eq!(s.list_calls, 50);
        });
    }

    // Two MQLens instances resuming one account share nothing but the accounts
    // file, which is what these two sessions share.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn two_instances_never_present_the_same_refresh_token() {
        let env = Env::new().await;
        signed_in(&env).await;
        let a = AccountSession::resume(&env.stored_account(), file_store(&env.path)).unwrap();
        let b = AccountSession::resume(&env.stored_account(), file_store(&env.path)).unwrap();
        env.fake
            .with(|s| s.refresh_delay = Duration::from_millis(50));

        let calls: Vec<_> = (0..20)
            .map(|i| {
                let session = if i % 2 == 0 { a.clone() } else { b.clone() };
                tokio::spawn(async move { list_connections(&session).await })
            })
            .collect();
        for call in futures::future::join_all(calls).await {
            call.unwrap().unwrap();
        }
        env.fake.with(|s| {
            assert_eq!(s.reuse_detected, 0);
            assert_eq!(s.refreshes, 2, "one per instance");
        });
    }

    // Keeps the two tests above honest: the fake does catch a token presented
    // twice, and punishes it the way the server does.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_fake_server_detects_a_reused_refresh_token() {
        let env = Env::new().await;
        signed_in(&env).await;
        let token = env.stored_token().unwrap();
        env.fake
            .with(|s| s.refresh_delay = Duration::from_millis(50));
        let channel = channel::channel(&env.account.channel_config()).unwrap();

        let (x, y) = tokio::join!(refresh_rpc(&channel, &token), refresh_rpc(&channel, &token));
        assert!(
            x.is_ok() != y.is_ok(),
            "exactly one refresh of a token succeeds"
        );
        env.fake.with(|s| {
            assert_eq!(s.reuse_detected, 1);
            assert_eq!(s.live_families(), 0);
        });
    }

    #[tokio::test]
    async fn an_access_token_near_expiry_is_refreshed_before_use() {
        let env = Env::new().await;
        env.fake
            .with(|s| s.access_ttl_secs = REFRESH_MARGIN_SECS / 2);
        let session = signed_in(&env).await;
        list_connections(&session).await.unwrap();
        env.fake.with(|s| {
            assert_eq!(s.refreshes, 1);
            assert_eq!(s.list_calls, 1);
        });
    }

    #[tokio::test]
    async fn a_refused_access_token_is_refreshed_once_and_the_call_retried() {
        let env = Env::new().await;
        let session = signed_in(&env).await;
        env.fake.revoke_access_tokens();
        list_connections(&session).await.unwrap();
        env.fake.with(|s| {
            assert_eq!(s.refreshes, 1);
            assert_eq!(s.list_calls, 1);
        });
    }

    #[tokio::test]
    async fn a_refused_refresh_ends_the_session() {
        let env = Env::new().await;
        let session = signed_in(&env).await;
        env.fake.forget_sessions();

        let err = list_connections(&session).await.unwrap_err();
        assert!(err.contains("Sign in again"), "{err}");
        assert!(session.is_ended());
        assert_eq!(env.stored_token(), None);

        let refreshes = env.fake.with(|s| s.refreshes);
        assert!(list_connections(&session).await.is_err());
        assert_eq!(
            env.fake.with(|s| s.refreshes),
            refreshes,
            "an ended session calls nothing"
        );
    }

    #[tokio::test]
    async fn a_failed_refresh_keeps_the_stored_session() {
        let env = Env::new().await;
        let session = signed_in(&env).await;
        let stored = env.stored_token().unwrap();
        env.fake.revoke_access_tokens();
        env.fake
            .with(|s| s.refresh_failures.push(Code::Unavailable));

        let err = list_connections(&session).await.unwrap_err();
        assert!(err.starts_with("MQLens Server is unavailable"), "{err}");
        assert!(!session.is_ended());
        assert_eq!(env.stored_token(), Some(stored));

        list_connections(&session).await.unwrap();
    }

    #[tokio::test]
    async fn signing_out_ends_the_session_on_the_server() {
        let env = Env::new().await;
        let session = signed_in(&env).await;
        assert!(session.sign_out().await.unwrap());
        assert_eq!(env.stored_token(), None);
        env.fake.with(|s| {
            assert_eq!(s.logouts, 1);
            assert_eq!(s.live_families(), 0);
        });
        assert!(list_connections(&session)
            .await
            .unwrap_err()
            .contains("Sign in again"));
    }

    #[tokio::test]
    async fn signing_out_with_an_expired_access_token_refreshes_to_log_out() {
        let env = Env::new().await;
        env.fake.with(|s| s.access_ttl_secs = -1);
        let session = signed_in(&env).await;
        env.fake.with(|s| s.access_ttl_secs = 3600);

        assert!(session.sign_out().await.unwrap());
        env.fake.with(|s| {
            assert_eq!(s.refreshes, 1);
            assert_eq!(s.logouts, 1);
            assert_eq!(s.live_families(), 0);
        });
    }

    #[tokio::test]
    async fn signing_out_while_the_server_fails_still_signs_out_here() {
        let env = Env::new().await;
        env.fake.with(|s| s.access_ttl_secs = -1);
        let session = signed_in(&env).await;
        env.fake
            .with(|s| s.refresh_failures.push(Code::Unavailable));

        assert!(!session.sign_out().await.unwrap());
        assert_eq!(env.stored_token(), None);
        assert!(session.is_ended());
    }

    #[tokio::test]
    async fn a_session_that_cannot_be_stored_is_ended_on_the_server() {
        let env = Env::new().await;
        let locked: Arc<dyn TokenStore> = Arc::new(FileTokenStore::new(
            env.path.clone(),
            Arc::new(|| Err("vault is locked".to_string())),
        ));
        let err = match AccountSession::sign_in(&env.account, PASSWORD, locked).await {
            Err(e) => e,
            Ok(_) => panic!("signed in without storing the session"),
        };
        assert!(err.contains("vault is locked"), "{err}");
        env.fake.with(|s| {
            assert_eq!(s.logouts, 1);
            assert_eq!(s.live_families(), 0);
        });
    }

    struct FailingWrites {
        inner: Arc<dyn TokenStore>,
        fail: AtomicBool,
    }

    impl TokenStore for FailingWrites {
        fn lock(&self) -> Result<Box<dyn Send>, String> {
            self.inner.lock()
        }
        fn read(&self, account: &ServerAccount) -> Result<Option<Zeroizing<String>>, String> {
            self.inner.read(account)
        }
        fn write(&self, account: &ServerAccount, token: Option<&str>) -> Result<(), String> {
            if self.fail.load(Ordering::SeqCst) {
                return Err("disk full".to_string());
            }
            self.inner.write(account, token)
        }
    }

    #[tokio::test]
    async fn a_refreshed_session_that_cannot_be_stored_is_ended() {
        let env = Env::new().await;
        let store = Arc::new(FailingWrites {
            inner: env.store(),
            fail: AtomicBool::new(false),
        });
        let session = match AccountSession::sign_in(
            &env.account,
            PASSWORD,
            store.clone() as Arc<dyn TokenStore>,
        )
        .await
        {
            Ok(session) => session,
            Err(e) => panic!("sign in failed: {e}"),
        };
        store.fail.store(true, Ordering::SeqCst);
        env.fake.revoke_access_tokens();

        let err = list_connections(&session).await.unwrap_err();
        assert!(err.contains("disk full"), "{err}");
        assert!(session.is_ended());
        env.fake.with(|s| {
            assert_eq!(s.reuse_detected, 0);
            assert_eq!(s.live_families(), 0);
        });
    }
}
