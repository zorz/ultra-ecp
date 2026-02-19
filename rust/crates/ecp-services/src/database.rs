//! Database service — PostgreSQL connection management, queries, transactions, and schema browsing.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use ecp_protocol::{ECPError, HandlerResult};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex as TokioMutex;
use tokio_postgres::{Client, NoTls, Row};
use tracing::{debug, info, warn};

use crate::Service;

// ─────────────────────────────────────────────────────────────────────────────
// Connection config (persisted to disk)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub db_type: String, // "postgres" | "supabase"
    pub host: String,
    #[serde(default = "default_pg_port")]
    pub port: u16,
    pub database: String,
    pub username: String,
    /// Reference to a secret key in SecretService
    #[serde(rename = "passwordSecret", skip_serializing_if = "Option::is_none")]
    pub password_secret: Option<String>,
    /// Direct password (for testing; prefer password_secret)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default)]
    pub ssl: bool,
    #[serde(rename = "readOnly", default)]
    pub read_only: bool,
    #[serde(default = "default_scope")]
    pub scope: String, // "global" | "project"
    #[serde(rename = "connectionTimeout", skip_serializing_if = "Option::is_none")]
    pub connection_timeout: Option<u64>,
    #[serde(rename = "queryTimeout", skip_serializing_if = "Option::is_none")]
    pub query_timeout: Option<u64>,
}

fn default_pg_port() -> u16 { 5432 }
fn default_scope() -> String { "global".into() }

// ─────────────────────────────────────────────────────────────────────────────
// Live connection
// ─────────────────────────────────────────────────────────────────────────────

struct LiveConnection {
    client: Client,
    config: ConnectionConfig,
}

// ─────────────────────────────────────────────────────────────────────────────
// Database service
// ─────────────────────────────────────────────────────────────────────────────

