//! Database metadata and index management.

use crate::state::LockExt;
use crate::write_guard::{guard_writable, WriteOp};
use crate::{mock_db, AppState, CollectionInfo, IndexInfo};

pub async fn list_databases_impl(state: &AppState, id: &str) -> Result<Vec<String>, String> {
    let started = std::time::Instant::now();
    let result = list_databases_impl_inner(state, id).await;
    crate::audit::maybe_record_result(
        state,
        Some(id),
        None,
        None,
        "list_databases",
        crate::audit::OpClass::ReadHigh,
        None,
        started,
        &"listDatabases".to_string(),
        None,
        &result,
    );
    result
}

async fn list_databases_impl_inner(state: &AppState, id: &str) -> Result<Vec<String>, String> {
    let is_mock = {
        let mocks = state.mocks.lock_safe()?;
        *mocks
            .get(id)
            .ok_or_else(|| "Connection not found".to_string())?
    };

    if is_mock {
        return Ok(vec![
            "admin".to_string(),
            "config".to_string(),
            "local".to_string(),
            "sales_db".to_string(),
            "user_analytics".to_string(),
        ]);
    }

    let client = match crate::server::remote::route(state, id)? {
        crate::server::remote::Route::Local(client) => client,
        crate::server::remote::Route::Remote(conn) => {
            return crate::server::ops::metadata::list_databases(state, &conn).await;
        }
    };

    let dbs = client
        .list_database_names()
        .await
        .map_err(|e| format!("Failed to list databases: {}", e))?;

    Ok(dbs)
}

pub async fn list_collections_impl(
    state: &AppState,
    id: &str,
    db: &str,
) -> Result<Vec<CollectionInfo>, String> {
    let started = std::time::Instant::now();
    let result = list_collections_impl_inner(state, id, db).await;
    crate::audit::maybe_record_result(
        state,
        Some(id),
        Some(db),
        None,
        "list_collections",
        crate::audit::OpClass::ReadHigh,
        None,
        started,
        &format!("listCollections {db}"),
        None,
        &result,
    );
    result
}

/// The type of a collection the server would not describe.
///
/// Deliberately not "collection". Callers decide things from this field, and
/// the two are not the same claim: one says "this is an ordinary collection",
/// the other says "this server did not say". A copy reads it to refuse rather
/// than materialize what might be a view; the sidebar reads it as nothing in
/// particular and draws the generic icon, which is exactly right (#327 review).
pub const UNKNOWN_COLLECTION_TYPE: &str = "unknown";

async fn list_collections_impl_inner(
    state: &AppState,
    id: &str,
    db: &str,
) -> Result<Vec<CollectionInfo>, String> {
    let is_mock = {
        let mocks = state.mocks.lock_safe()?;
        *mocks
            .get(id)
            .ok_or_else(|| "Connection not found".to_string())?
    };

    if is_mock {
        return Ok(mock_db::get_mock_collections(db)
            .into_iter()
            .map(|(name, collection_type)| CollectionInfo {
                name,
                collection_type: collection_type.to_string(),
            })
            .collect());
    }

    let client = match crate::server::remote::route(state, id)? {
        crate::server::remote::Route::Local(client) => client,
        crate::server::remote::Route::Remote(conn) => {
            return crate::server::ops::metadata::list_collections(state, &conn, db).await;
        }
    };

    let database = client.database(db);
    match full_collection_specs(&database).await {
        Ok(collections) => Ok(collections),
        // Not every MongoDB-compatible service answers `listCollections` with
        // everything the driver's `CollectionSpecification` insists on. It
        // requires `type`, `options` and `info` — and `info.readOnly` as a bare
        // `bool`, with no default anywhere — while Azure Cosmos DB replies with
        // little more than the name. One missing field fails the whole listing,
        // so the tree came up empty while the database's own popover, which
        // asks `dbStats` instead, cheerfully reported the right count (#327).
        //
        // Names alone go out as `nameOnly: true`, which such a service can
        // satisfy, and the driver then reads back only the name. Collections
        // without their type are worth far more than no collections: everything
        // shows as a plain collection, so a view is mislabelled rather than
        // missing.
        Err(spec_error) => {
            let names = database.list_collection_names().await.map_err(|names_error| {
                // Both failures, because the first one is the interesting one:
                // it says what the server would not give, and the second only
                // confirms the fallback did not help either.
                format!("Failed to list collections: {spec_error}; names only: {names_error}")
            })?;
            Ok(names
                .into_iter()
                .map(|name| CollectionInfo {
                    name,
                    collection_type: UNKNOWN_COLLECTION_TYPE.to_string(),
                })
                .collect())
        }
    }
}

/// Every collection with its type, as `listCollections` reports it.
///
/// Preferred because the type is what lets the UI separate Collections from
/// Views and time-series; see the fallback above for when a server cannot
/// answer in that much detail.
async fn full_collection_specs(
    database: &mongodb::Database,
) -> Result<Vec<CollectionInfo>, String> {
    let mut cursor = database
        .list_collections()
        .await
        .map_err(|e| format!("Failed to list collections: {}", e))?;

    let mut collections = Vec::new();
    use futures::stream::StreamExt;
    while let Some(result) = cursor.next().await {
        let spec = result.map_err(|e| format!("Collection read error: {}", e))?;
        let collection_type = match spec.collection_type {
            mongodb::results::CollectionType::View => "view",
            mongodb::results::CollectionType::Timeseries => "timeseries",
            _ => "collection",
        };
        collections.push(CollectionInfo {
            name: spec.name,
            collection_type: collection_type.to_string(),
        });
    }

    Ok(collections)
}

pub async fn list_indexes_impl(
    state: &AppState,
    id: &str,
    db: &str,
    collection: &str,
) -> Result<Vec<IndexInfo>, String> {
    let started = std::time::Instant::now();
    let result = list_indexes_impl_inner(state, id, db, collection).await;
    crate::audit::maybe_record_result(
        state,
        Some(id),
        Some(db),
        Some(collection),
        "list_indexes",
        crate::audit::OpClass::ReadHigh,
        None,
        started,
        &format!("listIndexes {db}.{collection}"),
        None,
        &result,
    );
    result
}

async fn list_indexes_impl_inner(
    state: &AppState,
    id: &str,
    db: &str,
    collection: &str,
) -> Result<Vec<IndexInfo>, String> {
    let is_mock = {
        let mocks = state.mocks.lock_safe()?;
        *mocks
            .get(id)
            .ok_or_else(|| "Connection not found".to_string())?
    };

    if is_mock {
        let key = format!("{}/{}/{}", id, db, collection);
        let mut mock_indexes = state.mock_indexes.lock_safe()?;
        if !mock_indexes.contains_key(&key) {
            let defaults = mock_db::get_mock_indexes(db, collection);
            mock_indexes.insert(key.clone(), defaults);
        }
        return Ok(mock_indexes.get(&key).unwrap().clone());
    }

    let client = match crate::server::remote::route(state, id)? {
        crate::server::remote::Route::Local(client) => client,
        crate::server::remote::Route::Remote(conn) => {
            return crate::server::ops::metadata::list_indexes(state, &conn, db, collection).await;
        }
    };

    let database = client.database(db);
    let coll = database.collection::<mongodb::bson::Document>(collection);

    let mut cursor = coll
        .list_indexes()
        .await
        .map_err(|e| format!("Failed to list indexes: {}", e))?;

    let mut indexes = Vec::new();
    use futures::stream::StreamExt;
    while let Some(result) = cursor.next().await {
        let index_model = result.map_err(|e| format!("Index read error: {}", e))?;
        indexes.push(index_info(&index_model));
    }

    Ok(indexes)
}