pub struct DatabaseService {
    workspace_root: PathBuf,
    /// Saved connection configurations
    configs: RwLock<HashMap<String, ConnectionConfig>>,
    /// Active connections
    connections: Arc<TokioMutex<HashMap<String, LiveConnection>>>,
    /// Query history
    history: RwLock<Vec<QueryHistoryEntry>>,
    /// Favorite queries
    favorites: RwLock<Vec<FavoriteQuery>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct QueryHistoryEntry {
    id: String,
    connection_id: String,
    sql: String,
    status: String, // "success" | "error"
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    row_count: Option<i64>,
    duration_ms: u64,
    timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FavoriteQuery {
    id: String,
    name: String,
    sql: String,
    connection_id: Option<String>,
    created_at: u64,
}

impl DatabaseService {
    pub fn new(workspace_root: PathBuf) -> Self {
        let svc = Self {
            workspace_root,
            configs: RwLock::new(HashMap::new()),
            connections: Arc::new(TokioMutex::new(HashMap::new())),
            history: RwLock::new(Vec::new()),
            favorites: RwLock::new(Vec::new()),
        };
        svc.load_configs();
        svc
    }

    /// Load connection configs from disk.
    fn load_configs(&self) {
        let global_path = dirs_path().join("connections.json");
        let project_path = self.workspace_root.join(".ultra/connections.json");

        let mut configs = self.configs.write();
        for path in [global_path, project_path] {
            if let Ok(data) = std::fs::read_to_string(&path) {
                if let Ok(list) = serde_json::from_str::<Vec<ConnectionConfig>>(&data) {
                    for c in list {
                        configs.insert(c.id.clone(), c);
                    }
                }
            }
        }
        debug!("Loaded {} database connection configs", configs.len());
    }

    /// Save connection configs to disk.
    fn save_configs(&self) {
        let configs = self.configs.read();
        let global: Vec<&ConnectionConfig> = configs.values().filter(|c| c.scope == "global").collect();
        let project: Vec<&ConnectionConfig> = configs.values().filter(|c| c.scope == "project").collect();

        // Save global configs
        let global_path = dirs_path().join("connections.json");
        if let Some(parent) = global_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(&global) {
            let _ = std::fs::write(&global_path, json);
        }

        // Save project configs
        if !project.is_empty() {
            let project_path = self.workspace_root.join(".ultra/connections.json");
            if let Some(parent) = project_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Ok(json) = serde_json::to_string_pretty(&project) {
                let _ = std::fs::write(&project_path, json);
            }
        }
    }

    /// Build a PostgreSQL connection string from config.
    fn connection_string(config: &ConnectionConfig) -> String {
        let password = config.password.as_deref().unwrap_or("");
        format!(
            "host={} port={} user={} password={} dbname={}",
            config.host, config.port, config.username, password, config.database
        )
    }

    /// Connect to a database.
    async fn do_connect(&self, config: &ConnectionConfig) -> Result<Client, ECPError> {
        if config.ssl {
            // TODO: Add rustls-based TLS support (native-tls incompatible with Rust 2024 edition)
            return Err(ECPError::server_error(
                "SSL connections not yet supported in the Rust build. Use ssl: false for now.",
            ));
        }

        let conn_str = Self::connection_string(config);
        let (client, connection) = tokio_postgres::connect(&conn_str, NoTls)
            .await
            .map_err(|e| ECPError::server_error(format!("Connection failed: {e}")))?;

        tokio::spawn(async move {
            if let Err(e) = connection.await {
                warn!("Database connection error: {e}");
            }
        });

        Ok(client)
    }

    /// Execute a query on an active connection.
    async fn execute_query(&self, connection_id: &str, sql: &str, _params_json: Option<&[Value]>) -> Result<Value, ECPError> {
        let start = Instant::now();
        let conns = self.connections.lock().await;
        let live = conns.get(connection_id)
            .ok_or_else(|| ECPError::server_error(format!("Not connected: {connection_id}")))?;

        // Check read-only
        if live.config.read_only && is_mutating_query(sql) {
            return Err(ECPError::server_error("Connection is read-only"));
        }

        let rows = live.client.query(sql, &[])
            .await
            .map_err(|e| ECPError::server_error(format!("Query failed: {e}")))?;

        let duration_ms = start.elapsed().as_millis() as u64;

        // Convert rows to JSON
        let (fields, json_rows) = rows_to_json(&rows);
        let row_count = json_rows.len() as i64;

        // Record history
        drop(conns);
        self.record_history(connection_id, sql, "success", None, Some(row_count), duration_ms);

        Ok(json!({
            "rows": json_rows,
            "fields": fields,
            "rowCount": row_count,
            "durationMs": duration_ms,
        }))
    }

    fn record_history(&self, conn_id: &str, sql: &str, status: &str, error: Option<&str>, row_count: Option<i64>, duration_ms: u64) {
        let entry = QueryHistoryEntry {
            id: format!("qh-{}", uuid::Uuid::new_v4()),
            connection_id: conn_id.to_string(),
            sql: sql.to_string(),
            status: status.to_string(),
            error: error.map(|s| s.to_string()),
            row_count,
            duration_ms,
            timestamp: now_ms(),
        };
        self.history.write().push(entry);
    }
}

impl Service for DatabaseService {
    fn namespace(&self) -> &str {
        "database"
    }

    async fn handle(&self, method: &str, params: Option<Value>) -> HandlerResult {
        match method {
            // ── Connection management ────────────────────────────────

            "database/createConnection" => {
                let p: CreateConnectionParams = parse_params(params)?;
                let id = format!("conn-{}", uuid::Uuid::new_v4());
                let config = ConnectionConfig {
                    id: id.clone(),
                    name: p.name,
                    db_type: p.db_type.unwrap_or_else(|| "postgres".into()),
                    host: p.host,
                    port: p.port.unwrap_or(5432),
                    database: p.database,
                    username: p.username,
                    password_secret: p.password_secret,
                    password: p.password,
                    ssl: p.ssl.unwrap_or(false),
                    read_only: p.read_only.unwrap_or(false),
                    scope: p.scope.unwrap_or_else(|| "global".into()),
                    connection_timeout: p.connection_timeout,
                    query_timeout: p.query_timeout,
                };
                self.configs.write().insert(id.clone(), config);
                self.save_configs();
                Ok(json!({ "connectionId": id }))
            }

            "database/updateConnection" => {
                let p: UpdateConnectionParams = parse_params(params)?;
                let mut configs = self.configs.write();
                let config = configs.get_mut(&p.connection_id)
                    .ok_or_else(|| ECPError::server_error(format!("Connection not found: {}", p.connection_id)))?;
                if let Some(name) = p.name { config.name = name; }
                if let Some(host) = p.host { config.host = host; }
                if let Some(port) = p.port { config.port = port; }
                if let Some(db) = p.database { config.database = db; }
                if let Some(user) = p.username { config.username = user; }
                if let Some(pw) = p.password { config.password = Some(pw); }
                if let Some(ssl) = p.ssl { config.ssl = ssl; }
                if let Some(ro) = p.read_only { config.read_only = ro; }
                drop(configs);
                self.save_configs();
                Ok(json!({ "success": true }))
            }

            "database/deleteConnection" => {
                let p: ConnectionIdParam = parse_params(params)?;
                // Disconnect if active
                self.connections.lock().await.remove(&p.connection_id);
                let removed = self.configs.write().remove(&p.connection_id).is_some();
                if removed { self.save_configs(); }
                Ok(json!({ "success": removed }))
            }

            "database/listConnections" => {
                // Clone configs before the async lock to avoid holding RwLockReadGuard across await
                let config_list: Vec<ConnectionConfig> = self.configs.read().values().cloned().collect();
                let conns = self.connections.lock().await;
                let list: Vec<Value> = config_list.iter().map(|c| {
                    let connected = conns.contains_key(&c.id);
                    json!({
                        "id": c.id,
                        "name": c.name,
                        "type": c.db_type,
                        "host": c.host,
                        "port": c.port,
                        "database": c.database,
                        "username": c.username,
                        "ssl": c.ssl,
                        "readOnly": c.read_only,
                        "scope": c.scope,
                        "status": if connected { "connected" } else { "disconnected" },
                    })
                }).collect();
                Ok(json!({ "connections": list }))
            }

            "database/getConnection" => {
                let p: ConnectionIdParam = parse_params(params)?;
                let config = {
                    let configs = self.configs.read();
                    configs.get(&p.connection_id)
                        .ok_or_else(|| ECPError::server_error(format!("Connection not found: {}", p.connection_id)))?
                        .clone()
                };
                let connected = self.connections.lock().await.contains_key(&p.connection_id);
                Ok(json!({
                    "id": config.id,
                    "name": config.name,
                    "type": config.db_type,
                    "host": config.host,
                    "port": config.port,
                    "database": config.database,
                    "username": config.username,
                    "ssl": config.ssl,
                    "readOnly": config.read_only,
                    "scope": config.scope,
                    "status": if connected { "connected" } else { "disconnected" },
                }))
            }

            "database/connect" => {
                let p: ConnectionIdParam = parse_params(params)?;
                let config = {
                    let configs = self.configs.read();
                    configs.get(&p.connection_id)
                        .ok_or_else(|| ECPError::server_error(format!("Connection not found: {}", p.connection_id)))?
                        .clone()
                };

                info!("Connecting to database: {} ({}:{})", config.name, config.host, config.port);
                let client = self.do_connect(&config).await?;

                self.connections.lock().await.insert(p.connection_id.clone(), LiveConnection {
                    client,
                    config,
                });

                info!("Connected to database: {}", p.connection_id);
                Ok(json!({ "success": true }))
            }

            "database/disconnect" => {
                let p: ConnectionIdParam = parse_params(params)?;
                let removed = self.connections.lock().await.remove(&p.connection_id).is_some();
                if removed { info!("Disconnected from database: {}", p.connection_id); }
                Ok(json!({ "success": removed }))
            }

            "database/testConnection" => {
                let p: TestConnectionParams = parse_params(params)?;
                let config = ConnectionConfig {
                    id: "test".into(),
                    name: "test".into(),
                    db_type: p.db_type.unwrap_or_else(|| "postgres".into()),
                    host: p.host,
                    port: p.port.unwrap_or(5432),
                    database: p.database,
                    username: p.username,
                    password_secret: None,
                    password: p.password,
                    ssl: p.ssl.unwrap_or(false),
                    read_only: false,
                    scope: "global".into(),
                    connection_timeout: None,
                    query_timeout: None,
                };

                let start = Instant::now();
                match self.do_connect(&config).await {
                    Ok(client) => {
                        // Test with a simple query
                        let version = client.query_one("SELECT version()", &[]).await
                            .map(|row| row.get::<_, String>(0))
                            .unwrap_or_else(|_| "unknown".into());
                        let duration_ms = start.elapsed().as_millis() as u64;
                        Ok(json!({
                            "success": true,
                            "version": version,
                            "durationMs": duration_ms,
                        }))
                    }
                    Err(e) => {
                        Ok(json!({
                            "success": false,
                            "error": e.message,
                            "durationMs": start.elapsed().as_millis() as u64,
                        }))
                    }
                }
            }

            // ── Query execution ──────────────────────────────────────

            "database/query" => {
                let p: QueryParams = parse_params(params)?;
                match self.execute_query(&p.connection_id, &p.sql, p.params.as_deref()).await {
                    Ok(result) => Ok(result),
                    Err(e) => {
                        self.record_history(&p.connection_id, &p.sql, "error", Some(&e.message), None, 0);
                        Err(e)
                    }
                }
            }

            "database/transaction" => {
                let p: TransactionParams = parse_params(params)?;
                let start = Instant::now();
                let conns = self.connections.lock().await;
                let live = conns.get(&p.connection_id)
                    .ok_or_else(|| ECPError::server_error(format!("Not connected: {}", p.connection_id)))?;

                if live.config.read_only {
                    return Err(ECPError::server_error("Connection is read-only"));
                }

                // Execute transaction
                live.client.execute("BEGIN", &[]).await
                    .map_err(|e| ECPError::server_error(format!("BEGIN failed: {e}")))?;

                let mut results = Vec::new();
                let mut had_error = false;

                for stmt in &p.statements {
                    match live.client.query(&stmt.sql, &[]).await {
                        Ok(rows) => {
                            let (fields, json_rows) = rows_to_json(&rows);
                            results.push(json!({
                                "label": stmt.label,
                                "success": true,
                                "rows": json_rows,
                                "fields": fields,
                                "rowCount": json_rows.len(),
                            }));
                        }
                        Err(e) => {
                            results.push(json!({
                                "label": stmt.label,
                                "success": false,
                                "error": e.to_string(),
                            }));
                            had_error = true;
                            break;
                        }
                    }
                }

                if had_error {
                    let _ = live.client.execute("ROLLBACK", &[]).await;
                } else {
                    live.client.execute("COMMIT", &[]).await
                        .map_err(|e| ECPError::server_error(format!("COMMIT failed: {e}")))?;
                }

                let duration_ms = start.elapsed().as_millis() as u64;
                drop(conns);

                Ok(json!({
                    "success": !had_error,
                    "results": results,
                    "durationMs": duration_ms,
                }))
            }

            // ── Schema browsing ──────────────────────────────────────

            "database/listSchemas" => {
                let p: ConnectionIdParam = parse_params(params)?;
                let conns = self.connections.lock().await;
                let live = conns.get(&p.connection_id)
                    .ok_or_else(|| ECPError::server_error(format!("Not connected: {}", p.connection_id)))?;

                let rows = live.client.query(
                    "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_toast', 'pg_catalog', 'information_schema') ORDER BY schema_name",
                    &[],
                ).await.map_err(|e| ECPError::server_error(format!("Schema query failed: {e}")))?;

                let schemas: Vec<String> = rows.iter().map(|r| r.get(0)).collect();
                Ok(json!({ "schemas": schemas }))
            }

            "database/listTables" => {
                let p: SchemaParam = parse_params(params)?;
                let schema = p.schema.unwrap_or_else(|| "public".into());
                let conns = self.connections.lock().await;
                let live = conns.get(&p.connection_id)
                    .ok_or_else(|| ECPError::server_error(format!("Not connected: {}", p.connection_id)))?;

                let rows = live.client.query(
                    "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
                    &[&schema],
                ).await.map_err(|e| ECPError::server_error(format!("Table query failed: {e}")))?;

                let tables: Vec<Value> = rows.iter().map(|r| {
                    json!({
                        "name": r.get::<_, String>(0),
                        "type": r.get::<_, String>(1),
                        "schema": &schema,
                    })
                }).collect();
                Ok(json!({ "tables": tables }))
            }

            "database/describeTable" => {
                let p: TableParam = parse_params(params)?;
                let schema = p.schema.unwrap_or_else(|| "public".into());
                let conns = self.connections.lock().await;
                let live = conns.get(&p.connection_id)
                    .ok_or_else(|| ECPError::server_error(format!("Not connected: {}", p.connection_id)))?;

                // Get columns
                let col_rows = live.client.query(
                    "SELECT column_name, data_type, is_nullable, column_default, ordinal_position \
                     FROM information_schema.columns \
                     WHERE table_schema = $1 AND table_name = $2 \
                     ORDER BY ordinal_position",
                    &[&schema, &p.table],
                ).await.map_err(|e| ECPError::server_error(format!("Describe failed: {e}")))?;

                let columns: Vec<Value> = col_rows.iter().map(|r| {
                    json!({
                        "name": r.get::<_, String>(0),
                        "type": r.get::<_, String>(1),
                        "nullable": r.get::<_, String>(2) == "YES",
                        "default": r.get::<_, Option<String>>(3),
                        "position": r.get::<_, i32>(4),
                    })
                }).collect();

                // Get primary key
                let pk_rows = live.client.query(
                    "SELECT kcu.column_name \
                     FROM information_schema.table_constraints tc \
                     JOIN information_schema.key_column_usage kcu \
                       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema \
                     WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2 \
                     ORDER BY kcu.ordinal_position",
                    &[&schema, &p.table],
                ).await.unwrap_or_default();

                let primary_key: Vec<String> = pk_rows.iter().map(|r| r.get(0)).collect();

                // Get foreign keys
                let fk_rows = live.client.query(
                    "SELECT kcu.column_name, ccu.table_schema, ccu.table_name, ccu.column_name AS ref_column, rc.update_rule, rc.delete_rule \
                     FROM information_schema.table_constraints tc \
                     JOIN information_schema.key_column_usage kcu \
                       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema \
                     JOIN information_schema.constraint_column_usage ccu \
                       ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema \
                     JOIN information_schema.referential_constraints rc \
                       ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema \
                     WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2",
                    &[&schema, &p.table],
                ).await.unwrap_or_default();

                let foreign_keys: Vec<Value> = fk_rows.iter().map(|r| {
                    json!({
                        "column": r.get::<_, String>(0),
                        "referencedSchema": r.get::<_, String>(1),
                        "referencedTable": r.get::<_, String>(2),
                        "referencedColumn": r.get::<_, String>(3),
                        "onUpdate": r.get::<_, String>(4),
                        "onDelete": r.get::<_, String>(5),
                    })
                }).collect();

                // Get indexes
                let idx_rows = live.client.query(
                    "SELECT indexname, indexdef \
                     FROM pg_indexes \
                     WHERE schemaname = $1 AND tablename = $2 \
                     ORDER BY indexname",
                    &[&schema, &p.table],
                ).await.unwrap_or_default();

                let indexes: Vec<Value> = idx_rows.iter().map(|r| {
                    let def: String = r.get(1);
                    json!({
                        "name": r.get::<_, String>(0),
                        "definition": def,
                        "unique": def.contains("UNIQUE"),
                    })
                }).collect();

                // Row count estimate
                let count_row = live.client.query_one(
                    &format!("SELECT reltuples::bigint FROM pg_class WHERE relname = '{}'", p.table),
                    &[],
                ).await.ok();
                let estimated_rows = count_row.map(|r| r.get::<_, i64>(0)).unwrap_or(-1);

                Ok(json!({
                    "table": p.table,
                    "schema": schema,
                    "columns": columns,
                    "primaryKey": primary_key,
                    "foreignKeys": foreign_keys,
                    "indexes": indexes,
                    "estimatedRows": estimated_rows,
                }))
            }

            "database/getTableDDL" => {
                let p: TableParam = parse_params(params)?;
                let schema = p.schema.unwrap_or_else(|| "public".into());
                let conns = self.connections.lock().await;
                let live = conns.get(&p.connection_id)
                    .ok_or_else(|| ECPError::server_error(format!("Not connected: {}", p.connection_id)))?;

                // PostgreSQL doesn't have a native SHOW CREATE TABLE, so we reconstruct it
                // Using pg_dump-style approach via information_schema
                let col_rows = live.client.query(
                    "SELECT column_name, data_type, is_nullable, column_default \
                     FROM information_schema.columns \
                     WHERE table_schema = $1 AND table_name = $2 \
                     ORDER BY ordinal_position",
                    &[&schema, &p.table],
                ).await.map_err(|e| ECPError::server_error(format!("DDL query failed: {e}")))?;

                let mut ddl = format!("CREATE TABLE {}.{} (\n", schema, p.table);
                for (i, r) in col_rows.iter().enumerate() {
                    let name: String = r.get(0);
                    let dtype: String = r.get(1);
                    let nullable: String = r.get(2);
                    let default: Option<String> = r.get(3);

                    ddl.push_str(&format!("    {} {}", name, dtype));
                    if nullable == "NO" { ddl.push_str(" NOT NULL"); }
                    if let Some(def) = default { ddl.push_str(&format!(" DEFAULT {}", def)); }
                    if i < col_rows.len() - 1 { ddl.push(','); }
                    ddl.push('\n');
                }
                ddl.push_str(");");

                Ok(json!({ "ddl": ddl }))
            }

            // ── Query history ────────────────────────────────────────

            "database/history" => {
                let p: HistoryParams = parse_params_optional(params);
                let history = self.history.read();
                let limit = p.limit.unwrap_or(50) as usize;
                let offset = p.offset.unwrap_or(0) as usize;
                let entries: Vec<&QueryHistoryEntry> = history.iter().rev().skip(offset).take(limit).collect();
                Ok(json!({ "history": entries, "total": history.len() }))
            }

            "database/searchHistory" => {
                let p: SearchHistoryParams = parse_params(params)?;
                let history = self.history.read();
                let query_lower = p.query.to_lowercase();
                let matches: Vec<&QueryHistoryEntry> = history.iter()
                    .filter(|h| h.sql.to_lowercase().contains(&query_lower))
                    .rev()
                    .take(p.limit.unwrap_or(50) as usize)
                    .collect();
                Ok(json!({ "history": matches }))
            }

            "database/clearHistory" => {
                let p: OptionalConnectionIdParam = parse_params_optional(params);
                let mut history = self.history.write();
                if let Some(cid) = &p.connection_id {
                    history.retain(|h| h.connection_id != *cid);
                } else {
                    history.clear();
                }
                Ok(json!({ "success": true }))
            }

            "database/favoriteQuery" => {
                let p: FavoriteParams = parse_params(params)?;
                let fav = FavoriteQuery {
                    id: format!("fav-{}", uuid::Uuid::new_v4()),
                    name: p.name,
                    sql: p.sql,
                    connection_id: p.connection_id,
                    created_at: now_ms(),
                };
                let id = fav.id.clone();
                self.favorites.write().push(fav);
                Ok(json!({ "favoriteId": id }))
            }

            "database/getFavorites" => {
                let favorites = self.favorites.read();
                Ok(json!({ "favorites": *favorites }))
            }

            _ => Err(ECPError::method_not_found(method)),
        }
    }

    async fn shutdown(&self) {
        // Drop all connections
        self.connections.lock().await.clear();
        info!("Database service shut down, all connections closed");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Parameter types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct CreateConnectionParams {
    name: String,
    #[serde(rename = "type")]
    db_type: Option<String>,
    host: String,
    port: Option<u16>,
    database: String,
    username: String,
    #[serde(rename = "passwordSecret")]
    password_secret: Option<String>,
    password: Option<String>,
    ssl: Option<bool>,
    #[serde(rename = "readOnly")]
    read_only: Option<bool>,
    scope: Option<String>,
    #[serde(rename = "connectionTimeout")]
    connection_timeout: Option<u64>,
    #[serde(rename = "queryTimeout")]
    query_timeout: Option<u64>,
}

#[derive(Deserialize)]
struct UpdateConnectionParams {
    #[serde(rename = "connectionId")]
    connection_id: String,
    name: Option<String>,
    host: Option<String>,
    port: Option<u16>,
    database: Option<String>,
    username: Option<String>,
    password: Option<String>,
    ssl: Option<bool>,
    #[serde(rename = "readOnly")]
    read_only: Option<bool>,
}

#[derive(Deserialize)]
struct ConnectionIdParam {
    #[serde(rename = "connectionId")]
    connection_id: String,
}

#[derive(Deserialize)]
struct TestConnectionParams {
    #[serde(rename = "type")]
    db_type: Option<String>,
    host: String,
    port: Option<u16>,
    database: String,
    username: String,
    password: Option<String>,
    ssl: Option<bool>,
}

#[derive(Deserialize)]
struct QueryParams {
    #[serde(rename = "connectionId")]
    connection_id: String,
    sql: String,
    params: Option<Vec<Value>>,
}

#[derive(Deserialize)]
struct TransactionParams {
    #[serde(rename = "connectionId")]
    connection_id: String,
    statements: Vec<TransactionStatement>,
}

#[derive(Deserialize)]
struct TransactionStatement {
    sql: String,
    label: Option<String>,
}

#[derive(Deserialize)]
struct SchemaParam {
    #[serde(rename = "connectionId")]
    connection_id: String,
    schema: Option<String>,
}

#[derive(Deserialize)]
struct TableParam {
    #[serde(rename = "connectionId")]
    connection_id: String,
    table: String,
    schema: Option<String>,
}

#[derive(Deserialize, Default)]
struct HistoryParams {
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Deserialize)]
struct SearchHistoryParams {
    query: String,
    limit: Option<i64>,
}

#[derive(Deserialize, Default)]
struct OptionalConnectionIdParam {
    #[serde(rename = "connectionId")]
    connection_id: Option<String>,
}

#[derive(Deserialize)]
struct FavoriteParams {
    name: String,
    sql: String,
    #[serde(rename = "connectionId")]
    connection_id: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

fn parse_params<T: for<'de> Deserialize<'de>>(params: Option<Value>) -> Result<T, ECPError> {
    match params {
        Some(v) => serde_json::from_value(v)
            .map_err(|e| ECPError::invalid_params(format!("Invalid parameters: {e}"))),
        None => Err(ECPError::invalid_params("Parameters required")),
    }
}

fn parse_params_optional<T: for<'de> Deserialize<'de> + Default>(params: Option<Value>) -> T {
    params.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Check if a SQL query is mutating (INSERT, UPDATE, DELETE, DROP, etc.)
fn is_mutating_query(sql: &str) -> bool {
    let trimmed = sql.trim().to_uppercase();
    matches!(
        trimmed.split_whitespace().next(),
        Some("INSERT" | "UPDATE" | "DELETE" | "DROP" | "ALTER" | "TRUNCATE" | "CREATE" | "GRANT" | "REVOKE")
    )
}

/// Convert tokio-postgres rows to JSON.
fn rows_to_json(rows: &[Row]) -> (Vec<Value>, Vec<Value>) {
    if rows.is_empty() {
        return (vec![], vec![]);
    }

    let columns = rows[0].columns();
    let fields: Vec<Value> = columns.iter().map(|c| {
        json!({
            "name": c.name(),
            "type": c.type_().name(),
        })
    }).collect();

    let json_rows: Vec<Value> = rows.iter().map(|row| {
        let mut obj = serde_json::Map::new();
        for (i, col) in columns.iter().enumerate() {
            let val = extract_column_value(row, i, col.type_());
            obj.insert(col.name().to_string(), val);
        }
        Value::Object(obj)
    }).collect();

    (fields, json_rows)
}

/// Extract a column value from a row as JSON, handling common PostgreSQL types.
fn extract_column_value(row: &Row, idx: usize, pg_type: &tokio_postgres::types::Type) -> Value {
    use tokio_postgres::types::Type;

    // Try common types in order of frequency
    match *pg_type {
        Type::BOOL => row.get::<_, Option<bool>>(idx).map(Value::Bool).unwrap_or(Value::Null),
        Type::INT2 => row.get::<_, Option<i16>>(idx).map(|v| json!(v)).unwrap_or(Value::Null),
        Type::INT4 => row.get::<_, Option<i32>>(idx).map(|v| json!(v)).unwrap_or(Value::Null),
        Type::INT8 => row.get::<_, Option<i64>>(idx).map(|v| json!(v)).unwrap_or(Value::Null),
        Type::FLOAT4 => row.get::<_, Option<f32>>(idx).map(|v| json!(v)).unwrap_or(Value::Null),
        Type::FLOAT8 => row.get::<_, Option<f64>>(idx).map(|v| json!(v)).unwrap_or(Value::Null),
        Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME => {
            row.get::<_, Option<String>>(idx).map(Value::String).unwrap_or(Value::Null)
        }
        Type::JSON | Type::JSONB => {
            row.get::<_, Option<Value>>(idx).unwrap_or(Value::Null)
        }
        Type::TIMESTAMP | Type::TIMESTAMPTZ => {
            row.get::<_, Option<chrono::NaiveDateTime>>(idx)
                .map(|dt| Value::String(dt.to_string()))
                .unwrap_or(Value::Null)
        }
        Type::DATE => {
            row.get::<_, Option<chrono::NaiveDate>>(idx)
                .map(|d| Value::String(d.to_string()))
                .unwrap_or(Value::Null)
        }
        Type::UUID => {
            row.get::<_, Option<uuid::Uuid>>(idx)
                .map(|u| Value::String(u.to_string()))
                .unwrap_or(Value::Null)
        }
        _ => {
            // Fallback: try as string
            row.try_get::<_, Option<String>>(idx)
                .ok()
                .flatten()
                .map(Value::String)
                .unwrap_or(Value::Null)
        }
    }
}

/// Get the ~/.ultra/ directory path.
fn dirs_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".ultra")
}