fn index_info(index_model: &mongodb::IndexModel) -> IndexInfo {
    // Serialize the real key pattern (preserves field order + direction/type).
    let keys = serde_json::to_string(&index_model.keys).unwrap_or_else(|_| "{}".to_string());
    let options = index_model.options.as_ref();
    let info = IndexInfo {
        name: options.and_then(|o| o.name.clone()).unwrap_or_default(),
        keys,
        unique: options.and_then(|o| o.unique).unwrap_or(false),
        sparse: options.and_then(|o| o.sparse).unwrap_or(false),
        ..Default::default()
    };
    // The options serialize under their index document names.
    let spec = options
        .and_then(|o| mongodb::bson::to_document(o).ok())
        .unwrap_or_default();
    with_spec_details(info, &spec)
}

/// `info` with what the index document `spec` says beyond keys and flags: its
/// TTL, whether it is hidden, and its partial filter.
pub(crate) fn with_spec_details(mut info: IndexInfo, spec: &mongodb::bson::Document) -> IndexInfo {
    use mongodb::bson::Bson;
    info.expire_after_seconds = match spec.get("expireAfterSeconds") {
        Some(Bson::Int32(n)) => Some(i64::from(*n)),
        Some(Bson::Int64(n)) => Some(*n),
        Some(Bson::Double(n)) => Some(*n as i64),
        _ => None,
    };
    info.hidden = spec.get_bool("hidden").unwrap_or(false);
    info.partial_filter_expression = spec
        .get_document("partialFilterExpression")
        .ok()
        .and_then(|filter| serde_json::to_string(filter).ok());
    info
}

pub(crate) const TTL_SINGLE_FIELD: &str = "A TTL index must have exactly one key field";
pub(crate) const TTL_NOT_ID: &str = "A TTL index cannot be on _id";
pub(crate) const TTL_RANGE: &str =
    "Expire after seconds must be a whole number from 0 to 2147483647";

fn check_ttl_seconds(seconds: i64) -> Result<(), String> {
    if (0..=i64::from(i32::MAX)).contains(&seconds) {
        Ok(())
    } else {
        Err(TTL_RANGE.to_string())
    }
}

/// MongoDB's rules for a TTL index: one field, not `_id`, a 32-bit expiry.
fn check_ttl(keys: &mongodb::bson::Document, seconds: i64) -> Result<(), String> {
    if keys.len() != 1 {
        return Err(TTL_SINGLE_FIELD.to_string());
    }
    if keys.contains_key("_id") {
        return Err(TTL_NOT_ID.to_string());
    }
    check_ttl_seconds(seconds)
}

fn set_expiry_command(collection: &str, index_name: &str, seconds: i64) -> mongodb::bson::Document {
    mongodb::bson::doc! {
        "collMod": collection,
        "index": { "name": index_name, "expireAfterSeconds": seconds },
    }
}

/// Changes a TTL index's expiry in place with `collMod`, without rebuilding it.
pub async fn set_index_expiry_impl(
    state: &AppState,
    id: &str,
    db: &str,
    collection: &str,
    index_name: &str,
    expire_after_seconds: i64,
) -> Result<(), String> {
    let started = std::time::Instant::now();
    let result =
        set_index_expiry_inner(state, id, db, collection, index_name, expire_after_seconds).await;
    crate::audit::maybe_record_result(
        state,
        Some(id),
        Some(db),
        Some(collection),
        "set_index_expiry",
        crate::audit::OpClass::Write,
        None,
        started,
        &format!("collMod {db}.{collection}.{index_name} expireAfterSeconds={expire_after_seconds}"),
        None,
        &result,
    );
    result
}

async fn set_index_expiry_inner(
    state: &AppState,
    id: &str,
    db: &str,
    collection: &str,
    index_name: &str,
    expire_after_seconds: i64,
) -> Result<(), String> {
    guard_writable(state, id, WriteOp::CollMod, false)?;
    check_ttl_seconds(expire_after_seconds)?;

    if crate::connection_is_mock(state, id)? {
        let key = format!("{}/{}/{}", id, db, collection);
        let mut mock_indexes = state.mock_indexes.lock_safe()?;
        let list = mock_indexes
            .entry(key)
            .or_insert_with(|| mock_db::get_mock_indexes(db, collection));
        return match list
            .iter_mut()
            .find(|i| i.name == index_name && i.expire_after_seconds.is_some())
        {
            Some(index) => {
                index.expire_after_seconds = Some(expire_after_seconds);
                Ok(())
            }
            None => Err(format!("Index {index_name} has no TTL to change")),
        };
    }

    let client = match crate::server::remote::route(state, id)? {
        crate::server::remote::Route::Local(client) => client,
        crate::server::remote::Route::Remote(conn) => {
            return crate::server::ops::ddl::set_index_expiry(
                state, &conn, db, collection, index_name, expire_after_seconds,
            )
            .await;
        }
    };
    client
        .database(db)
        .run_command(set_expiry_command(collection, index_name, expire_after_seconds))
        .await
        .map(|_| ())
        .map_err(|e| format!("Failed to change the index expiry: {}", e))
}

pub async fn create_index_impl(
    state: &AppState,
    id: &str,
    db: &str,
    collection: &str,
    index_name: &str,
    keys: &str,
    unique: bool,
    sparse: bool,
    expire_after_seconds: Option<i64>,
) -> Result<(), String> {
    let started = std::time::Instant::now();
    let result = create_index_inner(state, id, db, collection, index_name, keys, unique, sparse, expire_after_seconds).await;
    crate::audit::maybe_record_result(
        state,
        Some(id),
        Some(db),
        Some(collection),
        "create_index",
        crate::audit::OpClass::Write,
        None,
        started,
        &format!("createIndex {db}.{collection}.{index_name}"),
        Some(keys),
        &result,
    );
    result
}

async fn create_index_inner(
    state: &AppState,
    id: &str,
    db: &str,
    collection: &str,
    index_name: &str,
    keys: &str,
    unique: bool,
    sparse: bool,
    expire_after_seconds: Option<i64>,
) -> Result<(), String> {
    guard_writable(state, id, WriteOp::CreateIndex, false)?;

    let value: serde_json::Value =
        serde_json::from_str(keys).map_err(|e| format!("Invalid JSON keys: {}", e))?;
    let keys_doc = mongodb::bson::to_document(&value)
        .map_err(|e| format!("Failed to convert keys JSON to BSON: {}", e))?;
    if let Some(seconds) = expire_after_seconds {
        check_ttl(&keys_doc, seconds)?;
    }

    let is_mock = {
        let mocks = state.mocks.lock_safe()?;
        *mocks
            .get(id)
            .ok_or_else(|| "Connection not found".to_string())?
    };

    if is_mock {
        let key = format!("{}/{}/{}", id, db, collection);
        let mut mock_indexes = state.mock_indexes.lock_safe()?;
        if !mock_indexes.contains_key(&key) {
            let defaults = mock_db::get_mock_indexes(db, collection);
            mock_indexes.insert(key.clone(), defaults);
        }
        let list = mock_indexes.get_mut(&key).unwrap();
        if !list.iter().any(|i| i.name == index_name) {
            list.push(IndexInfo {
                name: index_name.to_string(),
                keys: keys.to_string(),
                unique,
                sparse,
                expire_after_seconds,
                ..Default::default()
            });
        }
        return Ok(());
    }

    let client = match crate::server::remote::route(state, id)? {
        crate::server::remote::Route::Local(client) => client,
        crate::server::remote::Route::Remote(conn) => {
            let index = crate::server::ops::write::NewIndex {
                name: index_name,
                keys: &keys_doc,
                unique,
                sparse,
                expire_after_seconds,
            };
            use crate::server::ops::write;
            return write::create_index(state, &conn, db, collection, index).await;
        }
    };

    let database = client.database(db);
    let coll = database.collection::<mongodb::bson::Document>(collection);

    let mut options = mongodb::options::IndexOptions::builder()
        .name(index_name.to_string())
        .build();

    if unique {
        options.unique = Some(true);
    }
    if sparse {
        options.sparse = Some(true);
    }
    // Checked above to be 0 or more.
    options.expire_after =
        expire_after_seconds.map(|s| std::time::Duration::from_secs(s as u64));

    let model = mongodb::IndexModel::builder()
        .keys(keys_doc)
        .options(options)
        .build();

    coll.create_index(model)
        .await
        .map(|_| ())
        .map_err(|e| format!("Failed to create index: {}", e))
}

pub async fn delete_index_impl(
    state: &AppState,
    id: &str,
    db: &str,
    collection: &str,
    index_name: &str,
) -> Result<(), String> {
    let started = std::time::Instant::now();
    let result = delete_index_inner(state, id, db, collection, index_name).await;
    crate::audit::maybe_record_result(
        state,
        Some(id),
        Some(db),
        Some(collection),
        "delete_index",
        crate::audit::OpClass::Write,
        None,
        started,
        &format!("dropIndex {db}.{collection}.{index_name}"),
        None,
        &result,
    );
    result
}

async fn delete_index_inner(
    state: &AppState,
    id: &str,
    db: &str,
    collection: &str,
    index_name: &str,
) -> Result<(), String> {
    guard_writable(state, id, WriteOp::DropIndex, false)?;

    let is_mock = {
        let mocks = state.mocks.lock_safe()?;
        *mocks
            .get(id)
            .ok_or_else(|| "Connection not found".to_string())?
    };

    if is_mock {
        let key = format!("{}/{}/{}", id, db, collection);
        let mut mock_indexes = state.mock_indexes.lock_safe()?;
        if !mock_indexes.contains_key(&key) {
            let defaults = mock_db::get_mock_indexes(db, collection);
            mock_indexes.insert(key.clone(), defaults);
        }
        let list = mock_indexes.get_mut(&key).unwrap();
        list.retain(|x| x.name != index_name);
        return Ok(());
    }

    let client = match crate::server::remote::route(state, id)? {
        crate::server::remote::Route::Local(client) => client,
        crate::server::remote::Route::Remote(conn) => {
            use crate::server::ops::write;
            return write::drop_index(state, &conn, db, collection, index_name).await;
        }
    };

    let database = client.database(db);
    let coll = database.collection::<mongodb::bson::Document>(collection);

    coll.drop_index(index_name)
        .await
        .map(|_| ())
        .map_err(|e| format!("Failed to delete index: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The reply a server like Azure Cosmos DB gives to `listCollections`: the
    /// name, and not much else.
    fn sparse_listing_entry() -> mongodb::bson::Document {
        mongodb::bson::doc! { "name": "customers" }
    }

    /// #327: the driver's own type is what fails, before any of our code runs.
    ///
    /// `CollectionSpecification` requires `type`, `options` and `info`, and
    /// `info.readOnly` as a bare bool, with a default on none of them. A server
    /// that answers with less cannot be deserialized into it at all, so the
    /// cursor yields an error, the listing returns `Err`, and the sidebar shows
    /// an empty database — while `dbStats` beside it reports the real count.
    ///
    /// A Cosmos instance is the one thing this cannot be run against here: both
    /// MongoDB-API emulator images are builds whose evaluation period expired,
    /// and the current Linux emulator serves the NoSQL API only. So this pins
    /// the mechanism at the point where it actually breaks — the shape the
    /// driver will not accept — which is checkable without any server at all.
    #[test]
    fn the_driver_cannot_read_a_listing_that_omits_type_options_and_info() {
        let missing_field = |d: mongodb::bson::Document| {
            mongodb::bson::from_document::<mongodb::results::CollectionSpecification>(d)
                .err()
                .expect(
                    "if the driver ever accepts a partial listing, the fallback is dead code \
                     and should be deleted along with this test",
                )
                .to_string()
        };

        // One required field at a time, each refused in turn. Naming them keeps
        // this honest: the listing fails for the reason claimed, not because the
        // document was malformed in some other way.
        assert!(missing_field(sparse_listing_entry()).contains("missing field `type`"));
        assert!(missing_field(mongodb::bson::doc! {
            "name": "customers", "type": "collection"
        })
        .contains("missing field `options`"));
        assert!(missing_field(mongodb::bson::doc! {
            "name": "customers", "type": "collection", "options": {}
        })
        .contains("missing field `info`"));
        // And `info.readOnly` is a bare bool with no default of its own, so even
        // an `info` that is present but empty is not enough.
        assert!(missing_field(mongodb::bson::doc! {
            "name": "customers", "type": "collection", "options": {}, "info": {}
        })
        .contains("missing field `readOnly`"));
    }

    /// The counterpart: what a real MongoDB sends does deserialize, so the
    /// fallback is reached only by servers that answer with less.
    #[test]
    fn a_full_mongodb_listing_still_reads_normally() {
        let spec = mongodb::bson::from_document::<mongodb::results::CollectionSpecification>(
            mongodb::bson::doc! {
                "name": "customers",
                "type": "collection",
                "options": {},
                "info": { "readOnly": false },
            },
        )
        .expect("a complete listing entry must still deserialize");
        assert_eq!(spec.name, "customers");
    }

    /// The other half: what the server *will* answer is enough for names alone,
    /// which is what the fallback asks for.
    #[test]
    fn a_sparse_entry_still_yields_its_name() {
        let name = sparse_listing_entry().get_str("name").unwrap().to_string();
        assert_eq!(name, "customers");
    }

    /// The fallback's type must stay distinguishable from a confirmed one — a
    /// database copy refuses on it rather than materializing what may be a view.
    #[test]
    fn the_unknown_type_is_not_a_claim_about_the_collection() {
        assert_ne!(UNKNOWN_COLLECTION_TYPE, "collection");
        assert_ne!(UNKNOWN_COLLECTION_TYPE, "view");
        assert_ne!(UNKNOWN_COLLECTION_TYPE, "timeseries");
    }

    async fn mock_connection() -> (AppState, String) {
        let state = AppState::new();
        let id = crate::connect_db_impl(&state, "mongodb://mock", None)
            .await
            .unwrap();
        (state, id)
    }

    async fn listed(state: &AppState, id: &str, name: &str) -> IndexInfo {
        list_indexes_impl(state, id, "sales_db", "customers")
            .await
            .unwrap()
            .into_iter()
            .find(|i| i.name == name)
            .unwrap()
    }

    // What the driver reads back from listIndexes: the TTL, hidden and the
    // partial filter all reach the listing.
    #[test]
    fn an_index_lists_its_ttl_hidden_flag_and_partial_filter() {
        let model = mongodb::IndexModel::builder()
            .keys(mongodb::bson::doc! { "createdAt": 1 })
            .options(
                mongodb::options::IndexOptions::builder()
                    .name("createdAt_1".to_string())
                    .expire_after(std::time::Duration::from_secs(86400))
                    .hidden(true)
                    .partial_filter_expression(mongodb::bson::doc! { "archived": true })
                    .build(),
            )
            .build();
        let info = index_info(&model);
        assert_eq!(info.name, "createdAt_1");
        assert_eq!(info.expire_after_seconds, Some(86400));
        assert!(info.hidden);
        assert_eq!(
            info.partial_filter_expression.as_deref(),
            Some(r#"{"archived":true}"#)
        );
    }

    // Payloads for an index without any of these stay exactly as they were.
    #[test]
    fn a_plain_index_serializes_as_before() {
        let plain = IndexInfo {
            name: "a_1".into(),
            keys: r#"{"a":1}"#.into(),
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_value(&plain).unwrap(),
            serde_json::json!({ "name": "a_1", "keys": "{\"a\":1}", "unique": false, "sparse": false })
        );
        let ttl = IndexInfo {
            expire_after_seconds: Some(60),
            hidden: true,
            partial_filter_expression: Some("{}".into()),
            ..plain
        };
        let value = serde_json::to_value(&ttl).unwrap();
        assert_eq!(value["expireAfterSeconds"], 60);
        assert_eq!(value["hidden"], true);
        assert_eq!(value["partialFilterExpression"], "{}");
    }

    #[tokio::test]
    async fn a_ttl_index_is_created_and_listed_with_its_expiry() {
        let (state, id) = mock_connection().await;
        create_index_impl(
            &state, &id, "sales_db", "customers", "createdAt_1", r#"{"createdAt":1}"#, false,
            false, Some(3600),
        )
        .await
        .unwrap();
        assert_eq!(
            listed(&state, &id, "createdAt_1").await.expire_after_seconds,
            Some(3600)
        );
    }

    // MongoDB's rules for a TTL index, refused before any request.
    #[tokio::test]
    async fn a_ttl_index_follows_mongodb_rules() {
        let (state, id) = mock_connection().await;
        let create = |keys: &'static str, ttl: i64| {
            let (state, id) = (&state, id.clone());
            async move {
                create_index_impl(state, &id, "sales_db", "customers", "t", keys, false, false, Some(ttl))
                    .await
                    .unwrap_err()
            }
        };
        assert_eq!(create(r#"{"a":1,"b":1}"#, 60).await, TTL_SINGLE_FIELD);
        assert_eq!(create(r#"{"_id":1}"#, 60).await, TTL_NOT_ID);
        assert_eq!(create(r#"{"a":1}"#, -1).await, TTL_RANGE);
        assert_eq!(create(r#"{"a":1}"#, 2_147_483_648).await, TTL_RANGE);
        assert!(list_indexes_impl(&state, &id, "sales_db", "customers")
            .await
            .unwrap()
            .iter()
            .all(|i| i.name != "t"));
        // The bounds themselves are allowed.
        for (name, ttl) in [("zero", 0), ("max", 2_147_483_647)] {
            create_index_impl(&state, &id, "sales_db", "customers", name, r#"{"a":1}"#, false, false, Some(ttl))
                .await
                .unwrap();
        }
    }

    #[tokio::test]
    async fn the_expiry_of_a_ttl_index_changes_in_place() {
        let (state, id) = mock_connection().await;
        create_index_impl(
            &state, &id, "sales_db", "customers", "createdAt_1", r#"{"createdAt":1}"#, false,
            false, Some(3600),
        )
        .await
        .unwrap();
        set_index_expiry_impl(&state, &id, "sales_db", "customers", "createdAt_1", 86400)
            .await
            .unwrap();
        assert_eq!(
            listed(&state, &id, "createdAt_1").await.expire_after_seconds,
            Some(86400)
        );
        assert_eq!(
            set_index_expiry_impl(&state, &id, "sales_db", "customers", "createdAt_1", -5)
                .await
                .unwrap_err(),
            TTL_RANGE
        );
        assert_eq!(
            set_index_expiry_impl(&state, &id, "sales_db", "customers", "email_1", 60)
                .await
                .unwrap_err(),
            "Index email_1 has no TTL to change"
        );
    }

    // collMod's own shape, as MongoDB documents it.
    #[test]
    fn the_expiry_change_is_a_collmod_on_the_index_name() {
        assert_eq!(
            set_expiry_command("events", "createdAt_1", 60),
            mongodb::bson::doc! {
                "collMod": "events",
                "index": { "name": "createdAt_1", "expireAfterSeconds": 60_i64 },
            }
        );
    }
}
